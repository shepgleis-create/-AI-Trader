import { requireDashboardAuth } from '../lib/auth.js';
import { recentCronRuns, scheduledJobs, cronDatabaseConfig } from '../lib/cron-telemetry.js';

const SCHEDULES={
  'auto-cycle':{kind:'weekday',minutes:15},
  'crypto-risk-cycle':{kind:'continuous',minutes:15},
  'options-risk-cycle':{kind:'weekday',minutes:15},
  'outcome-cycle':{kind:'weekday_daily',minutes:1440},
  'shadow-router-cycle':{kind:'weekday_sparse',minutes:120},
  'multi-asset-outcome-cycle':{kind:'weekday',minutes:60}
};

function expectedNow(job,now){
  const day=now.getUTCDay(),hour=now.getUTCHours(),minute=now.getUTCMinutes();
  if(job==='crypto-risk-cycle')return true;
  if(day===0||day===6)return false;
  if(job==='outcome-cycle')return hour===22 && minute>=15;
  if(job==='shadow-router-cycle')return hour>=15&&hour<=20;
  return hour>=13&&hour<=22;
}
function evaluate(job,rows,now){
  const settings=SCHEDULES[job];
  const recent=rows.find(r=>r.job===job)||null;
  const relevant=rows.filter(r=>r.job===job);
  const active=expectedNow(job,now);
  const age=recent?Math.max(0,(now-new Date(recent.started_at))/60000):null;
  const threshold=job==='crypto-risk-cycle'?50:job==='outcome-cycle'?1800:job==='shadow-router-cycle'?195:settings.minutes===60?150:90;
  const failureCount=relevant.filter(r=>r.status==='ERROR').length;
  const state=recent?.status==='RUNNING'&&age>5?'STALLED':
    active&&age!=null&&age>threshold?'STALE':
    active&&!recent?'NO_RUN_RECORDED':
    recent?.status==='ERROR'?'LAST_RUN_FAILED':
    active?'RECENT':'OFF_HOURS';
  return {
    job,expected_cadence_minutes:settings.minutes,
    expected_now:active,state,last_started_at:recent?.started_at||null,
    last_finished_at:recent?.finished_at||null,
    age_minutes:age==null?null:Math.round(age),
    last_status:recent?.status||null,
    last_http_status:recent?.response_code||null,
    last_action:recent?.action||null,
    last_error:recent?.status==='ERROR'?recent.detail:null,
    recent_failures:failureCount,
    recent_runs:relevant.length
  };
}
export default async function handler(req,res){
  if(!requireDashboardAuth(req,res))return;
  if(req.method!=='GET')return res.status(405).json({error:'Method not allowed'});
  res.setHeader('Cache-Control','no-store');
  const config=cronDatabaseConfig();
  let data;
  try{data=await recentCronRuns();}
  catch(error){data={configured:config.configured,rows:[],error:'Job audit backend unavailable. Check Neon DATABASE_URL in Vercel Production.'}}
  const now=new Date();
  const jobs=scheduledJobs().map(job=>evaluate(job,data.rows,now));
  return res.status(200).json({
    generated_at:now.toISOString(),
    mode:'PAPER',
    automatic_entries_enabled:String(process.env.AUTO_TRADING_ENABLED||'').toLowerCase()==='true',
    storage_connected:data.configured&&!data.error,
    database_config_valid:config.valid,
    database_setup_action:!config.valid?'Replace DATABASE_URL in Vercel Production with the real Neon pooled connection string, then redeploy.':null,
    storage_issue:data.error||null,
    jobs,
    recent_runs:data.rows.slice(0,40),
    note:'Only authenticated scheduled calls are counted. Missing audit data is unknown, not proof that Vercel never invoked the job.'
  });
}
