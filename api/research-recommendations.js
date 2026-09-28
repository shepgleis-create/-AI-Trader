import { requireDashboardAuth } from '../lib/auth.js';
import { getAdaptiveResearchDataset } from '../lib/decision-memory.js';
import { buildAdaptiveRecommendations } from '../lib/research-recommendations.js';

export default async function handler(req,res){
  if(!requireDashboardAuth(req,res)) return;
  if(req.method!=='GET') return res.status(405).json({error:'Method not allowed'});

  try{
    const dataset=await getAdaptiveResearchDataset(1000);
    if(!dataset.configured){
      return res.status(200).json({
        configured:false,
        auto_apply:false,
        message:'Decision Memory database is not connected yet.'
      });
    }

    const report=buildAdaptiveRecommendations(dataset);
    return res.status(200).json({
      configured:true,
      ...report
    });
  }catch(error){
    return res.status(500).json({
      error:error?.message||'Research recommendation analysis failed'
    });
  }
}
