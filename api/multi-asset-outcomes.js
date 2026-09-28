import { requireDashboardAuth } from '../lib/auth.js';
import { getMultiAssetOutcomeReport } from '../lib/decision-memory.js';

export default async function handler(req,res){
  if(!requireDashboardAuth(req,res)) return;
  if(req.method!=='GET') return res.status(405).json({error:'Method not allowed'});
  try{
    const report=await getMultiAssetOutcomeReport();
    return res.status(200).json(report);
  }catch(error){
    return res.status(500).json({error:error?.message||'Shadow outcome report failed'});
  }
}
