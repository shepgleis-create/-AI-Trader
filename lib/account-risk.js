const LIMITS = {
  maxDrawdownPct: -0.05,
  weeklyLossPct: -0.04,
  maxOpenRiskPct: 0.01,
  consecutiveLossLimit: 3
};

function num(v,fallback=0){
  const n=Number(v);
  return Number.isFinite(n)?n:fallback;
}

function collectSellLegs(order){
  const out=[];
  if(order?.side==='sell') out.push(order);
  for(const leg of (Array.isArray(order?.legs)?order.legs:[])){
    if(leg?.side==='sell') out.push(leg);
  }
  return out;
}

function autonomousClosedTrades(recentOrders=[]){
  const rows=[];
  for(const o of recentOrders){
    if(o?.side!=='buy') continue;
    if(!String(o?.client_order_id||'').startsWith('aitr-')) continue;
    const entry=num(o.filled_avg_price);
    const qty=num(o.filled_qty||o.qty);
    if(!(entry>0&&qty>0)) continue;

    const exits=collectSellLegs(o)
      .filter(x=>x?.status==='filled'&&num(x?.filled_avg_price)>0)
      .sort((a,b)=>new Date(b?.filled_at||0)-new Date(a?.filled_at||0));

    const exit=exits[0];
    if(!exit) continue;

    const exitPrice=num(exit.filled_avg_price);
    const usedQty=Math.min(qty,num(exit.filled_qty,qty)||qty);
    const pnl=(exitPrice-entry)*usedQty;
    rows.push({
      symbol:o.symbol,
      pnl,
      return_pct:entry>0?(exitPrice-entry)/entry:0,
      closed_at:exit.filled_at||null
    });
  }

  return rows.sort((a,b)=>new Date(b.closed_at||0)-new Date(a.closed_at||0));
}

function currentStopForSymbol(symbol,openOrders=[]){
  let best=null;
  for(const o of openOrders){
    const candidates=[o,...(Array.isArray(o?.legs)?o.legs:[])];
    for(const x of candidates){
      if((x?.symbol||o?.symbol)!==symbol) continue;
      if(x?.side!=='sell') continue;
      if(!['stop','stop_limit'].includes(String(x?.type||'').toLowerCase())) continue;
      const stop=num(x?.stop_price);
      if(stop>0&&(best==null||stop>best)) best=stop;
    }
  }
  return best;
}

export function buildAccountRisk({
  account,
  positions=[],
  openOrders=[],
  recentOrders=[],
  portfolioHistory={}
}){
  const equity=num(account?.equity||account?.portfolio_value);
  const history=(portfolioHistory?.equity||[])
    .map(Number)
    .filter(x=>Number.isFinite(x)&&x>0);

  const observed=[...history];
  if(equity>0) observed.push(equity);

  const highWater=observed.length?Math.max(...observed):equity;
  const drawdown=highWater>0?equity/highWater-1:0;

  let weeklyReturn=0;
  if(history.length>=2){
    const base=history[Math.max(0,history.length-6)];
    const latest=equity>0?equity:history.at(-1);
    weeklyReturn=base>0?latest/base-1:0;
  }

  let openRiskDollars=0;
  const positionRisk=[];
  for(const p of positions){
    const qty=Math.abs(num(p?.qty));
    const entry=num(p?.avg_entry_price);
    const current=num(p?.current_price||entry);
    const stop=currentStopForSymbol(p?.symbol,openOrders);

    let risk=0;
    if(qty>0&&entry>0){
      risk=stop&&stop<entry
        ?(entry-stop)*qty
        :Math.abs(num(p?.market_value))*0.03;
    }

    openRiskDollars+=Math.max(0,risk);
    positionRisk.push({
      symbol:p?.symbol,
      stop_price:stop,
      estimated_risk_dollars:Math.max(0,risk)
    });
  }

  const openRiskPct=equity>0?openRiskDollars/equity:0;

  const closed=autonomousClosedTrades(recentOrders);
  let consecutiveLosses=0;
  for(const t of closed){
    if(t.pnl<0) consecutiveLosses++;
    else break;
  }

  const locks=[];
  if(drawdown<=LIMITS.maxDrawdownPct) locks.push('30-day drawdown circuit breaker');
  if(weeklyReturn<=LIMITS.weeklyLossPct) locks.push('Weekly loss circuit breaker');
  if(openRiskPct>=LIMITS.maxOpenRiskPct) locks.push('Open risk budget exceeded');
  if(consecutiveLosses>=LIMITS.consecutiveLossLimit) locks.push('Consecutive-loss circuit breaker');

  return {
    approved:locks.length===0,
    locks,
    limits:LIMITS,
    equity,
    high_water_equity:highWater,
    drawdown_pct:drawdown,
    trailing_week_return:weeklyReturn,
    open_risk_dollars:openRiskDollars,
    open_risk_pct:openRiskPct,
    position_risk:positionRisk,
    consecutive_autonomous_losses:consecutiveLosses,
    closed_autonomous_trades_observed:closed.length
  };
}

export const ACCOUNT_RISK_LIMITS=LIMITS;
