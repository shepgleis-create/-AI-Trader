import pg from 'pg';

const { Pool } = pg;
let sharedPool;
let schemaPromise;
const WINDOWS = Object.freeze({
  'auto-cycle':15,
  'crypto-risk-cycle':15,
  'options-risk-cycle':15,
  'outcome-cycle':60,
  'shadow-router-cycle':15,
  'multi-asset-outcome-cycle':60
});

function connectionString(){
  return String(process.env.DATABASE_URL||process.env.POSTGRES_URL||process.env.POSTGRES_PRISMA_URL||process.env.NEON_DATABASE_URL||'').trim();
}
function pool(){
  if(!connectionString())return null;
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
  if(!db)return {ok:false,reason:'Database is not configured; safe cron deduplication is unavailable'};
  try{
    await ensure();
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
    const detail=String(body?.error||body?.reason||'').slice(0,350);
    const status=code>=400||body?.error?'ERROR':'COMPLETED';
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
    if(!isCron)return handler(req,res);
    const key=cronSlot(job);
    const lock=await claim(job,key);
    if(!lock.ok){
      if(lock.reason==='already_ran_this_window'){
        return res.status(200).json({ok:true,action:'duplicate_suppressed',job,run_key:key});
      }
      return res.status(503).json({ok:false,error:lock.reason,job,action:'entry_locked'});
    }
    const started=Date.now();
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
      await finish(job,key,started,code,body);
    }
  };
}
export async function recentCronRuns(limit=120){
  if(!pool())return {configured:false,rows:[],error:'Database connection variable missing'};
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
