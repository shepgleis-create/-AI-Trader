import { requireDashboardAuth } from '../lib/auth.js';
import { buildAccountRisk } from '../lib/account-risk.js';
import { getPortfolioRisk } from '../lib/risk.js';
import { fetchOptionsForUnderlying } from '../lib/multi-asset.js';

const MAX_PREMIUM_DOLLARS=100;
const MIN_QUALITY=75;
const MAX_SPREAD_PCT=0.12;

function h(key,secret,content=false){
  return {
    'APCA-API-KEY-ID':key,
    'APCA-API-SECRET-KEY':secret,
    ...(content?{'Content-Type':'application/json'}:{})
  };
}
async function jf(url,opts={}){
  const r=await fetch(url,opts);const d=await r.json().catch(()=>({}));return{r,d};
}

export default async function handler(req,res){
  if(!requireDashboardAuth(req,res))return;
  if(req.method!=='POST')return res.status(405).json({error:'Method not allowed'});

  const key=process.env.ALPACA_API_KEY,secret=process.env.ALPACA_SECRET_KEY;
  const base=process.env.ALPACA_BASE_URL||'https://paper-api.alpaca.markets';
  if(!key||!secret)return res.status(500).json({error:'Missing Alpaca credentials'});
  if(!base.includes('paper-api.alpaca.markets'))return res.status(403).json({error:'Paper-only build'});

  const underlying=String(req.body?.underlying||'').trim().toUpperCase();
  const contract=String(req.body?.contract||'').trim().toUpperCase();
  const direction=String(req.body?.direction||'BULLISH').toUpperCase()==='BEARISH'?'BEARISH':'BULLISH';
  if(!/^[A-Z.]{1,12}$/.test(underlying))return res.status(400).json({error:'Valid underlying required'});
  if(!/^[A-Z0-9.]{10,32}$/.test(contract))return res.status(400).json({error:'Valid option contract symbol required'});

  try{
    const historyUrl=new URL(`${base}/v2/account/portfolio/history`);
    historyUrl.searchParams.set('period','1M');
    historyUrl.searchParams.set('timeframe','1D');

    const [ap,cp,pp,op,rp,hp]=await Promise.all([
      jf(`${base}/v2/account`,{headers:h(key,secret)}),
      jf(`${base}/v2/clock`,{headers:h(key,secret)}),
      jf(`${base}/v2/positions`,{headers:h(key,secret)}),
      jf(`${base}/v2/orders?status=open&limit=100&nested=true`,{headers:h(key,secret)}),
      jf(`${base}/v2/orders?status=all&limit=500&direction=desc&nested=true`,{headers:h(key,secret)}),
      jf(historyUrl,{headers:h(key,secret)})
    ]);

    if(!ap.r.ok||!cp.r.ok||!pp.r.ok||!op.r.ok||!rp.r.ok){
      return res.status(502).json({error:'Could not complete options pre-trade checks'});
    }

    const account=ap.d,clock=cp.d;
    const positions=Array.isArray(pp.d)?pp.d:[];
    const openOrders=Array.isArray(op.d)?op.d:[];
    const recent=Array.isArray(rp.d)?rp.d:[];

    if(!clock.is_open)return res.status(409).json({error:'U.S. options market is closed'});
    if(account.trading_blocked||account.account_blocked)return res.status(403).json({error:'Account is blocked from trading'});
    if(Number(account.options_trading_level||0)<2){
      return res.status(409).json({
        error:'Paper account options trading level is below Level 2 (long calls/puts)',
        options_trading_level:Number(account.options_trading_level||0)
      });
    }

    if(positions.some(p=>p.symbol===contract))return res.status(409).json({error:'This option contract is already held'});
    if(openOrders.some(o=>o.symbol===contract))return res.status(409).json({error:'An order for this option contract is already open'});

    const pr=getPortfolioRisk(account,positions);
    if(pr.daily_loss_lock||pr.exposure_lock||pr.position_lock){
      return res.status(409).json({error:'Portfolio risk gate blocked the option test',portfolio_risk:pr});
    }

    const ar=buildAccountRisk({
      account,positions,openOrders,recentOrders:recent,
      portfolioHistory:hp.r.ok?hp.d:{}
    });
    if(!ar.approved)return res.status(409).json({error:'Account circuit breaker blocked the option test',account_risk:ar});

    const su=new URL(`https://data.alpaca.markets/v2/stocks/${encodeURIComponent(underlying)}/snapshot`);
    su.searchParams.set('feed','iex');
    const sp=await jf(su,{headers:h(key,secret)});
    if(!sp.r.ok)return res.status(502).json({error:sp.d?.message||'Could not refresh underlying price'});
    const snap=sp.d||{};
    const q=snap?.latestQuote||snap?.latest_quote||{};
    const t=snap?.latestTrade||snap?.latest_trade||{};
    const d=snap?.dailyBar||snap?.daily_bar||{};
    const underlyingPrice=Number(t.p||q.ap||d.c||0);
    if(!(underlyingPrice>0))return res.status(409).json({error:'No valid underlying price'});

    const chain=await fetchOptionsForUnderlying(underlying,direction,key,secret,underlyingPrice);
    if(!chain.available)return res.status(409).json({error:chain.error||'Options data unavailable'});
    const candidate=(chain.contracts||[]).find(x=>x.contract===contract);
    if(!candidate)return res.status(409).json({error:'Selected contract is no longer in the current qualified chain'});
    if(candidate.quality_score<MIN_QUALITY)return res.status(409).json({error:`Contract quality ${candidate.quality_score} is below ${MIN_QUALITY}`});
    if(candidate.spread_pct==null||candidate.spread_pct>MAX_SPREAD_PCT){
      return res.status(409).json({error:'Option spread is too wide for calibration'});
    }
    if(candidate.dte==null||candidate.dte<7||candidate.dte>45){
      return res.status(409).json({error:'Contract DTE is outside the 7-45 day calibration window'});
    }

    const ask=Number(candidate.ask||0);
    const mid=Number(candidate.mid||0);
    if(!(ask>0&&mid>0))return res.status(409).json({error:'No valid option quote'});
    const premiumCost=ask*100;
    if(premiumCost>MAX_PREMIUM_DOLLARS){
      return res.status(409).json({
        error:`One-contract premium is ${premiumCost.toFixed(2)}, above the $${MAX_PREMIUM_DOLLARS} calibration cap`,
        premium_cost:premiumCost
      });
    }
    if(Number(account.options_buying_power||account.buying_power||0)<premiumCost){
      return res.status(409).json({error:'Insufficient options buying power for one contract'});
    }

    const limit=Math.min(ask,mid*1.03).toFixed(2);
    const type=direction==='BEARISH'?'P':'C';
    const clientId=`aitr-o-${type.toLowerCase()}-${underlying.toLowerCase()}-${String(Date.now()).slice(-9)}`.slice(0,48);

    const order=await jf(`${base}/v2/orders`,{
      method:'POST',
      headers:h(key,secret,true),
      body:JSON.stringify({
        symbol:contract,
        qty:'1',
        side:'buy',
        type:'limit',
        limit_price:limit,
        time_in_force:'day',
        order_class:'simple',
        position_intent:'buy_to_open',
        client_order_id:clientId
      })
    });

    if(!order.r.ok)return res.status(order.r.status).json({error:order.d?.message||'Options paper order rejected',details:order.d});

    return res.status(200).json({
      ok:true,mode:'PAPER',
      strategy:direction==='BEARISH'?'LONG_PUT':'LONG_CALL',
      underlying,contract,direction,
      qty:1,limit_price:Number(limit),
      estimated_max_premium_dollars:Number(limit)*100,
      quality_score:candidate.quality_score,
      dte:candidate.dte,delta:candidate.delta,
      app_stop_pct:-0.35,app_target_pct:0.70,expiry_exit_dte:2,
      protection:'APP_MANAGED_MARKET_HOURS',
      order_id:order.d?.id||null,status:order.d?.status||null,client_order_id:clientId
    });
  }catch(error){
    return res.status(500).json({error:error?.message||'Options paper test failed'});
  }
}
