// Independent, explainable research lenses. No orders, no invented fundamentals.
const finite=v=>v!==null&&v!==undefined&&v!==''&&Number.isFinite(Number(v));
const n=v=>finite(v)?Number(v):null;
export function assessResearchCandidate(candidate={},headlines=[]){
  const symbol=String(candidate.symbol||'');
  const score=n(candidate.score);
  const m20=n(candidate.momentum_20d);
  const m7=n(candidate.momentum_7d);
  const risk=String(candidate.pump_dump_risk||'').toUpperCase();
  const technical={
    status:score===null?'INSUFFICIENT_DATA':score>=75?'STRONG_SCREEN':'WATCH',
    evidence:{scanner_score:score,momentum_20d:m20,momentum_7d:m7}
  };
  const event={
    status:Array.isArray(headlines)&&headlines.length?'HEADLINES_AVAILABLE':'NO_VERIFIED_HEADLINES',
    evidence:{headline_count:Array.isArray(headlines)?headlines.length:0},
    warning:'Headline count is not a sentiment or causal impact score.'
  };
  const riskLens={
    status:/HIGH|SEVERE|EXTREME/.test(risk)?'CAUTION':'NOT_FLAGGED',
    evidence:{pump_dump_risk:risk||null},
    warning:'Unflagged does not mean safe; liquidity and execution costs remain unverified.'
  };
  const fundamentals={status:'NOT_EVALUATED',reason:'No verified filings or fundamentals supplied to this research pass.'};
  const macro={status:'NOT_EVALUATED',reason:'No verified macroeconomic series supplied to this research pass.'};
  const blockers=[...(technical.status==='INSUFFICIENT_DATA'?['missing_scanner_score']:[]),
    ...(riskLens.status==='CAUTION'?['pump_dump_risk']:[]),
    'unverified_execution_costs','no_forward_validation'];
  return {symbol,technical,event,risk:riskLens,fundamentals,macro,
    research_readiness:blockers.length?'RESEARCH_ONLY':'RESEARCH_ONLY',
    blockers,orders_allowed:false};
}
