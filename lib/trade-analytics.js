function n(v){
  const x=Number(v);
  return Number.isFinite(x)?x:null;
}

export function laneFromOrder(order){
  const id=String(order?.client_order_id||'');
  if(/^aitr-(g|q)-/.test(id)) return 'LONG_EQUITY';
  if(id.startsWith('aitr-s-')) return 'SHORT_EQUITY';
  if(id.startsWith('aitr-c-')) return 'CRYPTO_LONG';
  if(id.startsWith('aitr-o-c-')) return 'LONG_CALL';
  if(id.startsWith('aitr-o-p-')) return 'LONG_PUT';
  if(id.startsWith('aitr-o-')) return 'OPTION_UNKNOWN';
  return null;
}

function isFilled(o){
  return String(o?.status||'').toLowerCase()==='filled' && n(o?.filled_avg_price)>0 && n(o?.filled_qty||o?.qty)>0;
}

function timeOf(o){
  const t=new Date(o?.filled_at||o?.submitted_at||0).getTime();
  return Number.isFinite(t)?t:0;
}

function optionMultiplier(lane){
  return lane==='LONG_CALL'||lane==='LONG_PUT'||lane==='OPTION_UNKNOWN'?100:1;
}

function directionForLane(lane){
  return lane==='SHORT_EQUITY'?-1:1;
}

function childExit(parent){
  const entrySide=String(parent?.side||'').toLowerCase();
  return (Array.isArray(parent?.legs)?parent.legs:[])
    .filter(l=>isFilled(l) && String(l.side||'').toLowerCase()!==entrySide)
    .sort((a,b)=>timeOf(a)-timeOf(b))[0]||null;
}

function nearestSeparateExit(entry,orders){
  const entrySide=String(entry?.side||'').toLowerCase();
  const entryTime=timeOf(entry);
  return orders
    .filter(o=>
      o?.id!==entry?.id &&
      o?.symbol===entry?.symbol &&
      isFilled(o) &&
      String(o?.side||'').toLowerCase()!==entrySide &&
      timeOf(o)>=entryTime
    )
    .sort((a,b)=>timeOf(a)-timeOf(b))[0]||null;
}

export function reconstructBotTrades(rawOrders=[]){
  const orders=Array.isArray(rawOrders)?rawOrders:[];
  const entries=orders
    .filter(o=>laneFromOrder(o)&&isFilled(o))
    .sort((a,b)=>timeOf(a)-timeOf(b));

  const trades=[];
  for(const entry of entries){
    const lane=laneFromOrder(entry);
    const exit=childExit(entry)||nearestSeparateExit(entry,orders);
    if(!exit) continue;

    const entryPrice=n(entry.filled_avg_price);
    const exitPrice=n(exit.filled_avg_price);
    const entryQty=n(entry.filled_qty||entry.qty)||0;
    const exitQty=n(exit.filled_qty||exit.qty)||entryQty;
    const qty=Math.min(entryQty,exitQty);
    if(!(entryPrice>0&&exitPrice>0&&qty>0)) continue;

    const direction=directionForLane(lane);
    const multiplier=optionMultiplier(lane);
    const pnl=(exitPrice-entryPrice)*qty*multiplier*direction;
    const returnPct=((exitPrice-entryPrice)/entryPrice)*direction;
    const entryTime=timeOf(entry);
    const exitTime=timeOf(exit);
    const holdHours=entryTime&&exitTime>=entryTime?(exitTime-entryTime)/3600000:null;

    trades.push({
      lane,
      symbol:entry.symbol,
      entry_order_id:entry.id||null,
      exit_order_id:exit.id||null,
      entry_client_order_id:entry.client_order_id||null,
      entry_price:entryPrice,
      exit_price:exitPrice,
      qty,
      multiplier,
      pnl,
      return_pct:returnPct,
      hold_hours:holdHours,
      entry_time:entry.filled_at||entry.submitted_at||null,
      exit_time:exit.filled_at||exit.submitted_at||null,
      exit_type:exit.type||null,
      used_bracket_leg:Boolean(childExit(entry))
    });
  }
  return trades;
}

export function summarizeTrades(trades=[]){
  const rows=Array.isArray(trades)?trades:[];
  const wins=rows.filter(t=>t.pnl>0);
  const losses=rows.filter(t=>t.pnl<0);
  const grossProfit=wins.reduce((s,t)=>s+t.pnl,0);
  const grossLoss=Math.abs(losses.reduce((s,t)=>s+t.pnl,0));
  const totalPnl=rows.reduce((s,t)=>s+t.pnl,0);
  const avg=x=>x.length?x.reduce((a,b)=>a+b,0)/x.length:0;
  const avgWin=avg(wins.map(t=>t.pnl));
  const avgLoss=Math.abs(avg(losses.map(t=>t.pnl)));
  const avgReturn=avg(rows.map(t=>t.return_pct));
  const avgHoldRows=rows.filter(t=>Number.isFinite(t.hold_hours));
  const avgHold=avg(avgHoldRows.map(t=>t.hold_hours));

  return {
    closed_trades:rows.length,
    wins:wins.length,
    losses:losses.length,
    win_rate:rows.length?wins.length/rows.length:0,
    pnl:totalPnl,
    avg_return:avgReturn,
    profit_factor:grossLoss>0?grossProfit/grossLoss:(grossProfit>0?99:0),
    avg_winner:avgWin,
    avg_loser:avgLoss,
    payoff_ratio:avgLoss>0?avgWin/avgLoss:(avgWin>0?99:0),
    expectancy_per_trade:rows.length?totalPnl/rows.length:0,
    avg_hold_hours:avgHold
  };
}

export function summarizeByLane(trades=[]){
  const lanes=['LONG_EQUITY','SHORT_EQUITY','CRYPTO_LONG','LONG_CALL','LONG_PUT','OPTION_UNKNOWN'];
  const out={};
  for(const lane of lanes) out[lane]=summarizeTrades(trades.filter(t=>t.lane===lane));
  return out;
}
