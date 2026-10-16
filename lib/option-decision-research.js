import {generateStructuredGemini} from './gemini-client.js';

// Option research is an additional veto, not a substitute for the brokerage checks.
export function analyzeLongOptionForEntry({contract={},underlying,underlyingPrice,direction}={}){
  const risks=[],supports=[];
  const ask=Number(contract.ask),quality=Number(contract.quality_score);
  const spread=Number(contract.spread_pct),dte=Number(contract.dte);
  const delta=Number(contract.delta),iv=Number(contract.implied_volatility);
  const premium=ask*100;
  if(!(quality>=75))risks.push('contract_quality_below_floor');
  if(!(spread>=0&&spread<=0.12))risks.push('option_spread_exceeds_limit');
  else if(spread<=0.05)supports.push('moderate_execution_spread');
  if(!(dte>=7&&dte<=45))risks.push('expiry_outside_calibration');
  if(!(premium>0&&premium<=100))risks.push('premium_exceeds_paper_cap');
  if(!(Number(underlyingPrice)>0))risks.push('invalid_underlying_price');
  if(!(String(direction)==='BULLISH'||String(direction)==='BEARISH'))
    risks.push('invalid_trade_direction');
  if(Number.isFinite(delta)&&Math.abs(delta)>0.80)risks.push('high_directional_delta');
  if(Number.isFinite(iv)&&iv>2.0)risks.push('extreme_implied_volatility');
  if(typeof underlying!=='string'||!/^[A-Z.]{1,12}$/.test(underlying))
    risks.push('invalid_underlying');
  return {approved:risks.length===0,reasons:risks,supports,
    metrics:{quality_score:quality,spread_pct:spread,premium_dollars:premium,
      dte,delta:Number.isFinite(delta)?delta:null,
      implied_volatility:Number.isFinite(iv)?iv:null,
      theta:Number.isFinite(Number(contract.theta))?Number(contract.theta):null,
      underlying_price:Number(underlyingPrice)},
    caveat:'A long call or put can lose 100% of the premium. This is paper research, not a profit estimate.'};
}
export async function reviewLongOption({contract,underlying,underlyingPrice,direction,apiKey}={}){
  const quantitative=analyzeLongOptionForEntry({contract,underlying,underlyingPrice,direction});
  if(!quantitative.approved)return {approved:false,source:'OPTION_QUANT_VETO',
    quantitative,rationale:'Option contract did not pass additional research quality checks.'};
  if(!apiKey)return {approved:true,source:'QUANT_FALLBACK',
    quantitative,rationale:'No AI model key; independently validated paper option limits still apply.',
    warning:'No model reviewed this contract.'};
  try{
    const result=await generateStructuredGemini({
      apiKey,totalTimeoutMs:5500,perModelTimeoutMs:2000,
      prompt:[
        'Independently review a long call or put PAPER test after the broker risk checks.',
        'Choose APPROVE or VETO, based only on supplied contract data and explicit risks.',
        'Do not invent earnings dates, news, price predictions, profitability, or statistical edges.',
        'Consider implied volatility, expiration, spread cost, Greeks, premium loss and direction.',
        'VETO if the evidence is inadequate. Do not suggest increases in position size or leverage.',
        JSON.stringify({underlying,direction,contract:{contract:contract.contract,
          expiry:contract.expiry,quality_score:contract.quality_score},
          evidence:quantitative.metrics})
      ].join('\n'),
      schema:{type:'object',properties:{
        action:{type:'string',enum:['APPROVE','VETO']},
        rationale:{type:'string'},risks:{type:'array',items:{type:'string'}}
      },required:['action','rationale','risks']}
    });
    return {approved:result.parsed?.action==='APPROVE',source:'GEMINI_OPTION_REVIEW',
      model:result.model,quantitative,
      rationale:String(result.parsed?.rationale||'').slice(0,350),
      risks:(Array.isArray(result.parsed?.risks)?result.parsed.risks:[]).slice(0,5)};
  }catch(error){
    return {approved:true,source:'QUANT_FALLBACK',quantitative,
      rationale:'AI review unavailable; the independent option eligibility gates passed.',
      warning:String(error?.message||'Model unavailable').slice(0,170)};
  }
}
