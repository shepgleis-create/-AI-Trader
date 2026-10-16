// Execution-aware SHORTLIST ranking for the paper stock bot.
// A scanner score is NOT a calibrated probability of winning.
function num(value, fallback=null){
  if(value===null||value===undefined||value==='')return fallback;
  const n=Number(value);
  return Number.isFinite(n)?n:fallback;
}
function clamp(value,min,max){return Math.max(min,Math.min(max,value))}

export function equityOpportunityQuality(candidate){
  const score=num(candidate?.score,0);
  const notes=[];
  let adjustment=0;

  const spread=num(candidate?.spread_pct);
  if(spread===null){adjustment-=3;notes.push('unknown spread')}
  else if(spread>0.005){adjustment-=12;notes.push('wide spread')}
  else if(spread>0.0025){adjustment-=5;notes.push('costly spread')}
  else if(spread<=0.001){adjustment+=3;notes.push('tight spread')}

  const age=num(candidate?.data_age_seconds);
  if(age===null){adjustment-=2;notes.push('unknown quote age')}
  else if(age>900){adjustment-=12;notes.push('stale scanner quote')}
  else if(age<=180){adjustment+=2;notes.push('recent quote')}

  const rs=num(candidate?.rs_percentile);
  if(rs!==null){
    if(rs>=0.9){adjustment+=4;notes.push('top-decile relative strength')}
    else if(rs>=0.75){adjustment+=2;notes.push('high relative strength')}
    else if(rs<0.5){adjustment-=6;notes.push('below-median relative strength')}
  }

  const liquidity=num(candidate?.avg_dollar_volume_20d);
  if(liquidity!==null){
    if(liquidity>=100_000_000)adjustment+=2;
    else if(liquidity<10_000_000){adjustment-=6;notes.push('thin liquidity')}
  }

  const atr=num(candidate?.atr_pct);
  if(atr!==null){
    if(atr>0.10){adjustment-=8;notes.push('high ATR')}
    else if(atr>0.07){adjustment-=3;notes.push('elevated ATR')}
  }

  const historical=candidate?.historical_edge||{};
  const samples=num(historical.samples,0);
  const avg=num(historical.avg_5d_return),win=num(historical.win_rate);
  // Historical analogs are weak evidence: small and tightly capped adjustment.
  if(samples>=12&&avg!==null&&win!==null){
    if(avg>0.01&&win>=0.55){adjustment+=3;notes.push('favorable analogs (unverified)')}
    else if(avg<=-0.005&&win<0.4){adjustment-=6;notes.push('unfavorable analogs')}
  }

  const gap=num(candidate?.gap_pct);
  if(gap!==null&&Math.abs(gap)>=0.10){adjustment-=6;notes.push('extreme gap')}

  return {
    symbol:String(candidate?.symbol||''),
    scanner_score:score,
    rank_score:Number((score+clamp(adjustment,-35,16)).toFixed(2)),
    execution_quality_notes:notes,
    historical_samples:samples,
    advisory_only:true
  };
}

export function rankEquityShortlist(candidates=[],{
  entryThreshold=82,held=new Set(),ordered=new Set(),
  recentlyTradedSymbols=new Set(),limit=5
}={}){
  const floor=Math.max(68,Number(entryThreshold)-10);
  const heldSet=new Set(held||[]),orderedSet=new Set(ordered||[]);
  const cooldownSet=new Set(recentlyTradedSymbols||[]);
  const eligible=(Array.isArray(candidates)?candidates:[])
    .filter(c=>c&&Number.isFinite(Number(c.score))&&Number(c.score)>=floor&&
      typeof c.symbol==='string'&&c.symbol&&!heldSet.has(c.symbol)&&
      !orderedSet.has(c.symbol)&&!cooldownSet.has(c.symbol))
    .map(c=>({...c,opportunity_quality:equityOpportunityQuality(c)}));
  eligible.sort((a,b)=>
    b.opportunity_quality.rank_score-a.opportunity_quality.rank_score||
    b.score-a.score||
    Number(b.avg_dollar_volume_20d||0)-Number(a.avg_dollar_volume_20d||0)||
    a.symbol.localeCompare(b.symbol)
  );
  return eligible.slice(0,clamp(Number(limit)||5,1,12));
}
