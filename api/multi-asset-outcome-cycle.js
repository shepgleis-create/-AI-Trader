import { withCronTelemetry } from '../lib/cron-telemetry.js';
import { isDashboardAuthorized } from '../lib/auth.js';
import {
  decisionMemoryConfigured,
  getPendingMultiAssetOutcomes,
  updateMultiAssetOutcome,
  updateResearchChallengerOutcomes
} from '../lib/decision-memory.js';
import { loadOutcomeBars, gradeMultiAssetDecision } from '../lib/multi-asset-outcomes.js';

async function handler(req,res){
  if(req.method!=='GET') return res.status(405).json({error:'Method not allowed'});

  const cronSecret=process.env.CRON_SECRET;
  const cronAuthorized=Boolean(cronSecret)&&req.headers.authorization===`Bearer ${cronSecret}`;
  const dashboardAuthorized=isDashboardAuthorized(req);
  if(!cronAuthorized&&!dashboardAuthorized) return res.status(401).json({error:'Unauthorized'});

  if(!decisionMemoryConfigured()){
    return res.status(200).json({
      ok:true,configured:false,pending:0,graded:0,
      message:'Decision Memory is waiting for a Postgres database connection.'
    });
  }

  const key=process.env.ALPACA_API_KEY;
  const secret=process.env.ALPACA_SECRET_KEY;
  if(!key||!secret) return res.status(500).json({error:'Missing Alpaca credentials'});

  try{
    const pending=await getPendingMultiAssetOutcomes(80);
    if(!pending.length){
      return res.status(200).json({ok:true,configured:true,pending:0,graded:0});
    }

    const bars=await loadOutcomeBars(pending,key,secret);
    let graded=0;
    const details=[];

    for(const row of pending){
      const before=JSON.stringify(row.outcome||{});
      const outcome=gradeMultiAssetDecision(row,bars);
      const after=JSON.stringify(outcome||{});
      if(before===after) continue;

      await updateMultiAssetOutcome(row.decision_id,outcome);
      await updateResearchChallengerOutcomes(row.decision_id,outcome);
      graded++;
      details.push({
        decision_id:row.decision_id,
        selected_lane:row.selected_lane,
        horizons:['h1','d1','d3','d5'].filter(h=>outcome?.[h]),
        complete_5d:Boolean(outcome?.complete_5d)
      });
    }

    return res.status(200).json({
      ok:true,
      configured:true,
      pending:pending.length,
      graded,
      data_errors:bars.errors||{},
      details:details.slice(0,30)
    });
  }catch(error){
    return res.status(500).json({error:error?.message||'Multi-asset outcome grading failed'});
  }
}

export default withCronTelemetry('multi-asset-outcome-cycle',handler);
