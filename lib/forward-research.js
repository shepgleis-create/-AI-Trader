// Forward research observations are append-only, not order instructions.
import pg from 'pg';
import {getDatabaseUrl} from './database-url.js';
let pool;
function db(){if(!pool){const url=getDatabaseUrl();if(!url)throw new Error('Decision Memory database unavailable');pool=new pg.Pool({connectionString:url,max:2,connectionTimeoutMillis:6000});pool.on('error',()=>{});}return pool}
export async function saveForwardResearch(rows=[]){
  if(!rows.length)return {saved:0};
  const conn=db();
  await conn.query(`CREATE TABLE IF NOT EXISTS forward_research_signals(
    id BIGSERIAL PRIMARY KEY, observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    observation_id TEXT NOT NULL, symbol TEXT NOT NULL, strategy TEXT NOT NULL,
    reference_price DOUBLE PRECISION NOT NULL, score DOUBLE PRECISION,
    research JSONB NOT NULL DEFAULT '{}'::jsonb,
    return_1d DOUBLE PRECISION, return_3d DOUBLE PRECISION, return_5d DOUBLE PRECISION,
    evaluated_at TIMESTAMPTZ, UNIQUE(observation_id,symbol,strategy)
  )`);
  let saved=0;
  for(const x of rows){
    if(!x.symbol||!x.strategy||!(Number(x.reference_price)>0))continue;
    const result=await conn.query(`INSERT INTO forward_research_signals
      (observation_id,symbol,strategy,reference_price,score,research)
      VALUES ($1,$2,$3,$4,$5,$6::jsonb)
      ON CONFLICT (observation_id,symbol,strategy) DO NOTHING`,
      [String(x.observation_id),String(x.symbol),String(x.strategy),Number(x.reference_price),
       Number.isFinite(Number(x.score))?Number(x.score):null,JSON.stringify(x.research||{})]);
    saved+=result.rowCount||0;
  }
  return {saved};
}
export async function forwardResearchSummary(){
  const conn=db();
  await conn.query(`CREATE TABLE IF NOT EXISTS forward_research_signals(
    id BIGSERIAL PRIMARY KEY, observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    observation_id TEXT NOT NULL, symbol TEXT NOT NULL, strategy TEXT NOT NULL,
    reference_price DOUBLE PRECISION NOT NULL, score DOUBLE PRECISION,
    research JSONB NOT NULL DEFAULT '{}'::jsonb,
    return_1d DOUBLE PRECISION, return_3d DOUBLE PRECISION, return_5d DOUBLE PRECISION,
    evaluated_at TIMESTAMPTZ, UNIQUE(observation_id,symbol,strategy)
  )`);
  const r=await conn.query(`SELECT strategy,COUNT(*)::int AS observations,
    COUNT(return_1d)::int AS graded_1d,COUNT(return_5d)::int AS graded_5d,
    AVG(return_1d) AS avg_return_1d,AVG(return_5d) AS avg_return_5d
    FROM forward_research_signals GROUP BY strategy ORDER BY observations DESC`);
  return r.rows;
}
