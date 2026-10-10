import {cryptoEntryRejectionReasons} from './crypto-eligibility.js';

// Research score is not a win probability. These penalties prioritize execution quality.
export function rankedCryptoSetups(candidates=[],settings={}){
  return (Array.isArray(candidates)?candidates:[])
    .map(candidate=>{
      const reasons=cryptoEntryRejectionReasons(candidate,settings);
      const spread=Number(candidate.spread_pct);
      const vol=Number(candidate.volatility_14d);
      const quality=Number(candidate.score)-Math.max(0,spread)*1000-Math.max(0,vol)*3;
      return {candidate,reasons,quality_score:Number(quality.toFixed(2))};
    })
    .sort((a,b)=>a.reasons.length-b.reasons.length||
      b.quality_score-a.quality_score||
      Number(b.candidate.dollar_volume||0)-Number(a.candidate.dollar_volume||0));
}
export function inspectCryptoQuote(snapshot={},now=Date.now(),maxSpread=0.005){
  const q=snapshot.latestQuote||snapshot.latest_quote||{};
  const t=snapshot.latestTrade||snapshot.latest_trade||{};
  const bid=Number(q.bp),ask=Number(q.ap),last=Number(t.p);
  if(!(bid>0&&ask>=bid))return {ok:false,reason:'invalid_or_missing_crypto_bid_ask'};
  const mid=(bid+ask)/2;
  const spread=(ask-bid)/mid;
  if(!Number.isFinite(spread)||spread>maxSpread)return {ok:false,reason:'crypto_quote_spread_too_wide',spread_pct:spread};
  const quoteAt=Date.parse(q.t||'');
  const ageSeconds=Number.isFinite(quoteAt)?(now-quoteAt)/1000:null;
  if(ageSeconds==null||ageSeconds< -30||ageSeconds>240)
    return {ok:false,reason:'crypto_quote_missing_or_stale',quote_age_seconds:ageSeconds};
  if(Number.isFinite(last)&&last>0&&Math.abs(last/mid-1)>0.03)
    return {ok:false,reason:'crypto_trade_quote_disagreement'};
  return {ok:true,bid,ask,spread_pct:spread,quote_age_seconds:ageSeconds};
}
function precision(value){
  const text=String(value).toLowerCase();
  if(text.includes('e-'))return Math.min(9,Number(text.split('e-')[1])||9);
  return Math.min(9,(text.split('.')[1]||'').length);
}
export function planCryptoLimitBuy(candidate,quote,notional=25){
  if(!quote?.ok||!(quote.ask>0)||!(notional>0))return {ok:false,reason:'unusable_crypto_quote'};
  const tick=Number(candidate.price_increment);
  const minimum=Number(candidate.min_order_size);
  const increment=Number(candidate.min_trade_increment);
  if(!(tick>0&&minimum>0&&increment>0))
    return {ok:false,reason:'missing_crypto_exchange_increments'};
  const raw=quote.ask*1.0005;
  const limit=Number((Math.ceil(raw/tick-1e-9)*tick).toFixed(precision(candidate.price_increment)));
  if(!(limit>0)||limit>quote.ask*1.003)
    return {ok:false,reason:'crypto_tick_price_above_execution_cap'};
  const allowed=notional/limit;
  const steps=Math.floor((allowed-minimum)/increment+1e-9);
  if(steps<0)return {ok:false,reason:'crypto_minimum_size_above_notional_cap'};
  const qty=Number((minimum+steps*increment).toFixed(9));
  if(!(qty>=minimum)||qty*limit>notional+1e-7)
    return {ok:false,reason:'crypto_quantity_does_not_fit_budget'};
  return {ok:true,qty:qty.toFixed(9).replace(/0+$/,'').replace(/\.$/,''),
    limit_price:limit.toFixed(precision(candidate.price_increment)),
    notional_estimate:Number((qty*limit).toFixed(4)),execution_price_cap_pct:0.003};
}
