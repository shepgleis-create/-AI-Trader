import { requireDashboardAuth } from '../lib/auth.js';
import { buildAccountRisk } from '../lib/account-risk.js';
import { getPortfolioRisk } from '../lib/risk.js';
import { fetchCryptoScan } from '../lib/multi-asset.js';

const NOTIONAL=25;

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

  const symbol=String(req.body?.symbol||'').trim().toUpperCase();
  if(!/^[A-Z0-9]+\/[A-Z0-9]+$/.test(symbol))return res.status(400).json({error:'Valid crypto pair required'});

  try{
    const historyUrl=new URL(`${base}/v2/account/portfolio/history`);
    historyUrl.searchParams.set('period','1M');
    historyUrl.searchParams.set('timeframe','1D');

    const [ap,pp,op,rp,hp,assetp]=await Promise.all([
      jf(`${base}/v2/account`,{headers:h(key,secret)}),
      jf(`${base}/v2/positions`,{headers:h(key,secret)}),
      jf(`${base}/v2/orders?status=open&limit=100&nested=true`,{headers:h(key,secret)}),
      jf(`${base}/v2/orders?status=all&limit=500&direction=desc&nested=true`,{headers:h(key,secret)}),
      jf(historyUrl,{headers:h(key,secret)}),
      jf(`${base}/v2/assets/${encodeURIComponent(symbol)}`,{headers:h(key,secret)})
    ]);

    if(!ap.r.ok)return res.status(502).json({error:ap.d?.message||'Account check failed'});
    if(!pp.r.ok||!op.r.ok||!rp.r.ok)return res.status(502).json({error:'Could not complete crypto risk checks'});
    if(!assetp.r.ok)return res.status(409).json({error:assetp.d?.message||'Crypto asset unavailable'});

    const account=ap.d;
    const positions=Array.isArray(pp.d)?pp.d:[];
    const orders=Array.isArray(op.d)?op.d:[];
    const recent=Array.isArray(rp.d)?rp.d:[];

    if(account.trading_blocked||account.account_blocked)return res.status(403).json({error:'Account is blocked from trading'});
    if(assetp.d?.class!=='crypto'||assetp.d?.tradable!==true)return res.status(409).json({error:`${symbol} is not a tradable Alpaca crypto pair`});
    if(positions.some(p=>p.symbol===symbol))return res.status(409).json({error:`A position in ${symbol} already exists`});
    if(orders.some(o=>o.symbol===symbol))return res.status(409).json({error:`An open order for ${symbol} already exists`});

    const pr=getPortfolioRisk(account,positions);
    if(pr.daily_loss_lock||pr.exposure_lock||pr.position_lock){
      return res.status(409).json({error:'Portfolio risk gate blocked the crypto test',portfolio_risk:pr});
    }

    const ar=buildAccountRisk({
      account,positions,openOrders:orders,recentOrders:recent,
      portfolioHistory:hp.r.ok?hp.d:{}
    });
    if(!ar.approved)return res.status(409).json({error:'Account circuit breaker blocked the crypto test',account_risk:ar});

    const scan=await fetchCryptoScan(key,secret);
    const candidate=(scan.candidates||[]).find(x=>x.symbol===symbol);
    if(!candidate)return res.status(409).json({error:'Pair is not in the current deeply analyzed crypto set'});
    if(candidate.score<75)return res.status(409).json({error:`Crypto score ${candidate.score} is below the 75 calibration floor`});
    if(candidate.pump_dump_risk==='HIGH')return res.status(409).json({error:'High pump/dump-risk crypto is blocked from entry'});
    if(candidate.spread_pct==null||candidate.spread_pct>0.008){
      return res.status(409).json({error:'Crypto spread exceeds the 0.80% calibration limit'});
    }

    const u=new URL('https://data.alpaca.markets/v1beta3/crypto/us/snapshots');
    u.searchParams.set('symbols',symbol);
    const sp=await jf(u,{headers:h(key,secret)});
    if(!sp.r.ok)return res.status(502).json({error:sp.d?.message||'Could not refresh crypto quote'});
    const s=sp.d?.snapshots?.[symbol]||sp.d?.[symbol]||{};
    const q=s?.latestQuote||s?.latest_quote||{};
    const t=s?.latestTrade||s?.latest_trade||{};
    const ask=Number(q.ap||0),last=Number(t.p||0),px=ask>0?ask:last;
    if(!(px>0))return res.status(409).json({error:'No valid crypto execution price'});

    const limit=(px*1.002).toFixed(px<1?6:px<100?4:2);
    const clientId=`aitr-c-${symbol.replace('/','').toLowerCase()}-${String(Date.now()).slice(-9)}`.slice(0,48);

    const order=await jf(`${base}/v2/orders`,{
      method:'POST',
      headers:h(key,secret,true),
      body:JSON.stringify({
        symbol,
        notional:String(NOTIONAL),
        side:'buy',
        type:'limit',
        limit_price:limit,
        time_in_force:'gtc',
        order_class:'simple',
        client_order_id:clientId
      })
    });

    if(!order.r.ok)return res.status(order.r.status).json({error:order.d?.message||'Crypto paper order rejected',details:order.d});

    return res.status(200).json({
      ok:true,mode:'PAPER',strategy:'CRYPTO_LONG',
      symbol,notional:NOTIONAL,reference_price:px,limit_price:Number(limit),
      app_stop_pct:-0.05,app_target_pct:0.10,max_hold_hours:72,
      pump_dump_risk:candidate.pump_dump_risk,score:candidate.score,
      order_id:order.d?.id||null,status:order.d?.status||null,client_order_id:clientId,
      protection:'APP_MANAGED_24_7'
    });
  }catch(error){
    return res.status(500).json({error:error?.message||'Crypto paper test failed'});
  }
}
