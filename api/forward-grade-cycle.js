import {withCronTelemetry} from '../lib/cron-telemetry.js';
import {isDashboardAuthorized} from '../lib/auth.js';
import {getDatabaseUrl} from '../lib/database-url.js';
import pg from 'pg';
const {Pool}=pg;
async function handler(req,res){
 if(req.method!=='GET')return res.status(405).json({error:'Method not allowed'});
 const authorized=(process.env.CRON_SECRET&&req.headers.authorization==='Bearer '+process.env.CRON_SECRET)||isDashboardAuthorized(req);
 if(!authorized)return res.status(401).json({error:'Unauthorized'});
 const url=getDatabaseUrl(),key=process.env.ALPACA_API_KEY,secret=process.env.ALPACA_SECRET_KEY;
 if(!url||!key||!secret)return res.status(503).json({error:'Research data source not configured'});
 const db=new Pool({connectionString:url,max:1,connectionTimeoutMillis:6000});
 try{
  const result=await db.query("SELECT id,symbol,observed_at,reference_price,return_1d,return_3d,return_5d FROM forward_research_signals WHERE return_5d IS NULL AND observed_at<NOW()-INTERVAL '1 day' ORDER BY observed_at LIMIT 60");
  const rows=result.rows, symbols=[...new Set(rows.map(r=>r.symbol))], data={};
  for(let i=0;i<symbols.length;i+=20){
   const batch=symbols.slice(i,i+20);
   const api=new URL('https://data.alpaca.markets/v2/stocks/bars');
   api.searchParams.set('symbols',batch.join(','));
   api.searchParams.set('timeframe','1Day');
   api.searchParams.set('start',new Date(Math.min(...rows.map(r=>new Date(r.observed_at).getTime()))-86400000).toISOString());
   api.searchParams.set('end',new Date().toISOString());
   api.searchParams.set('feed','iex');
   api.searchParams.set('adjustment','all');
   api.searchParams.set('limit','10000');
   let cursor='',pages=0;
   do{
    if(cursor)api.searchParams.set('page_token',cursor);
    const response=await fetch(api,{headers:{'APCA-API-KEY-ID':key,'APCA-API-SECRET-KEY':secret}});
    if(!response.ok)throw Error('Market data unavailable: '+response.status);
    const payload=await response.json();
    for(const [symbol,bars] of Object.entries(payload.bars||{}))data[symbol]=[...(data[symbol]||[]),...bars];
    cursor=payload.next_page_token||'';
   }while(cursor&&++pages<5);
  }
  let updated=0,fields=0;
  const today=new Date().toISOString().slice(0,10);
  for(const row of rows){
   const day=new Date(row.observed_at).toISOString().slice(0,10);
   const future=(data[row.symbol]||[]).filter(b=>String(b.t).slice(0,10)>day&&String(b.t).slice(0,10)<today&&Number(b.c)>0).sort((a,b)=>String(a.t).localeCompare(String(b.t)));
   const reference=Number(row.reference_price);
   if(!Number.isFinite(reference)||reference<=0)continue;
   const values=[1,3,5].map(h=>row['return_'+h+'d']!=null||future.length<h?null:Number(future[h-1].c)/reference-1);
   if(values.every(x=>x===null))continue;
   await db.query('UPDATE forward_research_signals SET return_1d=COALESCE(return_1d,$2),return_3d=COALESCE(return_3d,$3),return_5d=COALESCE(return_5d,$4),evaluated_at=NOW() WHERE id=$1',[row.id,...values]);
   updated++;fields+=values.filter(x=>x!==null).length;
  }
  return res.status(200).json({ok:true,mode:'PAPER_RESEARCH',pending:rows.length,updated,fields});
 }catch(error){return res.status(503).json({error:String(error.message||'Forward grading unavailable').slice(0,160)})}
 finally{await db.end()}
}
export default withCronTelemetry('forward-grade-cycle',handler);
