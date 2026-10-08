import {requireDashboardAuth} from '../lib/auth.js';
import {forwardResearchSummary} from '../lib/forward-research.js';
export default async function handler(req,res){
  if(!requireDashboardAuth(req,res))return;
  if(req.method!=='GET')return res.status(405).json({error:'Method not allowed'});
  try{
    const strategies=await forwardResearchSummary();
    const evaluated=strategies.map(row=>({
      ...row,
      evidence_status:Number(row.graded_5d)>=30?'PRELIMINARY_EVIDENCE':'INSUFFICIENT_FORWARD_SAMPLE',
      eligible_for_automatic_promotion:false,
      missing_5d:Number(row.observations)-Number(row.graded_5d)
    }));
    res.setHeader('Cache-Control','no-store');
    return res.status(200).json({mode:'PAPER_RESEARCH',generated_at:new Date().toISOString(),
      observations:strategies.reduce((n,r)=>n+Number(r.observations||0),0),
      strategies:evaluated,forward_grading_active:true,
      quality_policy:{minimum_completed_5d_observations:30,auto_strategy_promotion:false,
        disclaimer:'Observed returns are unadjusted price changes; no trade fills, fees, or market benchmark are incorporated.'},
      note:'Weekday forward grading is scheduled; strategy promotion remains disabled. Outcomes are price changes, not executable returns.'});
  }catch(e){return res.status(503).json({error:'Forward research evidence unavailable',detail:String(e?.message||'').slice(0,140)})}
}
