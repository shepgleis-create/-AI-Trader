import {requireDashboardAuth} from '../lib/auth.js';
import {loadMarketMovers} from '../lib/mover-data.js';

export default async function handler(req,res){
  if(!requireDashboardAuth(req,res))return;
  if(req.method!=='GET')return res.status(405).json({error:'Method not allowed'});
  const market=String(req.query?.market||'stocks');
  const window=String(req.query?.window||'1d');
  const direction=String(req.query?.direction||'gainers');
  if(!['stocks','crypto'].includes(market)||!['1d','1w','1m'].includes(window)||
     !['gainers','losers'].includes(direction))
    return res.status(400).json({error:'Invalid market-mover filter'});
  const key=process.env.ALPACA_API_KEY,secret=process.env.ALPACA_SECRET_KEY;
  if(!key||!secret)return res.status(503).json({error:'Paper Alpaca market data credentials unavailable'});
  try{
    const d=await loadMarketMovers({market,window,direction,key,secret});
    res.setHeader('Cache-Control','private, max-age=30');
    return res.status(200).json({
      ok:true,mode:'PAPER_RESEARCH',
      market,window,direction,updated_at:d.generated_at,
      provider_updated_at:d.provider_updated_at,
      source:d.provider,coverage:d.coverage,
      warnings:[d.warning,d.history_warning].filter(Boolean),
      rows:d.rows,disclaimer:'Gainers and losers are discoveries, not automatic entry recommendations. A fast price rise can reverse before a trade executes.'
    });
  }catch(e){
    return res.status(502).json({error:'Mover market data unavailable',
      detail:String(e?.message||'Unknown').slice(0,180)});
  }
}
