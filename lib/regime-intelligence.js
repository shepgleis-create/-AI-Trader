const LANES=['LONG_EQUITY','SHORT_EQUITY','CRYPTO_LONG','LONG_CALL','LONG_PUT'];

function n(v){
  const x=Number(v);
  return Number.isFinite(x)?x:null;
}
function clamp(v,min,max){return Math.max(min,Math.min(max,v))}
function avg(xs){
  const vals=(xs||[]).map(n).filter(Number.isFinite);
  return vals.length?vals.reduce((a,b)=>a+b,0)/vals.length:null;
}
function rate(xs){
  const vals=(xs||[]).map(n).filter(Number.isFinite);
  return vals.length?vals.filter(x=>x>0).length/vals.length:null;
}
function round(v,d=3){
  const x=n(v);
  if(x==null)return null;
  const p=10**d;
  return Math.round(x*p)/p;
}

export function classifyMarketRegime(regime={}){
  const label=String(regime?.label||'UNKNOWN').toUpperCase();
  const volatility=n(regime?.volatility);
  const advance=n(regime?.breadth?.advance_ratio);
  const above20=n(regime?.participation?.pct_above_sma20);
  const above50=n(regime?.participation?.pct_above_sma50);
  const spy20=n(regime?.spy_20d);

  let volatility_bucket='NORMAL_VOL';
  if(volatility!=null&&volatility>=0.35)volatility_bucket='HIGH_VOL';
  else if(volatility!=null&&volatility<=0.14)volatility_bucket='LOW_VOL';

  let breadth_bucket='MIXED_BREADTH';
  if(advance!=null&&advance>=0.62&&above50!=null&&above50>=0.55)breadth_bucket='BROAD';
  else if(advance!=null&&advance<=0.38&&above50!=null&&above50<=0.42)breadth_bucket='WEAK';
  else if(above20!=null&&above50!=null&&above20>=0.62&&above50>=0.55)breadth_bucket='BROAD';
  else if(above20!=null&&above50!=null&&above20<=0.38&&above50<=0.40)breadth_bucket='WEAK';

  let state='UNKNOWN';
  if(label==='RISK_ON'){
    state=breadth_bucket==='BROAD'?'RISK_ON_BROAD':
      breadth_bucket==='WEAK'?'RISK_ON_NARROW':'RISK_ON_MIXED';
  }else if(label==='RISK_OFF'){
    state=(volatility_bucket==='HIGH_VOL'||breadth_bucket==='WEAK')
      ?'RISK_OFF_STRESS':'RISK_OFF';
  }else if(label==='NEUTRAL'){
    if(volatility_bucket==='HIGH_VOL')state='NEUTRAL_HIGH_VOL';
    else if(breadth_bucket==='BROAD'&&(spy20??0)>=0)state='NEUTRAL_BULLISH';
    else if(breadth_bucket==='WEAK'&&(spy20??0)<=0)state='NEUTRAL_BEARISH';
    else state='NEUTRAL_CHOP';
  }

  return {
    state,
    coarse:label,
    volatility_bucket,
    breadth_bucket,
    volatility:round(volatility,4),
    advance_ratio:round(advance,4),
    pct_above_sma20:round(above20,4),
    pct_above_sma50:round(above50,4),
    spy_20d:round(spy20,4),
    sector_leaders:Array.isArray(regime?.sector_leaders)?regime.sector_leaders.slice(0,3):[],
    sector_laggards:Array.isArray(regime?.sector_laggards)?regime.sector_laggards.slice(0,3):[]
  };
}

function regimeMatches(current,past){
  const p=classifyMarketRegime(past||{});
  return {
    exact:p.state===current.state,
    coarse:p.coarse===current.coarse
  };
}

function laneOutcomeRows(rows,lane,horizonKey){
  const out=[];
  for(const row of rows||[]){
    const h=row?.outcome?.[horizonKey];
    if(!h||typeof h!=='object')continue;
    const raw=h?.lane_returns?.[lane];
    if(raw===null||raw===undefined||raw==='')continue;
    const value=Number(raw);
    if(Number.isFinite(value))out.push(value);
  }
  return out;
}

function summarizePrior(rows,lane){
  const d1=laneOutcomeRows(rows,lane,'d1');
  const d5=laneOutcomeRows(rows,lane,'d5');
  return {
    samples_1d:d1.length,
    avg_1d:round(avg(d1),4),
    positive_rate_1d:round(rate(d1),4),
    samples_5d:d5.length,
    avg_5d:round(avg(d5),4),
    positive_rate_5d:round(rate(d5),4)
  };
}

function priorAdjustment(stats={}){
  const n1=Number(stats.samples_1d||0);
  const n5=Number(stats.samples_5d||0);
  if(n1<5&&n5<3)return 0;

  let raw=0;
  if(stats.avg_1d!=null)raw+=clamp(stats.avg_1d*220,-5,5);
  if(stats.positive_rate_1d!=null)raw+=clamp((stats.positive_rate_1d-.5)*12,-3,3);
  if(stats.avg_5d!=null)raw+=clamp(stats.avg_5d*90,-4,4);
  if(stats.positive_rate_5d!=null)raw+=clamp((stats.positive_rate_5d-.5)*8,-2,2);

  const confidence=clamp(Math.max(n1/20,n5/12),0,1);
  return round(clamp(raw*confidence,-12,12),2);
}

export function buildHistoricalRegimePriors(regime,routerRows=[]){
  const current=classifyMarketRegime(regime);
  const exact=[],coarse=[];

  for(const row of Array.isArray(routerRows)?routerRows:[]){
    const past=row?.meta?.long_regime;
    if(!past)continue;
    const m=regimeMatches(current,past);
    if(m.exact)exact.push(row);
    if(m.coarse)coarse.push(row);
  }

  const useExact=exact.length>=10;
  const source=useExact?exact:coarse;
  const source_level=useExact?'EXACT_STATE':(coarse.length?'COARSE_REGIME':'GLOBAL_FALLBACK');
  const rows=source.length?source:(Array.isArray(routerRows)?routerRows:[]);

  const lanes={};
  for(const lane of LANES){
    const stats=summarizePrior(rows,lane);
    lanes[lane]={
      ...stats,
      score_adjustment:priorAdjustment(stats)
    };
  }

  return {
    current,
    source_level,
    matching_decisions:rows.length,
    lanes
  };
}

function genericRegimeAdjustment(state,lane){
  const map={
    RISK_ON_BROAD:{LONG_EQUITY:6,SHORT_EQUITY:-6,CRYPTO_LONG:3,LONG_CALL:4,LONG_PUT:-5},
    RISK_ON_MIXED:{LONG_EQUITY:3,SHORT_EQUITY:-3,CRYPTO_LONG:1,LONG_CALL:2,LONG_PUT:-3},
    RISK_ON_NARROW:{LONG_EQUITY:1,SHORT_EQUITY:-1,CRYPTO_LONG:-2,LONG_CALL:-1,LONG_PUT:-1},
    RISK_OFF_STRESS:{LONG_EQUITY:-8,SHORT_EQUITY:7,CRYPTO_LONG:-7,LONG_CALL:-8,LONG_PUT:6},
    RISK_OFF:{LONG_EQUITY:-5,SHORT_EQUITY:5,CRYPTO_LONG:-4,LONG_CALL:-5,LONG_PUT:4},
    NEUTRAL_HIGH_VOL:{LONG_EQUITY:-2,SHORT_EQUITY:-1,CRYPTO_LONG:-4,LONG_CALL:-4,LONG_PUT:-3},
    NEUTRAL_BULLISH:{LONG_EQUITY:3,SHORT_EQUITY:-3,CRYPTO_LONG:1,LONG_CALL:2,LONG_PUT:-3},
    NEUTRAL_BEARISH:{LONG_EQUITY:-3,SHORT_EQUITY:3,CRYPTO_LONG:-2,LONG_CALL:-3,LONG_PUT:2},
    NEUTRAL_CHOP:{LONG_EQUITY:-1,SHORT_EQUITY:-1,CRYPTO_LONG:-2,LONG_CALL:-4,LONG_PUT:-4},
    UNKNOWN:{LONG_EQUITY:0,SHORT_EQUITY:0,CRYPTO_LONG:0,LONG_CALL:-2,LONG_PUT:-2}
  };
  return Number(map[state]?.[lane]||0);
}

function baseQuality(laneName,lane){
  if(!lane)return {blocked:true,score:0,reasons:['Lane unavailable']};

  if(laneName==='LONG_EQUITY'){
    return {blocked:false,score:clamp(Number(lane.score||0),0,100),reasons:[]};
  }
  if(laneName==='SHORT_EQUITY'){
    if(lane.paper_short_eligible!==true)return {blocked:true,score:0,reasons:['Not easy-to-borrow / short eligible']};
    if(String(lane.squeeze_risk||'').toUpperCase()==='HIGH')return {blocked:true,score:0,reasons:['High squeeze risk']};
    return {blocked:false,score:clamp(Number(lane.score||0),0,100),reasons:[]};
  }
  if(laneName==='CRYPTO_LONG'){
    if(String(lane.pump_dump_risk||'').toUpperCase()==='HIGH')return {blocked:true,score:0,reasons:['High pump/dump risk']};
    return {blocked:false,score:clamp(Number(lane.score||0),0,100),reasons:[]};
  }
  if(laneName==='LONG_CALL'||laneName==='LONG_PUT'){
    return {blocked:false,score:clamp(Number(lane.quality_score||0),0,100),reasons:[]};
  }
  return {blocked:true,score:0,reasons:['Unsupported lane']};
}

function executionAdjustment(laneName,lane){
  let adj=0;
  const reasons=[];
  const spread=n(lane?.spread_pct);

  if(laneName==='LONG_CALL'||laneName==='LONG_PUT'){
    if(spread!=null&&spread<=0.04){adj+=3;reasons.push('Tight option spread')}
    else if(spread!=null&&spread>=0.10){adj-=7;reasons.push('Wide option spread')}

    const mid=n(lane?.mid);
    const theta=n(lane?.theta);
    if(mid&&mid>0&&theta!=null){
      const drag=Math.abs(theta)/mid;
      if(drag>=0.06){adj-=6;reasons.push('Heavy theta drag')}
      else if(drag<=0.025){adj+=2;reasons.push('Manageable theta drag')}
    }
    const iv=n(lane?.implied_volatility);
    if(iv!=null&&iv>=1.20){adj-=5;reasons.push('Very high implied volatility')}
    const dte=n(lane?.dte);
    if(dte!=null&&dte>=14&&dte<=35){adj+=2;reasons.push('Constructive DTE window')}
  }else{
    if(spread!=null&&spread<=0.0015){adj+=3;reasons.push('Tight spread')}
    else if(spread!=null&&spread>0.005){adj-=7;reasons.push('Wide spread')}
  }

  if(laneName==='CRYPTO_LONG'){
    if(String(lane?.pump_dump_risk||'').toUpperCase()==='MEDIUM'){adj-=5;reasons.push('Medium pump risk')}
    const vol=n(lane?.volatility_14d);
    if(vol!=null&&vol>=1.50){adj-=6;reasons.push('Extreme crypto volatility')}
  }

  return {adjustment:adj,reasons};
}

function aiAdjustment(laneName,aiDecision={}){
  const action=String(aiDecision?.action||'SKIP');
  const confidence=clamp(Number(aiDecision?.confidence||0),0,100);
  if(action==='SKIP')return -2;
  if(action!==laneName)return 0;
  if(confidence>=90)return 8;
  if(confidence>=80)return 6;
  if(confidence>=70)return 4;
  if(confidence>=60)return 2;
  return 1;
}

function laneIdentity(laneName,lane){
  if(laneName==='LONG_CALL'||laneName==='LONG_PUT'){
    return {
      symbol:lane?.underlying||'',
      contract:lane?.contract||''
    };
  }
  return {
    symbol:lane?.symbol||'',
    contract:''
  };
}

export function buildRegimeEnsemble({
  regime={},
  lanes={},
  aiDecision={},
  historicalRows=[]
}={}){
  const priors=buildHistoricalRegimePriors(regime,historicalRows);
  const state=priors.current.state;
  const scored=[];

  for(const laneName of LANES){
    const lane=lanes?.[laneName];
    if(!lane)continue;

    const base=baseQuality(laneName,lane);
    if(base.blocked){
      scored.push({
        lane:laneName,blocked:true,score:0,
        reasons:base.reasons
      });
      continue;
    }

    const regimeAdj=genericRegimeAdjustment(state,laneName);
    const historyAdj=Number(priors.lanes?.[laneName]?.score_adjustment||0);
    const exec=executionAdjustment(laneName,lane);
    const aiAdj=aiAdjustment(laneName,aiDecision);

    const score=clamp(
      base.score+
      regimeAdj+
      historyAdj+
      exec.adjustment+
      aiAdj,
      0,100
    );

    scored.push({
      lane:laneName,
      blocked:false,
      score:round(score,1),
      base_score:round(base.score,1),
      regime_adjustment:regimeAdj,
      historical_adjustment:historyAdj,
      execution_adjustment:exec.adjustment,
      ai_adjustment:aiAdj,
      historical_prior:priors.lanes?.[laneName]||null,
      reasons:[
        ...base.reasons,
        ...exec.reasons
      ]
    });
  }

  const eligible=scored
    .filter(x=>!x.blocked)
    .sort((a,b)=>b.score-a.score);
  const top=eligible[0]||null;
  const second=eligible[1]||null;
  const margin=top&&second?top.score-second.score:(top?top.score:0);
  const thinHistory=priors.matching_decisions<10;

  let action=top?.lane||'SKIP';
  let skipReason=null;
  if(!top){
    action='SKIP';
    skipReason='No eligible lane survived deterministic checks.';
  }else if(top.score<70){
    action='SKIP';
    skipReason=`Best ensemble score ${top.score} is below 70.`;
  }else if(second&&margin<(thinHistory?7:5)&&top.score<86){
    action='SKIP';
    skipReason=`Top lanes are too close (${margin.toFixed(1)}-point margin).`;
  }

  const lane=action==='SKIP'?null:lanes?.[action];
  const id=laneIdentity(action,lane);
  const disagreement=action!=='SKIP'&&
    aiDecision?.action&&aiDecision.action!=='SKIP'&&
    aiDecision.action!==action;

  const confidence=action==='SKIP'
    ?clamp(Math.round(55+(skipReason?10:0)),0,100)
    :clamp(Math.round((top?.score||0)+(margin>=10?4:0)-(thinHistory?4:0)),0,100);

  return {
    decision:{
      action,
      symbol:id.symbol,
      contract:id.contract,
      confidence,
      rationale:action==='SKIP'
        ?`Regime ensemble abstained: ${skipReason||'evidence was not strong enough.'}`
        :`Regime ensemble selected ${action} with score ${top.score}; market state ${state}, margin ${margin.toFixed(1)} points.`
    },
    regime:priors.current,
    prior_source:priors.source_level,
    matching_historical_decisions:priors.matching_decisions,
    historical_priors:priors.lanes,
    lane_scores:scored,
    top_margin:round(margin,1),
    thin_history:thinHistory,
    disagrees_with_ai:Boolean(disagreement),
    ai_action:String(aiDecision?.action||'SKIP')
  };
}
