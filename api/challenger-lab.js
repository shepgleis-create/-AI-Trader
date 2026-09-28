import { requireDashboardAuth } from '../lib/auth.js';
import {
  getAdaptiveResearchDataset,
  syncResearchChallengers,
  getResearchChallengerReport
} from '../lib/decision-memory.js';
import { buildAdaptiveRecommendations } from '../lib/research-recommendations.js';

export default async function handler(req,res){
  if(!requireDashboardAuth(req,res)) return;
  if(!['GET','POST'].includes(req.method)){
    return res.status(405).json({error:'Method not allowed'});
  }

  try{
    let sync=null;
    if(req.method==='POST'){
      const dataset=await getAdaptiveResearchDataset(1000);
      if(!dataset.configured){
        return res.status(200).json({
          configured:false,
          auto_apply:false,
          message:'Decision Memory database is not connected yet.'
        });
      }
      const recommendations=buildAdaptiveRecommendations(dataset);
      sync=await syncResearchChallengers(recommendations.recommendations||[]);
    }

    const report=await getResearchChallengerReport();
    return res.status(200).json({
      ...report,
      sync
    });
  }catch(error){
    return res.status(500).json({
      error:error?.message||'Challenger Lab failed'
    });
  }
}
