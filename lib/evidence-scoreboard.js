const number=v=>Number.isFinite(Number(v))?Number(v):0;
function average(values){return values.length?values.reduce((a,b)=>a+b,0)/values.length:0}
export function wilsonLowerBound(wins,total,z=1.96){
  if(total<=0)return 0;
  const p=wins/total,denom=1+z*z/total;
  return Math.max(0,(p+z*z/(2*total)-z*Math.sqrt((p*(1-p)+z*z/(4*total))/total))/denom);
}
function money(v){return Math.round(v*100)/100}
function metricBlock(trades,costBps){
  const rows=trades.map(t=>{
    const multiplier=number(t.multiplier)||1;
    const entryValue=number(t.entry_price)*number(t.qty)*multiplier;
    const estimatedCosts=entryValue*(costBps/10000);
    return {...t,estimated_cost:estimatedCosts,estimated_net_pnl:number(t.pnl)-estimatedCosts};
  });
  const pnl=rows.map(r=>r.estimated_net_pnl);
  const wins=pnl.filter(v=>v>0);
  const losses=pnl.filter(v=>v<0);
  const grossProfit=wins.reduce((a,b)=>a+b,0);
  const grossLoss=-losses.reduce((a,b)=>a+b,0);
  let cumulative=0,highWater=0,maxDecline=0;
  for(const value of pnl){
    cumulative+=value;
    highWater=Math.max(highWater,cumulative);
    maxDecline=Math.max(maxDecline,highWater-cumulative);
  }
  return{
    trades:rows.length,
    profitable_trades:wins.length,
    win_rate:rows.length?wins.length/rows.length:null,
    win_rate_wilson_lower_95:rows.length?wilsonLowerBound(wins.length,rows.length):null,
    estimated_net_pnl:money(pnl.reduce((a,b)=>a+b,0)),
    estimated_total_cost:money(rows.reduce((a,b)=>a+b.estimated_cost,0)),
    net_expectancy_per_trade:rows.length?money(average(pnl)):null,
    profit_factor:grossLoss>0?Math.round(grossProfit/grossLoss*100)/100:null,
    profit_factor_defined:grossLoss>0,
    maximum_cumulative_pnl_decline:money(maxDecline)
  };
}
function tradeTime(t){
  const d=new Date(t?.exit_time||t?.entry_time||0).getTime();
  return Number.isFinite(d)?d:0;
}
export function evaluateLane(rawTrades=[],{roundTripCostBps=10,minimum=30}={}){
  const ordered=(Array.isArray(rawTrades)?rawTrades:[])
    .filter(t=>Number.isFinite(Number(t?.entry_price))&&Number(t?.entry_price)>0&&
               Number.isFinite(Number(t?.qty))&&Number(t?.qty)>0&&
               Number.isFinite(Number(t?.pnl)))
    .sort((a,b)=>tradeTime(a)-tradeTime(b));
  const all=metricBlock(ordered,roundTripCostBps);
  const split=Math.floor(ordered.length*2/3);
  const earlier=metricBlock(ordered.slice(0,split),roundTripCostBps);
  const later=metricBlock(ordered.slice(split),roundTripCostBps);
  const enough=ordered.length>=minimum&&earlier.trades>=20&&later.trades>=10;
  const positiveInBoth=enough&&earlier.net_expectancy_per_trade>0&&later.net_expectancy_per_trade>0;
  const stable=enough&&positiveInBoth&&
    earlier.profit_factor_defined&&later.profit_factor_defined&&
    earlier.profit_factor>=1.15&&later.profit_factor>=1.15;
  const recentNet=ordered.slice(-10).reduce((sum,t)=>sum+
    number(t.pnl)-number(t.entry_price)*number(t.qty)*(number(t.multiplier)||1)*roundTripCostBps/10000,0);
  const previousNet=ordered.slice(-20,-10).reduce((sum,t)=>sum+
    number(t.pnl)-number(t.entry_price)*number(t.qty)*(number(t.multiplier)||1)*roundTripCostBps/10000,0);
  return{
    state:!enough?'INSUFFICIENT_SAMPLE':stable?'PROMISING_PAPER_EVIDENCE':'NO_VALIDATED_EDGE',
    eligible_for_live_money:false,
    eligible_for_auto_tuning:false,
    sample_required:minimum,
    sample_available:ordered.length,
    cost_assumption_round_trip_bps:roundTripCostBps,
    all,earlier,later,
    drift_warning:ordered.length>=20&&recentNet<previousNet&&recentNet<0,
    note:'Actual paper fills with an assumed round-trip cost buffer, not broker-verified fees. Chronological split is diagnostic; no capital scaling or return guarantee.'
  };
}
export function buildEvidenceScoreboard(trades=[],options={}){
  const lanes=['LONG_EQUITY','SHORT_EQUITY','CRYPTO_LONG','LONG_CALL','LONG_PUT'];
  const byLane=Object.fromEntries(lanes.map(lane=>[lane,evaluateLane(trades.filter(t=>t.lane===lane),options)]));
  const ranking=lanes.map(lane=>({lane,...byLane[lane]}))
    .sort((a,b)=>{
      const rank=s=>s==='PROMISING_PAPER_EVIDENCE'?2:s==='NO_VALIDATED_EDGE'?1:0;
      return rank(b.state)-rank(a.state)||b.all.trades-a.all.trades;
    });
  return {by_lane:byLane,ranking,total:evaluateLane(trades,options),
    sample_warning:'Orders API returns at most 500 recent orders per request, so this is a recent-fill scoreboard, not complete historical P/L.'};
}
