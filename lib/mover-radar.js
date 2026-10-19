import pg from 'pg';
import {getDatabaseUrl} from './database-url.js';
import {momentSignal} from './mover-research.js';
const {Pool}=pg;
let sharedPool=null,initPromise=null;
function db(){
  const url=getDatabaseUrl();
  if(!url)return null;
  if(!sharedPool)sharedPool=new Pool({connectionString:url,max:2,
    connectionTimeoutMillis:4500,idleTimeoutMillis:10000});
  return sharedPool;
}
async function ensure(){
  const pool=db();if(!pool)throw Error('Mover research requires Neon');
  if(!initPromise)initPromise=pool.query(`
    CREATE TABLE IF NOT EXISTS market_mover_observations(
      market TEXT NOT NULL,
      symbol TEXT NOT NULL,
      bucket TEXT NOT NULL,
      observed_at TIMESTAMPTZ NOT NULL,
      day_pct DOUBLE PRECISION NOT NULL,
      price DOUBLE PRECISION NOT NULL,
      source TEXT NOT NULL,
      signal TEXT,
      delta_pct_points DOUBLE PRECISION,
      PRIMARY KEY(market,symbol,bucket)
    )
  `).catch(e=>{initPromise=null;throw e});
  await initPromise;
  return pool;
}
export async function recordMoverObservations(market,items=[],now=new Date()){
  if(!['stocks','crypto'].includes(market))throw Error('Invalid market');
  const pool=await ensure();
  const observed_at=now.toISOString();
  const bucket=String(Math.floor(now.getTime()/900000));
  const last=await pool.query(`
    SELECT DISTINCT ON(symbol) symbol,day_pct,observed_at FROM market_mover_observations
    WHERE market=$1 AND observed_at>NOW()-INTERVAL '70 minutes'
    ORDER BY symbol,observed_at DESC LIMIT 150
  `,[market]);
  const previous=new Map(last.rows.map(x=>[x.symbol,x]));
  const all=[],alerts=[];
  for(const item of items.slice(0,90)){
    const symbol=String(item.symbol||'').toUpperCase();
    const price=Number(item.price),day_pct=Number(item.day_pct);
    if(!/^[A-Z0-9.\/\-]{1,22}$/.test(symbol)||!(price>0)||!Number.isFinite(day_pct))continue;
    const current={symbol,asset_class:market==='stocks'?'stock':'crypto',day_pct,observed_at};
    const earlier=previous.get(symbol);
    const signal=momentSignal(earlier?{...earlier,
      symbol,asset_class:current.asset_class}:null,current);
    if(signal)alerts.push({symbol,market,day_pct,previous_day_pct:earlier.day_pct,
      signal_type:signal.type,delta_pct_points:signal.delta_pct_points,
      minutes:signal.minutes,observed_at});
    all.push({...current,market,bucket,price,source:String(item.provider||'UNKNOWN'),
      signal:signal?.type||null,delta_pct_points:signal?.delta_pct_points??null});
  }
  if(all.length){
    await pool.query(`
      INSERT INTO market_mover_observations(
        market,symbol,bucket,observed_at,day_pct,price,source,signal,delta_pct_points
      )
      SELECT x.market,x.symbol,x.bucket,x.observed_at::timestamptz,
        x.day_pct,x.price,x.source,x.signal,x.delta_pct_points
      FROM jsonb_to_recordset($1::jsonb) AS x(
        market text,symbol text,bucket text,observed_at text,
        day_pct double precision,price double precision,source text,
        signal text,delta_pct_points double precision
      )
      ON CONFLICT(market,symbol,bucket) DO NOTHING
    `,[JSON.stringify(all)]);
  }
  return {recorded:all.length,alerts,market,observed_at};
}
export async function readMoverAlerts(limit=50){
  const pool=await ensure();
  const r=await pool.query(`
    SELECT market,symbol,observed_at,price,day_pct,source,
      signal AS signal_type,delta_pct_points
    FROM market_mover_observations
    WHERE signal IS NOT NULL AND observed_at>NOW()-INTERVAL '14 days'
    ORDER BY observed_at DESC LIMIT $1
  `,[Math.max(1,Math.min(100,Number(limit)||50))]);
  return r.rows;
}
