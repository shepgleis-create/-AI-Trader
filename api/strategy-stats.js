import { requireDashboardAuth } from '../lib/auth.js';

function sourceFromId(id){
  const s=String(id||'');
  if(s.startsWith('aitr-g-')) return 'GEMINI';
  if(s.startsWith('aitr-q-')) return 'QUANT_FALLBACK';
  return null;
}

function scoreFromId(id){
  const s=String(id||'');
  const m=s.match(/-s(\d+)-c(\d+)(?:-p(\d+))?-/);
  return m
    ? {score:Number(m[1]),confidence:Number(m[2]),reference_price:m[3]?Number(m[3])/100:null}
    : {score:null,confidence:null,reference_price:null};
}

function summarize(trades){
  const wins=trades.filter(t=>t.pnl>0);
  const losses=trades.filter(t=>t.pnl<0);
  const grossProfit=wins.reduce((s,t)=>s+t.pnl,0);
  const grossLoss=Math.abs(losses.reduce((s,t)=>s+t.pnl,0));
  return {
    closed_trades:trades.length,
    wins:wins.length,
    losses:losses.length,
    win_rate:trades.length?wins.length/trades.length:0,
    pnl:trades.reduce((s,t)=>s+t.pnl,0),
    avg_return:trades.length?trades.reduce((s,t)=>s+t.return_pct,0)/trades.length:0,
    profit_factor:grossLoss>0?grossProfit/grossLoss:(grossProfit>0?99:0),
    avg_entry_slippage:trades.filter(t=>t.entry_slippage_pct!=null).length
      ? trades.filter(t=>t.entry_slippage_pct!=null).reduce((s,t)=>s+t.entry_slippage_pct,0) /
        trades.filter(t=>t.entry_slippage_pct!=null).length
      : null
  };
}

export default async function handler(req,res){
  if(!requireDashboardAuth(req,res)) return;
  if(req.method!=='GET') return res.status(405).json({error:'Method not allowed'});

  const key=process.env.ALPACA_API_KEY;
  const secret=process.env.ALPACA_SECRET_KEY;
  const baseUrl=process.env.ALPACA_BASE_URL||'https://paper-api.alpaca.markets';

  if(!key||!secret) return res.status(500).json({error:'Missing Alpaca credentials'});
  if(!baseUrl.includes('paper-api.alpaca.markets')) return res.status(403).json({error:'Paper-only build'});

  const headers={'APCA-API-KEY-ID':key,'APCA-API-SECRET-KEY':secret};

  try{
    const r=await fetch(`${baseUrl}/v2/orders?status=all&limit=500&direction=desc&nested=true`,{headers});
    const orders=await r.json();
    if(!r.ok) return res.status(r.status).json({error:orders?.message||'Could not load orders'});

    const trades=[];
    for(const o of (Array.isArray(orders)?orders:[])){
      const source=sourceFromId(o.client_order_id);
      if(!source||o.side!=='buy'||!o.filled_avg_price) continue;

      const entry=Number(o.filled_avg_price);
      const qty=Number(o.filled_qty||o.qty||0);
      if(!(entry>0&&qty>0)) continue;

      const filledExit=(Array.isArray(o.legs)?o.legs:[]).find(l=>l.side==='sell'&&l.status==='filled'&&l.filled_avg_price);
      if(!filledExit) continue;

      const exit=Number(filledExit.filled_avg_price);
      const closedQty=Number(filledExit.filled_qty||qty);
      const usedQty=Math.min(qty,closedQty||qty);
      const pnl=(exit-entry)*usedQty;
      const meta=scoreFromId(o.client_order_id);

      trades.push({
        symbol:o.symbol,
        source,
        entry_price:entry,
        exit_price:exit,
        qty:usedQty,
        pnl,
        return_pct:entry>0?(exit-entry)/entry:0,
        scanner_score:meta.score,
        model_confidence:meta.confidence,
        reference_price:meta.reference_price,
        entry_slippage_pct:meta.reference_price ? entry/meta.reference_price-1 : null,
        entry_time:o.filled_at||o.submitted_at,
        exit_time:filledExit.filled_at||null,
        exit_type:filledExit.type||null
      });
    }

    const gemini=trades.filter(t=>t.source==='GEMINI');
    const quant=trades.filter(t=>t.source==='QUANT_FALLBACK');

    return res.status(200).json({
      total:summarize(trades),
      by_source:{
        GEMINI:summarize(gemini),
        QUANT_FALLBACK:summarize(quant)
      },
      recent:trades.slice(0,20)
    });
  }catch(e){
    return res.status(500).json({error:e?.message||'Strategy stats failed'});
  }
}
