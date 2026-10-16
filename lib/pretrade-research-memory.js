import pg from 'pg';
import {getDatabaseUrl} from './database-url.js';
const {Pool}=pg;
let shared;
function getPool(){
  const url=getDatabaseUrl();
  if(!url)return null;
  if(!shared)shared=new Pool({connectionString:url,max:1,connectionTimeoutMillis:4000});
  return shared;
}
export async function recordTradeResearch(entry={}){
  const db=getPool();
  if(!db)return {saved:false,error:'Research database not connected'};
  try{
    await db.query("CREATE TABLE IF NOT EXISTS pretrade_research_audit(id BIGSERIAL PRIMARY KEY, observed_at TIMESTAMPTZ DEFAULT NOW(), symbol TEXT NOT NULL, lane TEXT NOT NULL, approved BOOLEAN NOT NULL, reviewer TEXT NOT NULL, rationale TEXT, evidence JSONB, order_id TEXT, order_status TEXT)");
    const r=await db.query("INSERT INTO pretrade_research_audit(symbol,lane,approved,reviewer,rationale,evidence) VALUES($1,$2,$3,$4,$5,$6::jsonb) RETURNING id",[
      String(entry.symbol||''),String(entry.lane||'CRYPTO'),Boolean(entry.review?.approved),
      String(entry.review?.source||'UNKNOWN'),String(entry.review?.rationale||'').slice(0,450),
      JSON.stringify(entry.review||{})
    ]);
    return {saved:true,id:Number(r.rows[0].id)};
  }catch(e){return {saved:false,error:String(e.message||'Research journal unavailable').slice(0,160)}}
}
export async function updateTradeResearchOrder(id,order={}){
  if(!id)return false;
  const db=getPool();if(!db)return false;
  try{
    await db.query("UPDATE pretrade_research_audit SET order_id=$2,order_status=$3 WHERE id=$1",
      [id,String(order.id||''),String(order.status||'')]);
    return true;
  }catch{return false}
}
export async function readTradeResearch(limit=50){
  const db=getPool();if(!db)throw Error('Research journal unavailable');
  const r=await db.query("SELECT id,observed_at,symbol,lane,approved,reviewer,rationale,evidence,order_id,order_status FROM pretrade_research_audit ORDER BY observed_at DESC LIMIT $1",
    [Math.min(100,Math.max(1,Number(limit)||50))]);
  return r.rows;
}
