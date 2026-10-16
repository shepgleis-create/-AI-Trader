import {generateStructuredGemini} from './gemini-client.js';

// An LLM review is NOT evidence of future profitability. It can veto but cannot bypass
// order sizing, account circuit breakers, market-quality or broker restrictions.
export function analyzeCryptoForEntry(candidate={},quote={}){
  const reasons=[],strengths=[];
  const score=Number(candidate.score),mom=Number(candidate.momentum_7d);
  const spread=Number(quote.spread_pct),vol=Number(candidate.volatility_14d);
  const liquidity=Number(candidate.dollar_volume);
  const rsi=Number(candidate.rsi14);
  const quoteAge=Number(quote.quote_age_seconds);
  if(!(score>=82))reasons.push('scanner_below_82');
  else strengths.push('regime_independent_scanner_score');
  if(!(mom>0))reasons.push('nonpositive_7day_momentum');
  else strengths.push('positive_7day_momentum');
  if(candidate.pump_dump_risk!=='LOW')reasons.push('elevated_pump_risk');
  if(!quote.ok||!Number.isFinite(spread)||spread>0.005)reasons.push('invalid_live_spread');
  else if(spread<=0.0015)strengths.push('tight_live_spread');
  if(!Number.isFinite(quoteAge)||quoteAge<0||quoteAge>240)reasons.push('stale_live_quote');
  if(!(vol>=0&&vol<=1.2))reasons.push('excessive_or_missing_volatility');
  if(!(liquidity>=1000000))reasons.push('insufficient_24h_dollar_volume');
  else strengths.push('minimum_liquidity_observed');
  if(Number.isFinite(rsi)&&rsi>80)reasons.push('extremely_overbought');
  const money=Number(candidate.price);
  if(!(money>0))reasons.push('missing_reference_price');
  return {approved:reasons.length===0,reasons,strengths,
    metrics:{score,momentum_7d:mom,momentum_30d:Number(candidate.momentum_30d),
      day_change:Number(candidate.day_change),spread_pct:spread,
      volatility_14d:vol,dollar_volume:liquidity,rsi14:Number.isFinite(rsi)?rsi:null,
      quote_age_seconds:quoteAge,rank_score:Number(candidate.quality_score||candidate.score)},
    observed_at:new Date().toISOString(),kind:'QUANT_RESEARCH',
    caveat:'Metrics are observations, not backtested profits or a trained predictive model.'};
}

export async function researchCryptoEntry({
  candidate,quote,apiKey,accountRisk={},marketPeers=[]
}={}){
  const quantitative=analyzeCryptoForEntry(candidate,quote);
  if(!quantitative.approved){
    return {approved:false,source:'DETERMINISTIC_VETO',quantitative,
      rationale:'Entry rejected by independent market-quality and liquidity checks.'};
  }
  if(!apiKey){
    return {approved:true,source:'QUANT_FALLBACK',quantitative,
      rationale:'Model key unavailable; the conservative deterministic entry gates still apply.',
      warning:'No AI model reviewed this entry.'};
  }

  const peers=marketPeers.slice(0,4).map(c=>({
    symbol:c.symbol,score:c.score,momentum_7d:c.momentum_7d,
    spread_pct:c.spread_pct,pump_dump_risk:c.pump_dump_risk
  }));
  const prompt=[
    'You are an independent research reviewer for PAPER spot crypto trades.',
    'You may APPROVE or VETO this single candidate. This is NOT real-money financial advice.',
    'Reason from the supplied measurements only. Do not invent prices, events, news, forecasts or win probabilities.',
    'Favor VETO when momentum, market structure, volatility, execution quality or evidence is conflicting.',
    'Existing hard risk controls cannot be overridden by your answer.',
    'Do not recommend leverage, shorts, futures, options or increasing the approved dollar amount.',
    JSON.stringify({candidate:{symbol:candidate.symbol,
      score:candidate.score,pump_dump_risk:candidate.pump_dump_risk,
      momentum_7d:candidate.momentum_7d,momentum_30d:candidate.momentum_30d,
      rsi14:candidate.rsi14,volume_ratio:candidate.volume_ratio,
      research_signal:candidate.research_signal,
      technical_reasons:candidate.reasons},
      independently_confirmed:quantitative.metrics,
      account_safety:{approved:accountRisk.approved,locks:accountRisk.locks||[]},
      alternate_opportunities:peers})
  ].join('\n');
  try{
    const result=await generateStructuredGemini({
      apiKey,prompt,totalTimeoutMs:6500,perModelTimeoutMs:2300,
      schema:{type:'object',properties:{
        action:{type:'string',enum:['APPROVE','VETO']},
        research_summary:{type:'string'},
        risks:{type:'array',items:{type:'string'}},
        supporting_evidence:{type:'array',items:{type:'string'}}
      },required:['action','research_summary','risks','supporting_evidence']}
    });
    const parsed=result.parsed||{};
    const approved=parsed.action==='APPROVE';
    return {approved,source:'GEMINI_REVIEW',model:result.model,
      model_fallback_used:result.fallback_used,quantitative,
      rationale:String(parsed.research_summary||'').slice(0,350),
      risks:(Array.isArray(parsed.risks)?parsed.risks:[]).slice(0,5).map(x=>String(x).slice(0,120)),
      supporting_evidence:(Array.isArray(parsed.supporting_evidence)?parsed.supporting_evidence:[]).slice(0,5).map(x=>String(x).slice(0,120))}
  }catch(error){
    // Matches the stock bot's existing documented numerical fallback.
    return {approved:true,source:'QUANT_FALLBACK',quantitative,
      rationale:'Gemini review unavailable; independent market-quality gates remained satisfied.',
      warning:String(error?.message||'Model unavailable').slice(0,180)};
  }
}
