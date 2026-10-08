// Research-only daily-bar challengers. No strategy writes orders.
const avg=rows=>rows.reduce((a,b)=>a+b,0)/(rows.length||1);
function rsi(closes,n=14){
  if(closes.length<=n)return null;
  let gains=0,losses=0;
  for(let j=closes.length-n;j<closes.length;j++){
    const d=closes[j]-closes[j-1];
    gains+=Math.max(0,d);losses+=Math.max(0,-d);
  }
  return losses===0?100:100-100/(1+gains/losses);
}
function signal(name,bars,i){
  // At i, all indicators must use bars preceding today's entry candle.
  if(i<55)return false;
  const hist=bars.slice(0,i);
  const closes=hist.map(b=>Number(b.c));
  const last=closes.at(-1);
  const ma20=avg(closes.slice(-20)),ma50=avg(closes.slice(-50));
  const priorHigh=Math.max(...hist.slice(-21,-1).map(b=>Number(b.h)));
  const rs=rsi(closes);
  if(!Number.isFinite(last)||!Number.isFinite(ma20)||!Number.isFinite(rs))return false;
  if(name==='TREND')return last>ma20&&ma20>ma50&&rs<75;
  if(name==='BREAKOUT')return last>priorHigh&&ma20>ma50&&rs<83;
  if(name==='PULLBACK')return ma20>ma50&&last<ma20&&last>ma50&&rs>=35&&rs<=52;
  if(name==='MEAN_REVERSION')return last<ma20*.97&&rs<35;
  return false;
}
export function simulateDailyStrategy(rawBars,name,{
  costBps=20,maxHoldBars=5,stopPct=.04,targetPct=.08
}={}){
  const bars=(Array.isArray(rawBars)?rawBars:[]).filter(b=>
    [b.o,b.h,b.l,b.c].every(v=>Number(v)>0&&Number.isFinite(Number(v))))
    .sort((a,b)=>new Date(a.t)-new Date(b.t));
  const trades=[];
  let nextEligible=55;
  for(let i=55;i<bars.length-1;i++){
    if(i<nextEligible||!signal(name,bars,i))continue;
    const entry=Number(bars[i].o);
    const stop=entry*(1-stopPct),target=entry*(1+targetPct);
    let exit=null,exitIndex=i,reason='time';
    const last=Math.min(bars.length-1,i+maxHoldBars-1);
    for(let j=i;j<=last;j++){
      const low=Number(bars[j].l),high=Number(bars[j].h);
      // Conservative: stop first if both stop and target touched.
      if(low<=stop){exit=stop;exitIndex=j;reason='stop';break}
      if(high>=target){exit=target;exitIndex=j;reason='target';break}
      if(j===last){exit=Number(bars[j].c);exitIndex=j;reason='time'}
    }
    if(!(exit>0))continue;
    const gross=exit/entry-1;
    const net=gross-costBps/10000;
    trades.push({
      entry_date:bars[i].t,exit_date:bars[exitIndex].t,
      gross_return:gross,estimated_net_return:net,exit_reason:reason
    });
    nextEligible=exitIndex+1;
  }
  return trades;
}
function summarize(rows){
  const n=rows.length;
  const returns=rows.map(t=>t.estimated_net_return);
  const gp=returns.filter(v=>v>0).reduce((a,b)=>a+b,0);
  const gl=-returns.filter(v=>v<0).reduce((a,b)=>a+b,0);
  return{
    trades:n,
    mean_net_return:n?avg(returns):null,
    win_rate:n?returns.filter(v=>v>0).length/n:null,
    profit_factor:gl>0?gp/gl:null,
    sum_net_return:n?returns.reduce((a,b)=>a+b,0):0
  };
}
export function runChallengerComparison(bars,{assetClass='equity'}={}){
  const cost=assetClass==='crypto'?40:20;
  const strategies=['TREND','BREAKOUT','PULLBACK','MEAN_REVERSION'];
  return strategies.map(name=>{
    const trades=simulateDailyStrategy(bars,name,{costBps:cost,
      stopPct:assetClass==='crypto' ? 0.06 : 0.04,targetPct:assetClass==='crypto' ? 0.12 : 0.08,
      maxHoldBars:assetClass==='crypto'?7:5
    });
    // Split in calendar-bar time, not by trade count: avoids leaking test-period signals.
    const cleanBars=[...(bars||[])].filter(b=>Number(b?.c)>0)
      .sort((a,b)=>new Date(a.t)-new Date(b.t));
    const boundary=cleanBars[Math.floor(cleanBars.length*.70)]?.t||'';
    const train=trades.filter(t=>String(t.entry_date)<String(boundary));
    const later=trades.filter(t=>String(t.entry_date)>=String(boundary));
    const m1=summarize(train),m2=summarize(later);
    const adequate=train.length>=12&&later.length>=6;
    const promising=adequate&&m1.mean_net_return>0&&m2.mean_net_return>0&&
      m1.profit_factor!=null&&m1.profit_factor>=1.15&&
      m2.profit_factor!=null&&m2.profit_factor>=1.15;
    return{
      strategy:name,asset_class:assetClass,state:!adequate?'NEEDS_MORE_TRADES':promising?'PAPER_RESEARCH_CANDIDATE':'NO_VALIDATED_EDGE',
      train:m1,validation:m2,overall:summarize(trades),
      cost_assumption_bps:cost,window_bars:cleanBars.length,
      validation_begins:boundary,auto_apply:false
    };
  });
}
