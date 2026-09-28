import { requireDashboardAuth } from '../lib/auth.js';
import { getAdaptiveResearchDataset } from '../lib/decision-memory.js';
import { buildRegimeLearningMatrix } from '../lib/regime-intelligence.js';

export default async function handler(req,res){
  if(!requireDashboardAuth(req,res)) return;
  if(req.method!=='GET') return res.status(405).json({error:'Method not allowed'});

  try{
    const dataset=await getAdaptiveResearchDataset(1500);
    if(!dataset.configured){
      return res.status(200).json({
        configured:false,
        message:'Decision Memory database is not connected yet.'
      });
    }

    const matrix=buildRegimeLearningMatrix(dataset.router||[]);
    return res.status(200).json({
      configured:true,
      ...matrix
    });
  }catch(error){
    return res.status(500).json({
      error:error?.message||'Regime learning report failed'
    });
  }
}
