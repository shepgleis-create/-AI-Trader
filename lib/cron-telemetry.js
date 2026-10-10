import pg from 'pg';
import { isDashboardAuthorized } from './auth.js';
import { getDatabaseUrl, selectDatabaseUrl } from './database-url.js';

const { Pool } = pg;
let sharedPool;
let schemaPromise;
const WINDOWS = Object.freeze({
  'auto-cycle':15,
  'crypto-risk-cycle':15,
  'options-risk-cycle':15,
  'outcome-cycle':60,
  'shadow-router-cycle':15,
  'multi-asset-outcome-cycle':60,
  'research-cycle':30,
  'forward-grade-cycle':1440
});

function connectionString(){
  return getDatabaseUrl();
}
export function cronDatabaseConfig(){
  const selected=selectDatabaseUrl();
  return {configured:selected.configured,valid:selected.valid,error:selected.error,source_key:selected.key};
}
function pool(){
  if(!cronDatabaseConfig().valid)return null;
  if(!sharedPool){
    const url=new URL(connectionString());
    const channelBinding=String(url.searchParams.get('channel_binding')||'').toLowerCase();
    if(channelBinding)url.searchParams.delete('channel_binding');
    sharedPool=new Pool({
      connectionString:url.toString(),
      enableChannelBinding:channelBinding==='require'||channelBinding==='prefer',
      max:2,connectionTimeoutMillis:4500,idleTimeoutMillis:10000
    });
    sharedPool.on('error',()=>{});
  }
  return sharedPool;
}
async function ensure(){
  const db=pool();
  if(!db)return false;
  if(!schemaPromise){
    schemaPromise=db.query(String.raw`
      CREATE TABLE IF NOT EXISTS ai_trader_cron_runs(
        job TEXT NOT NULL,
        run_key TEXT NOT NULL,
        started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        finished_at TIMESTAMPTZ,
        status TEXT NOT NULL DEFAULT 'RUNNING',
        response_code INTEGER,
        duration_ms INTEGER,
        action TEXT,
        detail TEXT,
        PRIMARY KEY(job,run_key)
      )
    `).then(()=>true).catch(e=>{schemaPromise=null;throw e});
  }
  return schemaPromise;
}
export function cronSlot(job,date=new Date()){
  const width=WINDOWS[job]||15;
  const ms=width*60000;
  return String(Math.floor(new Date(date).getTime()/ms));
}
export function scheduledJobs(){
  return Object.keys(WINDOWS);
}
async function claim(job,key){
  const db=pool();
  if(!db)return {ok:false,reason:cronDatabaseConfig().error||'Safe cron deduplication is unavailable'};
  try{
    await ensure();
    // Serverless timeouts cannot reach finish(); repair old RUNNING records on the next invocation.
    await db.query(String.raw`
      UPDATE ai_trader_cron_runs
      SET status='TIMEOUT',finished_at=NOW(),action=COALESCE(action,'worker_timeout'),
          detail=COALESCE(NULLIF(detail,''),'Worker did not complete; likely function deadline or crash')
      WHERE job=$1 AND status='RUNNING' AND started_at<NOW()-INTERVAL '3 minutes'
    `,[job]);
    const r=await db.query(String.raw`
      INSERT INTO ai_trader_cron_runs(job,run_key)
      VALUES($1,$2)
      ON CONFLICT(job,run_key) DO UPDATE SET
        started_at=NOW(),finished_at=NULL,status='RUNNING',
        response_code=NULL,duration_ms=NULL,action=NULL,detail=NULL
      WHERE ai_trader_cron_runs.started_at < NOW() - INTERVAL '5 minutes'
      RETURNING run_key
    `,[job,key]);
    return {ok:r.rowCount===1,reason:r.rowCount===1?'claimed':'already_ran_this_window'};
  }catch(e){
    return {ok:false,reason:'Cron database lock unavailable',unavailable:true};
  }
}
async function finish(job,key,started,code,body){
  try{
    const action=Array.isArray(body?.actions)
      ? body.actions.map(x=>String(x?.type||'unknown')).slice(0,8).join(',')
      : String(body?.action||body?.reason||body?.stage||'completed').slice(0,160);
    const actionRows=Array.isArray(body?.actions)?body.actions:[];
    const critical=new Set(['entry','crypto_entry','exit','end_of_day_flatten','profit_protection','stale_entry_cancel','stale_crypto_entry_cancel']);
    const failures=actionRows.filter(x=>critical.has(String(x?.type||''))&&
      (x?.submitted===false||String(x?.status||'').toLowerCase()==='rejected'));
    const actionReasons=actionRows.map(x=>[x?.type,x?.reason||x?.error].filter(Boolean).join(': ')).filter(Boolean).join(' | ');
    const failureReason=failures.map(x=>[x.type,x.error||x.status||'broker rejected operation'].join(': ')).join(' | ');
    const detail=String(body?.error||body?.reason||failureReason||actionReasons||'').slice(0,350);
    const status=code>=400||body?.error||failures.length?'ERROR':'COMPLETED';
    await pool().query(String.raw`
      UPDATE ai_trader_cron_runs
      SET finished_at=NOW(),status=$3,response_code=$4,
          duration_ms=$5,action=$6,detail=$7
      WHERE job=$1 AND run_key=$2
    `,[job,key,status,code,Math.max(0,Date.now()-started),action,detail]);
  }catch(e){
    console.error('cron_audit_save_failed',job,String(e?.message||'unknown').slice(0,120));
  }
}
export function withCronTelemetry(job,handler){
  return async function cronHandler(req,res){
    const secret=String(process.env.CRON_SECRET||'');
    const isCron=Boolean(secret)&&req.headers?.authorization===('Bearer '+secret);
    const canSubmitEntry=job==='auto-cycle'||job==='crypto-risk-cycle';
    // Dashboard-triggered entry cycles must obey the exact same durable lease
    // as scheduled calls. Otherwise manual retries bypass idempotency.
    const fromDashboard=canSubmitEntry&&!isCron&&isDashboardAuthorized(req);
    if(!isCron&&!fromDashboard)return handler(req,res);
    const key=cronSlot(job);
    const lock=await claim(job,key);
    if(!lock.ok){
      if(lock.reason==='already_ran_this_window'){
        return res.status(200).json({ok:true,action:'duplicate_suppressed',job,run_key:key});
      }
      // Keep risk exits available during a Neon outage, but never submit
      // new automated entries without a durable idempotency lease.
      req.cronAuditLockUnavailable=true;
      if(job==='auto-cycle'||job==='crypto-risk-cycle'||job==='options-risk-cycle'){
        console.error('cron_lock_unavailable_exits_only',job,lock.reason);
        return handler(req,res);
      }
      // Research-only cron workers never submit orders: continue without a DB lease.
      if(['shadow-router-cycle','outcome-cycle','multi-asset-outcome-cycle','research-cycle','forward-grade-cycle'].includes(job)){
        console.warn('cron_research_unpersisted',job,lock.reason);
        return handler(req,res);
      }
      return res.status(503).json({ok:false,error:lock.reason,job,action:'entry_locked'});
    }
    const started=Date.now();
    console.info('cron_claimed',job,key);
    let body=null;
    let code=200;
    const originalJson=res.json.bind(res);
    res.json=(payload)=>{body=payload;code=res.statusCode||200;return originalJson(payload);};
    try{
      return await handler(req,res);
    }catch(e){
      const message=String(e?.message||'Unhandled cron exception').slice(0,250);
      body={error:message};
      code=500;
      if(!res.headersSent)return res.status(500).json({error:'Automated cycle failed'});
      throw e;
    }finally{
      console.info('cron_completed',job,code,Math.max(0,Date.now()-started),'ms');
      await finish(job,key,started,code,body);
    }
  };
}
export async function recentCronRuns(limit=120){
  if(!pool())return {configured:cronDatabaseConfig().configured,rows:[],error:cronDatabaseConfig().error};
  try{
    await ensure();
    const r=await pool().query(String.raw`
      SELECT job,run_key,started_at,finished_at,status,response_code,duration_ms,action,detail
      FROM ai_trader_cron_runs
      ORDER BY started_at DESC LIMIT $1
    `,[Math.min(200,Math.max(1,Number(limit)||120))]);
    return {configured:true,rows:r.rows};
  }catch(e){
    return {configured:true,rows:[],error:'Cron audit database is unavailable'};
  }
}
