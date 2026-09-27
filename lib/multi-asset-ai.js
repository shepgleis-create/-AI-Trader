function compact(x){
  if(!x||typeof x!=='object')return null;
  return JSON.parse(JSON.stringify(x,(k,v)=>{
    if(typeof v==='string')return v.slice(0,600);
    return v;
  }));
}

export async function getMultiAssetAiDecision({
  apiKey,
  account,
  positions=[],
  longCandidate=null,
  shortCandidate=null,
  cryptoCandidate=null,
  optionCandidate=null
}){
  if(!apiKey)throw new Error('GEMINI_API_KEY is not configured');

  const lanes={};
  if(longCandidate)lanes.LONG_EQUITY=compact({
    symbol:longCandidate.symbol,score:longCandidate.score,price:longCandidate.price,
    setup_type:longCandidate.setup_type,momentum_20d:longCandidate.momentum_20d,
    rsi14:longCandidate.rsi14,atr_pct:longCandidate.atr_pct,
    beta_60d:longCandidate.beta_60d,spread_pct:longCandidate.spread_pct,
    sector_proxy:longCandidate.sector_proxy,sector_strength_percentile:longCandidate.sector_strength_percentile,
    reasons:longCandidate.reasons
  });
  if(shortCandidate)lanes.SHORT_EQUITY=compact({
    symbol:shortCandidate.symbol,score:shortCandidate.score,price:shortCandidate.price,
    momentum_20d:shortCandidate.momentum_20d,rsi14:shortCandidate.rsi14,
    atr_pct:shortCandidate.atr_pct,volatility_20d:shortCandidate.volatility_20d,
    relative_weakness_20d:shortCandidate.relative_weakness_20d,
    borrow_status:shortCandidate.borrow_status,paper_short_eligible:shortCandidate.paper_short_eligible,
    squeeze_risk:shortCandidate.squeeze_risk,spread_pct:shortCandidate.spread_pct,
    reasons:shortCandidate.reasons
  });
  if(cryptoCandidate)lanes.CRYPTO_LONG=compact({
    symbol:cryptoCandidate.symbol,score:cryptoCandidate.score,price:cryptoCandidate.price,
    day_change:cryptoCandidate.day_change,momentum_7d:cryptoCandidate.momentum_7d,
    momentum_30d:cryptoCandidate.momentum_30d,rsi14:cryptoCandidate.rsi14,
    volatility_14d:cryptoCandidate.volatility_14d,spread_pct:cryptoCandidate.spread_pct,
    pump_dump_risk:cryptoCandidate.pump_dump_risk,research_signal:cryptoCandidate.research_signal,
    reasons:cryptoCandidate.reasons
  });
  if(optionCandidate)lanes[optionCandidate.direction==='BEARISH'?'LONG_PUT':'LONG_CALL']=compact({
    underlying:optionCandidate.underlying,contract:optionCandidate.contract,
    direction:optionCandidate.direction,quality_score:optionCandidate.quality_score,
    dte:optionCandidate.dte,strike:optionCandidate.strike,mid:optionCandidate.mid,
    ask:optionCandidate.ask,spread_pct:optionCandidate.spread_pct,delta:optionCandidate.delta,
    gamma:optionCandidate.gamma,theta:optionCandidate.theta,
    implied_volatility:optionCandidate.implied_volatility
  });

  const allowed=Object.keys(lanes);
  if(!allowed.length){
    return {action:'SKIP',symbol:'',contract:'',confidence:100,rationale:'No multi-asset opportunities were supplied.',model:'gemini-3.8-flash'};
  }

  const portfolio={
    equity:Number(account?.equity||account?.portfolio_value||0),
    cash:Number(account?.cash||0),
    buying_power:Number(account?.buying_power||0),
    options_buying_power:Number(account?.options_buying_power||0),
    options_trading_level:Number(account?.options_trading_level||0),
    positions:(positions||[]).map(p=>({
      symbol:p.symbol,
      qty:Number(p.qty||0),
      market_value:Number(p.market_value||0),
      unrealized_plpc:Number(p.unrealized_plpc||0)
    })).slice(0,20)
  };

  const prompt=[
    'You are the cross-asset decision router inside a conservative PAPER-trading research system.',
    'Compare only the supplied lanes. Choose at most one action, or SKIP.',
    'Actions may include LONG_EQUITY, SHORT_EQUITY, CRYPTO_LONG, LONG_CALL, LONG_PUT, or SKIP, but only if that lane exists in the input.',
    'A high score is not a probability of profit. Prefer SKIP when evidence conflicts or the trade has poor execution quality.',
    'For SHORT_EQUITY, require paper_short_eligible=true and avoid HIGH squeeze risk.',
    'For CRYPTO_LONG, never select HIGH pump_dump_risk and be especially skeptical of sharp short-term pumps.',
    'For LONG_CALL/LONG_PUT, consider spread, DTE, delta, theta, implied volatility and premium cost. Options can lose 100% of premium.',
    'Do not recommend naked option selling, crypto leverage, margin expansion, averaging down, revenge trading, or any instrument not supplied.',
    'This router does not override deterministic execution/risk checks.',
    'Return only JSON matching the schema.',
    JSON.stringify({lanes,portfolio})
  ].join('\n');

  const response=await fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent',{
    method:'POST',
    headers:{'x-goog-api-key':apiKey,'Content-Type':'application/json'},
    body:JSON.stringify({
      contents:[{parts:[{text:prompt}]}],
      generationConfig:{
        responseFormat:{
          text:{
            mimeType:'APPLICATION_JSON',
            schema:{
              type:'object',
              properties:{
                action:{type:'string',enum:['LONG_EQUITY','SHORT_EQUITY','CRYPTO_LONG','LONG_CALL','LONG_PUT','SKIP']},
                symbol:{type:'string'},
                contract:{type:'string'},
                confidence:{type:'integer'},
                rationale:{type:'string'}
              },
              required:['action','symbol','contract','confidence','rationale']
            }
          }
        }
      }
    })
  });
  const data=await response.json().catch(()=>({}));
  if(!response.ok)throw new Error(data?.error?.message||'Gemini multi-asset request failed');

  const text=data?.candidates?.[0]?.content?.parts?.map(p=>p?.text||'').join('').trim();
  if(!text)throw new Error('Gemini returned no multi-asset decision');

  let d;
  try{d=JSON.parse(text)}catch{throw new Error('Gemini returned unreadable multi-asset JSON')}

  if(d.action!=='SKIP'&&!allowed.includes(d.action)){
    throw new Error('Gemini selected a lane that was not supplied');
  }

  const lane=lanes[d.action];
  if(d.action==='LONG_EQUITY'&&d.symbol!==lane?.symbol)throw new Error('Gemini changed the long-equity symbol');
  if(d.action==='SHORT_EQUITY'&&d.symbol!==lane?.symbol)throw new Error('Gemini changed the short-equity symbol');
  if(d.action==='CRYPTO_LONG'&&d.symbol!==lane?.symbol)throw new Error('Gemini changed the crypto symbol');
  if(['LONG_CALL','LONG_PUT'].includes(d.action)&&d.contract!==lane?.contract)throw new Error('Gemini changed the option contract');

  if(d.action==='SHORT_EQUITY'&&(lane?.paper_short_eligible!==true||lane?.squeeze_risk==='HIGH')){
    throw new Error('Gemini selected a short that fails borrow/squeeze requirements');
  }
  if(d.action==='CRYPTO_LONG'&&lane?.pump_dump_risk==='HIGH'){
    throw new Error('Gemini selected a crypto candidate with HIGH pump risk');
  }

  return {
    action:d.action,
    symbol:d.action==='SKIP'?'':String(d.symbol||''),
    contract:d.action==='SKIP'?'':String(d.contract||''),
    confidence:Math.max(0,Math.min(100,Number(d.confidence)||0)),
    rationale:String(d.rationale||'').slice(0,1000),
    model:'gemini-3.8-flash',
    available_lanes:allowed
  };
}
