// Liquidity should be assessed from completed Alpaca daily crypto bars.
// Current UTC-day volume resets at midnight and can be almost zero for an
// otherwise liquid asset. Exclude today's incomplete bar and use a robust median.
export function completedCryptoDollarVolume(bars=[],now=new Date()){
  const day=new Date(now).toISOString().slice(0,10);
  const days=new Map();
  for(const bar of Array.isArray(bars)?bars:[]){
    const date=String(bar?.t||'').slice(0,10);
    const close=Number(bar?.c),volume=Number(bar?.v);
    if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||date>=day)continue;
    if(!(close>0)||!(volume>=0)||!Number.isFinite(volume))continue;
    days.set(date,close*volume);
  }
  const recent=[...days].sort(([a],[b])=>a.localeCompare(b)).slice(-7);
  const values=recent.map(([,value])=>value).sort((a,b)=>a-b);
  const n=values.length;
  const estimate=n>=3?
    (n%2?values[Math.floor(n/2)]:(values[n/2-1]+values[n/2])/2):null;
  return {
    dollar_volume:estimate==null?null:Number(estimate.toFixed(2)),
    completed_days:n,
    source:n>=3?'median_completed_daily_usd_volume_7d':'insufficient_completed_crypto_daily_bars',
    recent_day_values:recent.map(([date,dollars])=>({date,dollars:Number(dollars.toFixed(2))}))
  };
}
