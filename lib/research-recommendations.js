function num(v){
  const x=Number(v);
  return Number.isFinite(x)?x:null;
}
function avg(values){
  const xs=values.map(num).filter(Number.isFinite);
  return xs.length?xs.reduce((a,b)=>a+b,0)/xs.length:null;
}
function rate(values){
  const xs=values.filter(v=>v===true||v===false);
  return xs.length?xs.filter(Boolean).length/xs.length:null;
}
function round(v,d=4){
  const x=num(v);
  if(x==null)return null;
  const p=10**d;
  return Math.round(x*p)/p;
}
function splitChronological(rows,minTotal=20){
  const xs=[...(rows||[])].sort((a,b)=>new Date(a.created_at)-new Date(b.created_at));
  if(xs.length<minTotal)return {enough:false,total:xs.length,train:[],validation:[]};
  const cut=Math.max(1,Math.min(xs.length-1,Math.floor(xs.length*.65)));
  const train=xs.slice(0,cut),validation=xs.slice(cut);
  return {
    enough:train.length>=12&&validation.length>=6,
    total:xs.length,train,validation
  };
}
function horizon(row,key='d1'){
  const o=row?.outcome;
  return o&&typeof o==='object'?o[key]||null:null;
}
function routerMetrics(rows,key='d1'){
  const hs=(rows||[]).map(r=>horizon(r,key)).filter(Boolean);
  return {
    samples:hs.length,
    avg_chosen_return:round(avg(hs.map(x=>x.chosen_return))),
    avg_opportunity_cost:round(avg(hs.map(x=>x.opportunity_cost))),
    selected_best_rate:round(rate(hs.map(x=>x.selected_best)))
  };
}
function scannerMetrics(rows,key='outcome_1d'){
  const xs=(rows||[]).map(r=>num(r?.[key])).filter(Number.isFinite);
  return {
    samples:xs.length,
    avg_return:round(avg(xs)),
    positive_rate:round(xs.length?xs.filter(x=>x>0).length/xs.length:null)
  };
}
function statusCard(id,category,title,status,proposedChange,rationale,train,validation,extra={}){
  return {
    id,category,title,status,
    proposed_change:proposedChange,
    rationale,
    train,validation,
    auto_apply:false,
    ...extra
  };
}
function badRouterMetrics(m){
  if(!m||m.samples<1)return false;
  return (m.selected_best_rate!=null&&m.selected_best_rate<.45)||
    (m.avg_opportunity_cost!=null&&m.avg_opportunity_cost>.015)||
    (m.avg_chosen_return!=null&&m.avg_chosen_return<0);
}

function routerSelectivity(rows){
  const split=splitChronological(rows,20);
  if(!split.enough){
    return statusCard(
      'router-selectivity','ROUTER','Router selectivity',
      'WAIT_FOR_DATA',
      'Keep current Router behavior.',
      'At least 20 graded decisions with a later validation slice are required before testing a stricter SKIP bias.',
      routerMetrics(split.train),routerMetrics(split.validation),
      {minimum_sample:20,current_sample:split.total}
    );
  }
  const train=routerMetrics(split.train),validation=routerMetrics(split.validation);
  const trainBad=badRouterMetrics(train),valBad=badRouterMetrics(validation);

  if(trainBad&&valBad){
    return statusCard(
      'router-selectivity','ROUTER','Router selectivity',
      'SUPPORTED_FOR_FURTHER_TESTING',
      'Test a stricter non-SKIP gate in research, starting with a 75 Router-conviction floor or an equivalent SKIP bias.',
      'Both the earlier training slice and later validation slice show weak lane selection, negative chosen returns, or meaningful opportunity cost.',
      train,validation,
      {minimum_sample:20,current_sample:split.total}
    );
  }
  if(trainBad&&!valBad){
    return statusCard(
      'router-selectivity','ROUTER','Router selectivity',
      'CONTRADICTED',
      'Do not tighten Router selectivity yet.',
      'The earlier sample looked weak, but the later validation sample did not confirm the same problem.',
      train,validation,
      {minimum_sample:20,current_sample:split.total}
    );
  }
  return statusCard(
    'router-selectivity','ROUTER','Router selectivity',
    'NO_CHANGE',
    'Keep current Router selectivity while more evidence accumulates.',
    'The later validation sample does not currently support a stricter global SKIP bias.',
    train,validation,
    {minimum_sample:20,current_sample:split.total}
  );
}

function confidenceFloor(rows){
  const graded=(rows||[]).filter(r=>num(r.confidence)!=null&&horizon(r,'d1'));
  const split=splitChronological(graded,30);
  if(!split.enough){
    return statusCard(
      'router-confidence-floor','CALIBRATION','Router confidence floor',
      'WAIT_FOR_DATA',
      'Do not add a confidence floor yet.',
      'At least 30 graded decisions are required so both lower- and higher-confidence groups can be checked on later data.',
      {samples:split.train.length},{samples:split.validation.length},
      {minimum_sample:30,current_sample:split.total}
    );
  }

  let best=null;
  for(const threshold of [70,75,80,85,90]){
    const trainLow=split.train.filter(r=>num(r.confidence)<threshold);
    const trainHigh=split.train.filter(r=>num(r.confidence)>=threshold);
    const valLow=split.validation.filter(r=>num(r.confidence)<threshold);
    const valHigh=split.validation.filter(r=>num(r.confidence)>=threshold);
    if(Math.min(trainLow.length,trainHigh.length,valLow.length,valHigh.length)<5)continue;

    const a=routerMetrics(trainLow),b=routerMetrics(trainHigh);
    const c=routerMetrics(valLow),d=routerMetrics(valHigh);
    const trainBestGain=(b.selected_best_rate??0)-(a.selected_best_rate??0);
    const valBestGain=(d.selected_best_rate??0)-(c.selected_best_rate??0);
    const trainOppGain=(a.avg_opportunity_cost??0)-(b.avg_opportunity_cost??0);
    const valOppGain=(c.avg_opportunity_cost??0)-(d.avg_opportunity_cost??0);
    const trainReturnGain=(b.avg_chosen_return??0)-(a.avg_chosen_return??0);
    const valReturnGain=(d.avg_chosen_return??0)-(c.avg_chosen_return??0);

    const trainSupports=trainBestGain>=.08||trainOppGain>=.0075||trainReturnGain>=.005;
    const valSupports=valBestGain>=.08||valOppGain>=.0075||valReturnGain>=.005;
    const score=(trainBestGain+valBestGain)+(trainOppGain+valOppGain)*5+(trainReturnGain+valReturnGain)*3;
    const candidate={threshold,trainLow:a,trainHigh:b,valLow:c,valHigh:d,trainSupports,valSupports,score};
    if(!best||candidate.score>best.score)best=candidate;
  }

  if(!best){
    return statusCard(
      'router-confidence-floor','CALIBRATION','Router confidence floor',
      'WAIT_FOR_DATA',
      'Keep confidence observational only.',
      'There are not yet enough decisions on both sides of a candidate confidence threshold.',
      {samples:split.train.length},{samples:split.validation.length},
      {minimum_sample:30,current_sample:split.total}
    );
  }

  const train={below:best.trainLow,at_or_above:best.trainHigh};
  const validation={below:best.valLow,at_or_above:best.valHigh};

  if(best.trainSupports&&best.valSupports){
    return statusCard(
      'router-confidence-floor','CALIBRATION','Router confidence floor',
      'SUPPORTED_FOR_FURTHER_TESTING',
      `Test a research-only Router confidence floor of ${best.threshold} before allowing a non-SKIP selection.`,
      'Higher-confidence decisions outperform lower-confidence decisions in both the earlier and later samples on at least one selection-quality metric.',
      train,validation,
      {proposed_threshold:best.threshold,minimum_sample:30,current_sample:split.total}
    );
  }
  if(best.trainSupports&&!best.valSupports){
    return statusCard(
      'router-confidence-floor','CALIBRATION','Router confidence floor',
      'CONTRADICTED',
      'Do not add a confidence floor from the current sample.',
      'The training slice suggested a confidence effect, but later validation did not confirm it.',
      train,validation,
      {proposed_threshold:best.threshold,minimum_sample:30,current_sample:split.total}
    );
  }
  return statusCard(
    'router-confidence-floor','CALIBRATION','Router confidence floor',
    'NO_CHANGE',
    'Keep confidence as descriptive context rather than a hard gate.',
    'Higher model confidence is not consistently associated with better later outcomes yet.',
    train,validation,
    {minimum_sample:30,current_sample:split.total}
  );
}

function laneRecommendations(rows){
  const lanes=['LONG_EQUITY','SHORT_EQUITY','CRYPTO_LONG','LONG_CALL','LONG_PUT','SKIP'];
  const results=[];
  for(const lane of lanes){
    const laneRows=(rows||[]).filter(r=>String(r.selected_lane||'')===lane&&horizon(r,'d1'));
    const split=splitChronological(laneRows,16);
    if(!split.enough)continue;
    const train=routerMetrics(split.train),validation=routerMetrics(split.validation);
    const trainWeak=(train.avg_chosen_return??0)<0||(train.avg_opportunity_cost??0)>.02;
    const valWeak=(validation.avg_chosen_return??0)<0||(validation.avg_opportunity_cost??0)>.02;
    if(trainWeak&&valWeak){
      results.push(statusCard(
        `lane-${lane.toLowerCase()}`,'LANE',`${lane} selection quality`,
        'SUPPORTED_FOR_FURTHER_TESTING',
        lane==='SKIP'
          ?'Test reducing SKIP bias only in a research branch; do not change production behavior yet.'
          :`Test de-emphasizing ${lane} in the Router or requiring stronger lane-specific evidence.`,
        'This lane shows weak chosen returns or elevated opportunity cost in both chronological samples.',
        train,validation,
        {lane,minimum_sample:16,current_sample:split.total}
      ));
    }else if(trainWeak&&!valWeak){
      results.push(statusCard(
        `lane-${lane.toLowerCase()}`,'LANE',`${lane} selection quality`,
        'CONTRADICTED',
        `Do not change ${lane} weighting from the current sample.`,
        'The earlier sample looked weak, but later validation improved.',
        train,validation,
        {lane,minimum_sample:16,current_sample:split.total}
      ));
    }
  }
  return results;
}

function scannerThreshold(scannerRows){
  const rows=(scannerRows||[]).filter(r=>num(r.scanner_score)!=null&&num(r.outcome_1d)!=null);
  const split=splitChronological(rows,40);
  if(!split.enough){
    return statusCard(
      'long-scanner-threshold','SCANNER','Long-equity scanner threshold',
      'WAIT_FOR_DATA',
      'Keep the current long-equity entry thresholds fixed.',
      'At least 40 graded scanner candidates are required before testing a score-floor change with a later validation slice.',
      scannerMetrics(split.train),scannerMetrics(split.validation),
      {minimum_sample:40,current_sample:split.total}
    );
  }

  let best=null;
  for(const threshold of [82,84,86,88,90,92,94]){
    const ta=split.train.filter(r=>num(r.scanner_score)<threshold);
    const tb=split.train.filter(r=>num(r.scanner_score)>=threshold);
    const va=split.validation.filter(r=>num(r.scanner_score)<threshold);
    const vb=split.validation.filter(r=>num(r.scanner_score)>=threshold);
    if(Math.min(ta.length,tb.length,va.length,vb.length)<7)continue;
    const mta=scannerMetrics(ta),mtb=scannerMetrics(tb),mva=scannerMetrics(va),mvb=scannerMetrics(vb);
    const trainGain=(mtb.avg_return??0)-(mta.avg_return??0);
    const valGain=(mvb.avg_return??0)-(mva.avg_return??0);
    const trainPos=(mtb.positive_rate??0)-(mta.positive_rate??0);
    const valPos=(mvb.positive_rate??0)-(mva.positive_rate??0);
    const trainSupports=trainGain>=.004||trainPos>=.08;
    const valSupports=valGain>=.004||valPos>=.08;
    const score=trainGain+valGain+(trainPos+valPos)*.03;
    const candidate={threshold,trainLow:mta,trainHigh:mtb,valLow:mva,valHigh:mvb,trainSupports,valSupports,score};
    if(!best||candidate.score>best.score)best=candidate;
  }

  if(!best){
    return statusCard(
      'long-scanner-threshold','SCANNER','Long-equity scanner threshold',
      'WAIT_FOR_DATA',
      'Keep current scanner floors.',
      'There are not enough graded candidates on both sides of a useful score threshold.',
      scannerMetrics(split.train),scannerMetrics(split.validation),
      {minimum_sample:40,current_sample:split.total}
    );
  }

  const train={below:best.trainLow,at_or_above:best.trainHigh};
  const validation={below:best.valLow,at_or_above:best.valHigh};
  if(best.trainSupports&&best.valSupports){
    return statusCard(
      'long-scanner-threshold','SCANNER','Long-equity scanner threshold',
      'SUPPORTED_FOR_FURTHER_TESTING',
      `Test a research entry floor near scanner score ${best.threshold}; keep the production floor unchanged until a dedicated walk-forward comparison passes.`,
      'Higher-scoring candidates outperform lower-scoring candidates in both chronological samples.',
      train,validation,
      {proposed_threshold:best.threshold,minimum_sample:40,current_sample:split.total}
    );
  }
  if(best.trainSupports&&!best.valSupports){
    return statusCard(
      'long-scanner-threshold','SCANNER','Long-equity scanner threshold',
      'CONTRADICTED',
      'Do not raise the production scanner threshold.',
      'The training relationship between score and later return did not persist in validation.',
      train,validation,
      {proposed_threshold:best.threshold,minimum_sample:40,current_sample:split.total}
    );
  }
  return statusCard(
    'long-scanner-threshold','SCANNER','Long-equity scanner threshold',
    'NO_CHANGE',
    'Keep the current score floor.',
    'The graded sample does not show a stable improvement from using a higher scanner score.',
    train,validation,
    {minimum_sample:40,current_sample:split.total}
  );
}

function dataHealth(routerRows,scannerRows){
  const router1d=(routerRows||[]).filter(r=>horizon(r,'d1')).length;
  const router5d=(routerRows||[]).filter(r=>horizon(r,'d5')).length;
  const scanner1d=(scannerRows||[]).filter(r=>num(r.outcome_1d)!=null).length;
  return {
    router_1d:router1d,
    router_5d:router5d,
    scanner_1d:scanner1d,
    readiness:
      router1d>=30&&scanner1d>=40
        ?'CALIBRATION_READY'
        :router1d>=20||scanner1d>=25
          ?'BUILDING'
          :'EARLY'
  };
}

export function buildAdaptiveRecommendations(dataset={}){
  const router=Array.isArray(dataset.router)?dataset.router:[];
  const scanner=Array.isArray(dataset.scanner)?dataset.scanner:[];
  const recommendations=[
    routerSelectivity(router),
    confidenceFloor(router),
    scannerThreshold(scanner),
    ...laneRecommendations(router)
  ];

  const priority={SUPPORTED_FOR_FURTHER_TESTING:0,CONTRADICTED:1,WAIT_FOR_DATA:2,NO_CHANGE:3};
  recommendations.sort((a,b)=>(priority[a.status]??9)-(priority[b.status]??9));

  return {
    generated_at:new Date().toISOString(),
    auto_apply:false,
    methodology:{
      split:'Chronological 65% training / 35% later validation',
      principle:'A recommendation is supported only when the direction persists in the later validation slice.',
      caveat:'Observational paper/shadow evidence can guide further testing but does not prove future profitability.'
    },
    data_health:dataHealth(router,scanner),
    recommendations
  };
}
