import { requireDashboardAuth } from '../lib/auth.js';
import { fetchShortScan } from '../lib/multi-asset.js';

export default async function handler(req,res){
  if(!requireDashboardAuth(req,res))return;
  if(req.method!=='GET')return res.status(405).json({error:'Method not allowed'});
  const key=process.env.ALPACA_API_KEY;
  const secret=process.env.ALPACA_SECRET_KEY;
  const base=process.env.ALPACA_BASE_URL||'https://paper-api.alpaca.markets';
  if(!key||!secret)return res.status(500).json({error:'Missing Alpaca credentials'});
  if(!base.includes('paper-api.alpaca.markets'))return res.status(403).json({error:'Paper-only build'});
  try{
    const scan=await fetchShortScan(key,secret);
    return res.status(200).json({
      generated_at:new Date().toISOString(),
      mode:'PAPER_RESEARCH',
      ...scan
    });
  }catch(error){
    return res.status(500).json({error:error?.message||'Bearish scan failed'});
  }
}
