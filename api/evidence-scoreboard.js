import { requireDashboardAuth } from '../lib/auth.js';
import { reconstructBotTrades } from '../lib/trade-analytics.js';
import { buildEvidenceScoreboard } from '../lib/evidence-scoreboard.js';

export default async function handler(req,res){
  if(!requireDashboardAuth(req,res))return;
  if(req.method!=='GET')return res.status(405).json({error:'Method not allowed'});
  const key=process.env.ALPACA_API_KEY;
  const secret=process.env.ALPACA_SECRET_KEY;
  const base=process.env.ALPACA_BASE_URL||'https://paper-api.alpaca.markets';
  if(!key||!secret)return res.status(503).json({error:'Alpaca paper credentials not configured'});
  if(!base.includes('paper-api.alpaca.markets'))return res.status(403).json({error:'Real-money account not permitted'});
  try{
    const r=await fetch(base+'/v2/orders?status=all&limit=500&direction=desc&nested=true',{
      headers:{'APCA-API-KEY-ID':key,'APCA-API-SECRET-KEY':secret}
    });
    const raw=await r.json().catch(()=>[]);
    if(!r.ok)return res.status(502).json({error:'Alpaca order history unavailable'});
    const trades=reconstructBotTrades(Array.isArray(raw)?raw:[]);
    const scoreboard=buildEvidenceScoreboard(trades);
    res.setHeader('Cache-Control','no-store');
    return res.status(200).json({generated_at:new Date().toISOString(),mode:'PAPER',
      ...scoreboard,
      limits:{minimum_trades_per_lane:30,training_trades:20,validation_trades:10,
        broker_costs_verified:false,auto_enable:false},
      notes:['Research-only recommendations. No changes to live orders or risk limits.',
        'Open orders are excluded until matched closed fills exist.',
        'A positive historical result is not a forecast of future returns.']
    });
  }catch(e){
    return res.status(500).json({error:'Evidence scoreboard failed',detail:String(e?.message||'').slice(0,160)});
  }
}
