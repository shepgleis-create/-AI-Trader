import {requireDashboardAuth} from '../lib/auth.js';
import {readTradeResearch} from '../lib/pretrade-research-memory.js';

export default async function handler(req,res){
  if(!requireDashboardAuth(req,res))return;
  if(req.method!=='GET')return res.status(405).json({error:'Method not allowed'});
  try{
    const rows=await readTradeResearch(60);
    const approved=rows.filter(r=>r.approved);
    const submitted=rows.filter(r=>r.order_id);
    res.setHeader('Cache-Control','private, no-store');
    return res.status(200).json({
      ok:true,mode:'PAPER',
      records:rows,
      summary:{
        researched:rows.length,
        approvals:approved.length,
        vetoes:rows.length-approved.length,
        linked_broker_orders:submitted.length,
        gemini_reviews:rows.filter(r=>r.reviewer==='GEMINI_REVIEW').length,
        quant_fallback_reviews:rows.filter(r=>r.reviewer==='QUANT_FALLBACK').length
      },
      note:'A review is not a trade or measured edge. A linked order does not guarantee an execution. Protective exit actions must not wait for AI.'
    });
  }catch(error){return res.status(503).json({
    error:'Pretrade research history unavailable',
    reason:String(error.message||'Unknown').slice(0,140)
  })}
}
