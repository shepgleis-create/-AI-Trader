import { requireDashboardAuth } from '../lib/auth.js';
import { getDecisionMemoryDiagnostics } from '../lib/decision-memory.js';

export default async function handler(req,res){
  if(!requireDashboardAuth(req,res))return;
  if(req.method!=='GET')return res.status(405).json({error:'Method not allowed'});
  try{
    const d=await getDecisionMemoryDiagnostics();
    return res.status(200).json(d);
  }catch(error){
    return res.status(500).json({error:error?.message||'Memory diagnostics failed'});
  }
}
