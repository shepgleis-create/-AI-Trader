import {requireDashboardAuth} from '../lib/auth.js';
import {getDatabaseUrl} from '../lib/database-url.js';
import pg from 'pg';

export default async function handler(req,res){
  if(!requireDashboardAuth(req,res))return;
  if(req.method!=='GET')return res.status(405).json({error:'Method not allowed'});
  const key=process.env.ALPACA_API_KEY,secret=process.env.ALPACA_SECRET_KEY;
  const configuredBase=process.env.ALPACA_BASE_URL||'https://paper-api.alpaca.markets';
  let base;
  try{base=new URL(configuredBase)}
  catch{return res.status(503).json({error:'Paper broker URL misconfigured'})}
  if(base.hostname!=='paper-api.alpaca.markets'||!key||!secret)
    return res.status(503).json({error:'Paper brokerage credentials unavailable or live endpoint blocked'});
  const connectionString=getDatabaseUrl();
  if(!connectionString)return res.status(503).json({error:'Decision Memory unavailable'});
  const db=new pg.Pool({connectionString,max:1,connectionTimeoutMillis:5000});
  try{
    const [stages,errors,bkr]=await Promise.all([
      db.query(`SELECT stage,COUNT(*)::int AS count FROM decision_cycles
        WHERE origin='auto_cycle' AND created_at>NOW()-INTERVAL '14 days'
        GROUP BY stage ORDER BY count DESC`),
      db.query(`SELECT execution->>'error' AS reason,COUNT(*)::int AS count
        FROM decision_cycles WHERE origin='auto_cycle' AND stage='ORDER_REJECTED'
        AND created_at>NOW()-INTERVAL '14 days'
        GROUP BY 1 ORDER BY count DESC LIMIT 8`),
      fetch(base.origin+'/v2/orders?status=all&limit=100&direction=desc&nested=true',{
        headers:{'APCA-API-KEY-ID':key,'APCA-API-SECRET-KEY':secret},
        signal:AbortSignal.timeout(6000)
      })
    ]);
    if(!bkr.ok)return res.status(502).json({error:'Cannot verify paper broker orders',http_status:bkr.status});
    const all=await bkr.json();
    if(!Array.isArray(all))return res.status(502).json({error:'Unexpected paper broker order response'});
    const botOrders=all.filter(o=>/^aitr-[gq]-/.test(String(o.client_order_id||'')));
    const statuses={};
    for(const o of botOrders){const status=String(o.status||'unknown');statuses[status]=(statuses[status]||0)+1}
    const sent=botOrders.filter(o=>o.side==='buy');
    res.setHeader('Cache-Control','no-store');
    return res.status(200).json({
      mode:'PAPER',as_of:new Date().toISOString(),window:'LAST_14_DAYS_FOR_DECISION_MEMORY',
      decision_stages:stages.rows,broker_rejections:errors.rows,
      broker_order_page_limit:100,
      bot_stock_orders_in_latest_broker_page:sent.length,
      latest_order_statuses:statuses,
      recently_filled:sent.filter(o=>Number(o.filled_qty||0)>0).slice(0,10).map(o=>({
        symbol:o.symbol,status:o.status,filled_qty:o.filled_qty,submitted_at:o.submitted_at,
        filled_at:o.filled_at,filled_avg_price:o.filled_avg_price
      })),
      note:'Alpaca order records are paper only. The latest 100 account orders are not a complete lifetime history. A submitted or accepted order is not necessarily a fill.'
    });
  }catch(e){
    return res.status(503).json({error:'Stock execution diagnostic unavailable',reason:String(e?.message||'unknown').slice(0,180)});
  }finally{await db.end().catch(()=>{})}
}
