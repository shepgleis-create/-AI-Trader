// Symbols like USDC/USD and broker position symbols USDCUSD represent the same base coin.
// These dollar-pegged assets must not be treated as momentum opportunities.
const USD_PEGGED=new Set(['USDC','USDT','DAI','PYUSD','FDUSD','TUSD','USDP','GUSD','RLUSD','USDD','FRAX','LUSD','SUSD','USDG','USDE']);
export function cryptoBaseSymbol(symbol=''){
  const value=String(symbol||'').toUpperCase().replace(/[^A-Z0-9/]/g,'');
  if(value.includes('/'))return value.split('/')[0];
  return value.endsWith('USD')?value.slice(0,-3):value;
}
export function isStablecoinCrypto(symbol=''){
  return USD_PEGGED.has(cryptoBaseSymbol(symbol));
}
export function cryptoEntryRejectionReasons(candidate={},settings={}){
  const {scoreFloor=82,maxSpread=0.005,maxVolatility=1.20}=settings;
  const reasons=[];
  if(isStablecoinCrypto(candidate.symbol))reasons.push('stablecoin_excluded');
  if(!Number.isFinite(Number(candidate.score))||Number(candidate.score)<scoreFloor)reasons.push('score_below_floor');
  if(String(candidate.pump_dump_risk||'').toUpperCase()!=='LOW')reasons.push('elevated_pump_risk');
  if(candidate.spread_pct==null||!Number.isFinite(Number(candidate.spread_pct))||Number(candidate.spread_pct)<0||Number(candidate.spread_pct)>maxSpread)reasons.push('spread_unacceptable_or_unknown');
  if(candidate.volatility_14d==null||!Number.isFinite(Number(candidate.volatility_14d))||Number(candidate.volatility_14d)<0||Number(candidate.volatility_14d)>maxVolatility)reasons.push('volatility_unacceptable_or_unknown');
  if(!Number.isFinite(Number(candidate.momentum_7d))||Number(candidate.momentum_7d)<=0)reasons.push('no_positive_momentum');
  return reasons;
}
