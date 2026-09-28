import { requireDashboardAuth } from '../lib/auth.js';
import { reconstructBotTrades, summarizeTrades, summarizeByLane } from '../lib/trade-analytics.js';

export default async function handler(req,res){
  if(!requireDashboardAuth(req,res)) return;
  if(req.method!=='GET') return res.status(405).json({error:'Method not allowed'});

  const key=process.env.ALPACA_API_KEY;
  const secret=process.env.ALPACA_SECRET_KEY;
  const base=process.env.ALPACA_BASE_URL||'https://paper-api.alpaca.markets';

  if(!key||!secret) return res.status(500).json({error:'Missing Alpaca credentials'});
  if(!base.includes('paper-api.alpaca.markets')) return res.status(403).json({error:'Paper-only build'});

  try{
    const r=await fetch(`${base}/v2/orders?status=all&limit=500&direction=desc&nested=true`,{
      headers:{
        'APCA-API-KEY-ID':key,
        'APCA-API-SECRET-KEY':secret
      }
    });
    const orders=await r.json().catch(()=>[]);
    if(!r.ok) return res.status(r.status).json({error:orders?.message||'Could not load Alpaca order history'});

    const trades=reconstructBotTrades(Array.isArray(orders)?orders:[])
      .sort((a,b)=>new Date(b.exit_time||0)-new Date(a.exit_time||0));

    const byLane=summarizeByLane(trades);
    const laneRows=Object.entries(byLane).map(([lane,stats])=>({lane,...stats}));

    return res.status(200).json({
      generated_at:new Date().toISOString(),
      mode:'PAPER',
      total:summarizeTrades(trades),
      by_lane:byLane,
      lane_rows:laneRows,
      recent:trades.slice(0,30),
      notes:[
        'Stats use actual filled Alpaca paper orders.',
        'Options P/L uses the standard 100-share contract multiplier.',
        'Simple crypto/options exits are paired to the nearest later opposite-side fill for the same symbol.',
        'No profitability claim is implied by a small sample.'
      ]
    });
  }catch(error){
    return res.status(500).json({error:error?.message||'Multi-asset performance analysis failed'});
  }
}
