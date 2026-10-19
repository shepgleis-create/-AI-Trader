import {withCronTelemetry} from '../lib/cron-telemetry.js';
import {isDashboardAuthorized} from '../lib/auth.js';
import {providerMovers} from '../lib/mover-data.js';
import {recordMoverObservations} from '../lib/mover-radar.js';

// Independent research only: never submits orders and cannot bypass entry risk.
// Keeps observing leaders after a daily stock-entry limit is reached.
async function handler(req,res){
  if(req.method!=='GET')return res.status(405).json({error:'Method not allowed'});
  const cron=Boolean(process.env.CRON_SECRET)&&req.headers.authorization==='Bearer '+process.env.CRON_SECRET;
  if(!cron&&!isDashboardAuthorized(req))return res.status(401).json({error:'Unauthorized'});
  const key=process.env.ALPACA_API_KEY,secret=process.env.ALPACA_SECRET_KEY;
  if(!key||!secret)return res.status(503).json({error:'Paper market-data credentials missing'});
  const now=new Date();
  const day=now.getUTCDay(),hour=now.getUTCHours();
  const duringEquities=day>=1&&day<=5&&hour>=13&&hour<=21;
  const markets=duringEquities?['stocks','crypto']:['crypto'];
  const results=[],warnings=[];
  for(const market of markets){
    try{
      // Keep cron cheap. The user-facing screen can use a slower IEX fallback
      // when a consolidated SIP stock screener is not available.
      const provider=await providerMovers(market,key,secret);
      if(!provider.ok){warnings.push({market,reason:provider.reason,status:provider.status});continue}
      const saved=await recordMoverObservations(market,provider.items,now);
      results.push({market,source:provider.source,
        observed:saved.recorded,acceleration_watches:saved.alerts.slice(0,12)});
    }catch(e){warnings.push({market,reason:String(e?.message||'Observation failed').slice(0,160)})}
  }
  if(!results.length)return res.status(502).json({
    error:'No mover providers available for scheduled observations',warnings
  });
  return res.status(200).json({ok:true,mode:'PAPER_RESEARCH',
    action:'mover_research_observed',market_hours_stock_observation:duringEquities,
    results,warnings,
    note:'Momentum alerts are research watch signals, never automatic buy instructions.'});
}
export default withCronTelemetry('mover-radar-cycle',handler);
