import { requireDashboardAuth } from '../lib/auth.js';
import { reconstructBotTrades } from '../lib/trade-analytics.js';
import { loadExcursionBars, tradeExcursion, summarizeExcursions } from '../lib/trade-excursions.js';

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
    if(!r.ok) return res.status(r.status).json({error:orders?.message||'Could not load paper orders'});

    const trades=reconstructBotTrades(Array.isArray(orders)?orders:[])
      .filter(t=>t.entry_time&&t.exit_time)
      .slice(-60);

    if(!trades.length){
      return res.status(200).json({
        total:{trades:0},
        by_lane:{},
        recent:[],
        message:'No closed bot trades are available for MAE/MFE analysis yet.'
      });
    }

    const bars=await loadExcursionBars(trades,key,secret);
    const rows=trades.map(t=>tradeExcursion(t,bars)).filter(Boolean);
    const summary=summarizeExcursions(rows);

    return res.status(200).json({
      generated_at:new Date().toISOString(),
      ...summary,
      coverage:{
        closed_trades_considered:trades.length,
        trades_with_intraday_bars:rows.length,
        data_errors:bars.errors||{}
      },
      recent:rows.sort((a,b)=>new Date(b.exit_time)-new Date(a.exit_time)).slice(0,25),
      note:'MAE/MFE uses 15-minute historical bars while the position was open. It is descriptive research, not a profitability forecast.'
    });
  }catch(error){
    return res.status(500).json({error:error?.message||'Trade quality analysis failed'});
  }
}
