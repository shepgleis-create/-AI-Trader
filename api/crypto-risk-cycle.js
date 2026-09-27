import { isDashboardAuthorized } from '../lib/auth.js';

const STOP=-0.05;
const TARGET=0.10;
const MAX_HOURS=72;

function h(key,secret){return{'APCA-API-KEY-ID':key,'APCA-API-SECRET-KEY':secret}}
async function jf(url,opts={}){
  const r=await fetch(url,opts);const d=await r.json().catch(()=>({}));return{r,d};
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
    const [pp,rp]=await Promise.all([
      jf(`${base}/v2/positions`,{headers:h(key,secret)}),
      jf(`${base}/v2/orders?status=all&limit=500&direction=desc&nested=true`,{headers:h(key,secret)})
    ]);
    if(!pp.r.ok||!rp.r.ok)return res.status(502).json({error:'Could not load crypto risk state'});

    const positions=Array.isArray(pp.d)?pp.d:[];
    const orders=Array.isArray(rp.d)?rp.d:[];
    const cryptoParents=orders.filter(o=>String(o?.client_order_id||'').startsWith('aitr-c-'));
    const actions=[];

    for(const p of positions){
      const parent=cryptoParents.find(o=>o.symbol===p.symbol&&Number(o.filled_qty||0)>0);
      if(!parent)continue;

      const plpc=Number(p.unrealized_plpc||0);
      const submitted=new Date(parent.filled_at||parent.submitted_at||0).getTime();
      const ageHours=submitted>0?(Date.now()-submitted)/3600000:0;
      let reason=null;
      if(plpc<=STOP)reason='crypto_app_stop';
      else if(plpc>=TARGET)reason='crypto_app_target';
      else if(ageHours>=MAX_HOURS)reason='crypto_time_exit';
      if(!reason)continue;

      const close=await jf(`${base}/v2/positions/${encodeURIComponent(p.symbol)}`,{
        method:'DELETE',headers:h(key,secret)
      });
      actions.push({
        symbol:p.symbol,reason,plpc,age_hours:Number(ageHours.toFixed(1)),
        submitted:close.r.ok,order_id:close.d?.id||null,
        error:close.r.ok?null:close.d?.message||'Close rejected'
      });
    }

    return res.status(200).json({
      ok:true,mode:'PAPER',monitored:cryptoParents.length,
      stop_pct:STOP,target_pct:TARGET,max_hold_hours:MAX_HOURS,actions
    });
  }catch(error){
    return res.status(500).json({error:error?.message||'Crypto risk cycle failed'});
  }
}
