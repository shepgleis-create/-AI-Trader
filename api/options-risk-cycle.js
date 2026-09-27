import { isDashboardAuthorized } from '../lib/auth.js';

const STOP=-0.35;
const TARGET=0.70;
const EXPIRY_EXIT_DTE=2;

function h(key,secret){return{'APCA-API-KEY-ID':key,'APCA-API-SECRET-KEY':secret}}
async function jf(url,opts={}){
  const r=await fetch(url,opts);const d=await r.json().catch(()=>({}));return{r,d};
}
function expiryFromOcc(symbol){
  const m=String(symbol||'').match(/^[A-Z.]+(\d{6})[CP]\d{8}$/);
  if(!m)return null;
  const s=m[1];
  return new Date(`20${s.slice(0,2)}-${s.slice(2,4)}-${s.slice(4,6)}T20:00:00Z`);
}

export default async function handler(req,res){
  if(req.method!=='GET')return res.status(405).json({error:'Method not allowed'});
  const cronSecret=process.env.CRON_SECRET;
  const ok=(cronSecret&&req.headers.authorization===`Bearer ${cronSecret}`)||isDashboardAuthorized(req);
  if(!ok)return res.status(401).json({error:'Unauthorized'});

  const key=process.env.ALPACA_API_KEY,secret=process.env.ALPACA_SECRET_KEY;
  const base=process.env.ALPACA_BASE_URL||'https://paper-api.alpaca.markets';
  if(!key||!secret)return res.status(500).json({error:'Missing Alpaca credentials'});
  if(!base.includes('paper-api.alpaca.markets'))return res.status(403).json({error:'Paper-only build'});

  try{
    const [clockp,pp,rp]=await Promise.all([
      jf(`${base}/v2/clock`,{headers:h(key,secret)}),
      jf(`${base}/v2/positions`,{headers:h(key,secret)}),
      jf(`${base}/v2/orders?status=all&limit=500&direction=desc&nested=true`,{headers:h(key,secret)})
    ]);
    if(!clockp.r.ok||!pp.r.ok||!rp.r.ok)return res.status(502).json({error:'Could not load options risk state'});
    if(!clockp.d?.is_open)return res.status(200).json({ok:true,mode:'PAPER',market_open:false,actions:[]});

    const positions=Array.isArray(pp.d)?pp.d:[];
    const orders=Array.isArray(rp.d)?rp.d:[];
    const parents=orders.filter(o=>String(o?.client_order_id||'').startsWith('aitr-o-'));
    const actions=[];

    for(const p of positions){
      const parent=parents.find(o=>o.symbol===p.symbol&&Number(o.filled_qty||0)>0);
      if(!parent)continue;

      const plpc=Number(p.unrealized_plpc||0);
      const expiry=expiryFromOcc(p.symbol);
      const dte=expiry?Math.max(0,Math.ceil((expiry-Date.now())/86400000)):null;
      let reason=null;
      if(plpc<=STOP)reason='option_premium_stop';
      else if(plpc>=TARGET)reason='option_premium_target';
      else if(dte!=null&&dte<=EXPIRY_EXIT_DTE)reason='option_expiry_exit';
      if(!reason)continue;

      const close=await jf(`${base}/v2/positions/${encodeURIComponent(p.symbol)}`,{
        method:'DELETE',headers:h(key,secret)
      });
      actions.push({
        symbol:p.symbol,reason,plpc,dte,
        submitted:close.r.ok,order_id:close.d?.id||null,
        error:close.r.ok?null:close.d?.message||'Close rejected'
      });
    }

    return res.status(200).json({
      ok:true,mode:'PAPER',market_open:true,
      monitored:parents.length,stop_pct:STOP,target_pct:TARGET,
      expiry_exit_dte:EXPIRY_EXIT_DTE,actions
    });
  }catch(error){
    return res.status(500).json({error:error?.message||'Options risk cycle failed'});
  }
}
