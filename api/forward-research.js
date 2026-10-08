import {requireDashboardAuth} from '../lib/auth.js';
import {forwardResearchSummary} from '../lib/forward-research.js';
export default async function handler(req,res){
  if(!requireDashboardAuth(req,res))return;
  if(req.method!=='GET')return res.status(405).json({error:'Method not allowed'});
  try{
    const strategies=await forwardResearchSummary();
    res.setHeader('Cache-Control','no-store');
    return res.status(200).json({mode:'PAPER_RESEARCH',generated_at:new Date().toISOString(),
      observations:strategies.reduce((n,r)=>n+Number(r.observations||0),0),
      strategies,forward_grading_active:true,
      note:'Weekday forward grading is scheduled; strategy promotion remains disabled. Outcomes are price changes, not executable returns.'});
  }catch(e){return res.status(503).json({error:'Forward research evidence unavailable',detail:String(e?.message||'').slice(0,140)})}
}
