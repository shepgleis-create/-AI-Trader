import { requireDashboardAuth } from '../lib/auth.js';
import { buildAccountRisk } from '../lib/account-risk.js';
import { getPortfolioRisk } from '../lib/risk.js';

const MAX_SHORT_ENTRY_DOLLARS=100;
const STOP_PCT=0.04;
const TARGET_PCT=0.08;
const ENTRY_CUSHION_PCT=0.001;

function roundPrice(n){return Number(n).toFixed(2)}
function headers(key,secret){
  return {
    'APCA-API-KEY-ID':key,
    'APCA-API-SECRET-KEY':secret,
    'Content-Type':'application/json'
  };
}

async function jsonFetch(url,opts={}){
  const r=await fetch(url,opts);
  const d=await r.json().catch(()=>({}));
  return {r,d};
}

export default async function handler(req,res){
  if(!requireDashboardAuth(req,res))return;
  if(req.method!=='POST')return res.status(405).json({error:'Method not allowed'});

  const key=process.env.ALPACA_API_KEY;
  const secret=process.env.ALPACA_SECRET_KEY;
  const base=process.env.ALPACA_BASE_URL||'https://paper-api.alpaca.markets';
  if(!key||!secret)return res.status(500).json({error:'Missing Alpaca credentials'});
  if(!base.includes('paper-api.alpaca.markets'))return res.status(403).json({error:'Paper-only build'});

  const symbol=String(req.body?.symbol||'').trim().toUpperCase();
  if(!/^[A-Z.]{1,12}$/.test(symbol))return res.status(400).json({error:'Valid symbol required'});

  const h=headers(key,secret);

  try{
    const historyUrl=new URL(`${base}/v2/account/portfolio/history`);
    historyUrl.searchParams.set('period','1M');
    historyUrl.searchParams.set('timeframe','1D');

    const [
      accountPack,clockPack,positionsPack,ordersPack,recentPack,historyPack,assetPack
    ]=await Promise.all([
      jsonFetch(`${base}/v2/account`,{headers:h}),
      jsonFetch(`${base}/v2/clock`,{headers:h}),
      jsonFetch(`${base}/v2/positions`,{headers:h}),
      jsonFetch(`${base}/v2/orders?status=open&limit=100&nested=true`,{headers:h}),
      jsonFetch(`${base}/v2/orders?status=all&limit=500&direction=desc&nested=true`,{headers:h}),
      jsonFetch(historyUrl,{headers:h}),
      jsonFetch(`${base}/v2/assets/${encodeURIComponent(symbol)}`,{headers:h})
    ]);

    for(const [name,p] of Object.entries({
      account:accountPack,clock:clockPack,positions:positionsPack,
      open_orders:ordersPack,recent_orders:recentPack,asset:assetPack
    })){
      if(!p.r.ok)return res.status(502).json({
        error:`Alpaca ${name} check failed — HTTP ${p.r.status}: ${String(p.d?.message||p.r.statusText||'request failed').slice(0,180)}`
      });
    }

    const account=accountPack.d;
    const clock=clockPack.d;
    const positions=Array.isArray(positionsPack.d)?positionsPack.d:[];
    const openOrders=Array.isArray(ordersPack.d)?ordersPack.d:[];
    const recentOrders=Array.isArray(recentPack.d)?recentPack.d:[];
    const asset=assetPack.d;

    if(!clock.is_open)return res.status(409).json({error:'U.S. equity market is closed'});
    if(account.trading_blocked||account.account_blocked)return res.status(403).json({error:'Account is blocked from trading'});
    if(Number(account.equity||0)<2000)return res.status(409).json({error:'Short selling requires at least $2,000 account equity'});
    if(asset.tradable!==true||asset.shortable!==true){
      return res.status(409).json({error:`${symbol} is not currently shortable`});
    }

    const borrowStatus=String(asset.borrow_status||'').toLowerCase();
    if(borrowStatus!=='easy_to_borrow'){
      return res.status(409).json({
        error:`${symbol} is not easy-to-borrow right now`,
        borrow_status:borrowStatus||'unknown',
        note:'The paper short lane does not attempt HTB locate requests.'
      });
    }

    if(positions.some(p=>p.symbol===symbol)){
      return res.status(409).json({error:`A position in ${symbol} already exists`});
    }
    if(openOrders.some(o=>o.symbol===symbol)){
      return res.status(409).json({error:`An open order for ${symbol} already exists`});
    }

    const portfolioRisk=getPortfolioRisk(account,positions);
    if(portfolioRisk.daily_loss_lock||portfolioRisk.exposure_lock||portfolioRisk.position_lock){
      return res.status(409).json({error:'Portfolio risk gate blocked the short test',portfolio_risk:portfolioRisk});
    }

    const accountRisk=buildAccountRisk({
      account,
      positions,
      openOrders,
      recentOrders,
      portfolioHistory:historyPack.r.ok?historyPack.d:{}
    });
    if(!accountRisk.approved){
      return res.status(409).json({error:'Account circuit breaker blocked the short test',account_risk:accountRisk});
    }

    const u=new URL(`https://data.alpaca.markets/v2/stocks/${encodeURIComponent(symbol)}/snapshot`);
    u.searchParams.set('feed','iex');
    const snapPack=await jsonFetch(u,{headers:{
      'APCA-API-KEY-ID':key,
      'APCA-API-SECRET-KEY':secret
    }});
    if(!snapPack.r.ok)return res.status(502).json({error:snapPack.d?.message||'Could not load execution quote'});

    const snap=snapPack.d;
    const q=snap?.latestQuote||snap?.latest_quote||{};
    const t=snap?.latestTrade||snap?.latest_trade||{};
    const d=snap?.dailyBar||snap?.daily_bar||{};
    const bid=Number(q.bp||0),ask=Number(q.ap||0);
    const last=Number(t.p||d.c||0);
    const mid=bid>0&&ask>0?(bid+ask)/2:0;
    const spread=mid>0&&ask>=bid?(ask-bid)/mid:null;
    const px=bid>0?bid:last;

    if(!(px>0))return res.status(409).json({error:'No valid short execution price'});
    if(spread==null||spread>0.005){
      return res.status(409).json({error:'Bid/ask spread is too wide for short calibration',spread_pct:spread});
    }
    if(px>MAX_SHORT_ENTRY_DOLLARS){
      return res.status(409).json({
        error:`Whole-share short calibration cap is $${MAX_SHORT_ENTRY_DOLLARS}; ${symbol} is currently above it`,
        price:px
      });
    }

    const qty=1;
    const entryLimit=roundPrice(px*(1-ENTRY_CUSHION_PCT));
    const stopPrice=roundPrice(px*(1+STOP_PCT));
    const takeProfit=roundPrice(px*(1-TARGET_PCT));
    const clientId=`aitr-s-${symbol.toLowerCase()}-p${Math.round(px*100)}-${String(Date.now()).slice(-8)}`.slice(0,48);

    const orderPack=await jsonFetch(`${base}/v2/orders`,{
      method:'POST',
      headers:h,
      body:JSON.stringify({
        symbol,
        qty:String(qty),
        side:'sell',
        type:'limit',
        limit_price:entryLimit,
        time_in_force:'day',
        order_class:'bracket',
        take_profit:{limit_price:takeProfit},
        stop_loss:{stop_price:stopPrice},
        client_order_id:clientId
      })
    });

    if(!orderPack.r.ok){
      return res.status(orderPack.r.status).json({
        error:orderPack.d?.message||'Paper short order rejected',
        details:orderPack.d
      });
    }

    return res.status(200).json({
      ok:true,
      mode:'PAPER',
      strategy:'EQUITY_SHORT',
      symbol,
      borrow_status:borrowStatus,
      qty,
      reference_price:px,
      entry_limit_price:Number(entryLimit),
      stop_price:Number(stopPrice),
      take_profit_price:Number(takeProfit),
      max_short_entry_dollars:MAX_SHORT_ENTRY_DOLLARS,
      order_id:orderPack.d?.id||null,
      status:orderPack.d?.status||null,
      client_order_id:clientId
    });
  }catch(error){
    return res.status(500).json({error:error?.message||'Paper short test failed'});
  }
}
