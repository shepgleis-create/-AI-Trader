// Market-movers research is discovery, NOT an automatic trading recommendation.
// Percentages are percent points (e.g. 15.4 means +15.4%), not fractions.
const NUM=n=>{const v=Number(n);return Number.isFinite(v)?v:null};
const pct=(a,b)=>a>0&&b>0?(b/a-1)*100:null;
const cleanSymbol=value=>String(value||'').toUpperCase().replace(/[^A-Z0-9.\/\-]/g,'').slice(0,22);
export function normalizeMover(raw={},direction='gainers'){
  const symbol=cleanSymbol(raw.symbol);
  const price=NUM(raw.price);
  const rawPercent=NUM(raw.percent_change);
  if(!symbol||!(price>0)||rawPercent===null)return null;
  return {symbol,price,day_pct:rawPercent,day_change_dollars:NUM(raw.change),
    direction:rawPercent<0?'losers':direction,provider:'ALPACA_MOVERS'};
}
export function computeMoverReturns(bars=[],price,now=new Date()){
  const today=new Date(now).toISOString().slice(0,10);
  // Exclude the current UTC day so partial daily bars never masquerade as a completed session.
  const valid=(Array.isArray(bars)?bars:[])
    .filter(b=>String(b?.t||'').slice(0,10)<today&&NUM(b?.c)>0)
    .sort((a,b)=>String(a.t).localeCompare(String(b.t)));
  const closes=[...new Map(valid.map(b=>[String(b.t).slice(0,10),NUM(b.c)])).values()];
  const last=closes.at(-1)||null,live=NUM(price)>0?NUM(price):last;
  const week=closes.length>=5?pct(closes.at(-5),live):null;
  const month=closes.length>=21?pct(closes.at(-21),live):null;
  const series=closes.slice(-24);
  if(live>0)series.push(live);
  return {week_pct:week,month_pct:month,
    sparkline:series.map(x=>Number(x.toFixed(6))),
    completed_sessions:closes.length};
}
export function moverRiskFlags(row){
  const warnings=[];
  if(row.asset_class==='stock'){
    if(row.price<3)warnings.push('PENNY_STOCK');
    if(Math.abs(Number(row.day_pct||0))>=35)warnings.push('EXTREME_MOVE');
    if(row.source==='IEX_SNAPSHOT')warnings.push('IEX_COVERAGE_ONLY');
  }else if(row.asset_class==='crypto'){
    if(Math.abs(Number(row.day_pct||0))>=20)warnings.push('VOLATILE_COIN');
    warnings.push('ALPACA_LISTED_ONLY');
  }
  if(row.week_pct===null||row.month_pct===null)warnings.push('HISTORY_PARTIAL');
  return warnings;
}
export function rankMoverRows({market='stocks',providers=[],bars={},limit=100}={}){
  const bySymbol=new Map();
  for(const raw of providers){
    if(!raw?.symbol||!(NUM(raw.price)>0))continue;
    const symbol=cleanSymbol(raw.symbol);
    if(bySymbol.has(symbol))continue;
    const asset_class=market==='crypto'?'crypto':'stock';
    const history=computeMoverReturns(bars?.[symbol]||[],raw.price);
    const row={symbol,asset_class,price:NUM(raw.price),
      day_pct:NUM(raw.day_pct),week_pct:history.week_pct,month_pct:history.month_pct,
      day_change_dollars:NUM(raw.day_change_dollars),
      completed_sessions:history.completed_sessions,
      sparkline:history.sparkline,
      source:String(raw.provider||'UNKNOWN'),
      direction:String(raw.direction||''),
      // These are advisory flags, not pass/fail trading criteria.
      risk_flags:[]};
    row.risk_flags=moverRiskFlags(row);
    bySymbol.set(symbol,row);
  }
  return [...bySymbol.values()].slice(0,Math.max(1,Math.min(250,limit)));
}
export function screenMoverRows(rows=[],{window='1d',direction='gainers',limit=50}={}){
  const key=window==='1w'?'week_pct':window==='1m'?'month_pct':'day_pct';
  const descending=direction!=='losers';
  const eligible=(Array.isArray(rows)?rows:[]).filter(r=>Number.isFinite(r[key]));
  eligible.sort((a,b)=>descending?b[key]-a[key]:a[key]-b[key]);
  return eligible.slice(0,Math.max(1,Math.min(100,limit)));
}
export function momentSignal(previous,current){
  if(!previous||!current||previous.symbol!==current.symbol)return null;
  const minutes=(Date.parse(current.observed_at)-Date.parse(previous.observed_at))/60000;
  if(!(minutes>=3&&minutes<=60))return null;
  const before=NUM(previous.day_pct),after=NUM(current.day_pct);
  if(before===null||after===null)return null;
  const delta=after-before;
  if(current.asset_class==='stock'&&after>=2&&after<=18&&delta>=1.5)
    return {type:'INTRADAY_ACCELERATION_WATCH',delta_pct_points:Number(delta.toFixed(2)),minutes};
  if(current.asset_class==='crypto'&&after>=1.5&&after<=12&&delta>=1.2)
    return {type:'CRYPTO_ACCELERATION_WATCH',delta_pct_points:Number(delta.toFixed(2)),minutes};
  return null;
}
