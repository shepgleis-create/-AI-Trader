import { isDashboardAuthorized } from '../lib/auth.js';
import {
  decisionMemoryConfigured,
  getPendingOutcomeCandidates,
  updateCandidateOutcomes
} from '../lib/decision-memory.js';

function dateKey(bar){
  return String(bar?.t||'').slice(0,10);
}

function chunks(rows,size){
  const out=[];
  for(let i=0;i<rows.length;i+=size) out.push(rows.slice(i,i+size));
  return out;
}

async function fetchDailyBars(symbols,start,end,key,secret){
  const out={};
  for(const batch of chunks(symbols,40)){
    const url=new URL('https://data.alpaca.markets/v2/stocks/bars');
    url.searchParams.set('symbols',batch.join(','));
    url.searchParams.set('timeframe','1Day');
    url.searchParams.set('start',start.toISOString());
    url.searchParams.set('end',end.toISOString());
    url.searchParams.set('adjustment','all');
    url.searchParams.set('feed','iex');
    url.searchParams.set('limit','10000');

    const r=await fetch(url,{
      headers:{
        'APCA-API-KEY-ID':key,
        'APCA-API-SECRET-KEY':secret
      }
    });
    const data=await r.json().catch(()=>({}));
    if(!r.ok) throw new Error(data?.message||'Could not load outcome bars');

    for(const [symbol,bars] of Object.entries(data?.bars||{})){
      out[symbol]=(out[symbol]||[]).concat(Array.isArray(bars)?bars:[]);
    }
  }

  for(const symbol of Object.keys(out)){
    out[symbol].sort((a,b)=>String(a.t).localeCompare(String(b.t)));
  }
  return out;
}

export default async function handler(req,res){
  if(req.method!=='GET') return res.status(405).json({error:'Method not allowed'});

  const cronSecret=process.env.CRON_SECRET;
  const cronAuthorized=Boolean(cronSecret)&&req.headers.authorization===`Bearer ${cronSecret}`;
  const dashboardAuthorized=isDashboardAuthorized(req);

  if(!cronAuthorized&&!dashboardAuthorized){
    return res.status(401).json({error:'Unauthorized'});
  }

  if(!decisionMemoryConfigured()){
    return res.status(200).json({
      ok:true,
      configured:false,
      graded:0,
      message:'Decision Memory is waiting for a Postgres database connection.'
    });
  }

  const key=process.env.ALPACA_API_KEY;
  const secret=process.env.ALPACA_SECRET_KEY;
  if(!key||!secret) return res.status(500).json({error:'Missing Alpaca credentials'});

  try{
    const pending=await getPendingOutcomeCandidates(120);
    if(!pending.length){
      return res.status(200).json({ok:true,configured:true,pending:0,graded:0});
    }

    const symbols=[...new Set(pending.map(x=>x.symbol).filter(Boolean))];
    const earliest=Math.min(...pending.map(x=>new Date(x.created_at).getTime()).filter(Number.isFinite));
    const start=new Date(earliest-86400000);
    const end=new Date(Date.now()+86400000);
    const barsBySymbol=await fetchDailyBars(symbols,start,end,key,secret);

    let graded=0;
    let fieldsUpdated=0;
    const details=[];

    for(const row of pending){
      const reference=Number(row.reference_price);
      if(!(reference>0)) continue;

      const decisionDay=new Date(row.created_at).toISOString().slice(0,10);
      const future=(barsBySymbol[row.symbol]||[])
        .filter(b=>dateKey(b)>decisionDay&&Number(b?.c)>0)
        .sort((a,b)=>String(a.t).localeCompare(String(b.t)));

      const updates={};
      for(const [horizon,index] of [[1,0],[3,2],[5,4]]){
        const outcomeKey=`outcome_${horizon}d`;
        if(row[outcomeKey]!=null) continue;
        if(future.length<=index) continue;

        const bar=future[index];
        const close=Number(bar.c);
        if(!(close>0)) continue;

        updates[outcomeKey]=close/reference-1;
        updates[`close_${horizon}d`]=close;
        updates[`outcome_${horizon}d_at`]=bar.t;
      }

      if(Object.keys(updates).length){
        await updateCandidateOutcomes(row.id,updates);
        graded++;
        fieldsUpdated+=Object.keys(updates).filter(k=>k.startsWith('outcome_')&&!k.endsWith('_at')).length;
        details.push({
          symbol:row.symbol,
          cycle_id:row.cycle_id,
          updated:Object.keys(updates).filter(k=>k.startsWith('outcome_')&&!k.endsWith('_at'))
        });
      }
    }

    return res.status(200).json({
      ok:true,
      configured:true,
      pending:pending.length,
      graded,
      outcome_fields_updated:fieldsUpdated,
      details:details.slice(0,25)
    });
  }catch(error){
    return res.status(500).json({error:error?.message||'Outcome grading failed'});
  }
}
