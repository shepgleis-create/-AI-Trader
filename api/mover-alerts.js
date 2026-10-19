import {requireDashboardAuth} from '../lib/auth.js';
import {readMoverAlerts} from '../lib/mover-radar.js';

export default async function handler(req,res){
  if(!requireDashboardAuth(req,res))return;
  if(req.method!=='GET')return res.status(405).json({error:'Method not allowed'});
  try{
    const alerts=await readMoverAlerts(50);
    res.setHeader('Cache-Control','private, no-store');
    return res.status(200).json({ok:true,mode:'PAPER_RESEARCH',
      generated_at:new Date().toISOString(),alerts,
      methodology:'Price-change acceleration measured across separate 15-minute observations from Alpaca movers, not prediction or proof of a profitable entry.',
      warning:'No watch signal places a stock or crypto order. Broker and independent risk checks still govern any execution.'});
  }catch(e){return res.status(503).json({error:'Mover acceleration history unavailable',
    reason:String(e?.message||'Unknown').slice(0,140)})}
}
