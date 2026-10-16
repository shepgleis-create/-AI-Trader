import {normalizeCryptoSymbol,isStablecoinCrypto} from './crypto-eligibility.js';

// Paper-only diversification policy. Existing manual and bot positions both occupy risk slots.
export const CRYPTO_PAPER_POLICY=Object.freeze({
  maxDistinctMomentumPositions:2,
  maxFilledEntries24h:2,
  maxNewOrderNotional:25,
  maxMomentumGrossNotional:50,
  sameSymbolCooldownHours:24
});
export function cryptoEntryCapacity({positions=[],recentFilled=[],openOrders=[],now=Date.now()}={}){
  const held=positions.filter(p=>String(p?.asset_class||'').toLowerCase()==='crypto'&&!isStablecoinCrypto(p.symbol));
  const heldSymbols=new Set(held.map(p=>normalizeCryptoSymbol(p.symbol)));
  const gross=held.reduce((v,p)=>v+Math.abs(Number(p.market_value)||0),0);
  const active=openOrders.filter(o=>o.side==='buy'&&!isStablecoinCrypto(o.symbol)
    &&['new','accepted','pending_new','partially_filled'].includes(String(o.status||'').toLowerCase()));
  const cutoff=now-24*3600000;
  const fills=recentFilled.filter(o=>o.side==='buy'&&Number(o.filled_qty||0)>0&&!isStablecoinCrypto(o.symbol)
    &&new Date(o.filled_at||o.submitted_at||0).getTime()>=cutoff);
  const reasons=[];
  if(heldSymbols.size>=CRYPTO_PAPER_POLICY.maxDistinctMomentumPositions)
    reasons.push('crypto_position_capacity');
  if(gross+CRYPTO_PAPER_POLICY.maxNewOrderNotional>CRYPTO_PAPER_POLICY.maxMomentumGrossNotional+0.02)
    reasons.push('crypto_gross_notional_budget');
  if(active.length)reasons.push('unfilled_crypto_entry_order');
  if(fills.length>=CRYPTO_PAPER_POLICY.maxFilledEntries24h)reasons.push('crypto_24h_fill_limit');
  return {allowed:reasons.length===0,reasons,held_symbols:[...heldSymbols],
    gross_notional:Number(gross.toFixed(2)),fills_last_24h:fills.length,
    available_slots:Math.max(0,CRYPTO_PAPER_POLICY.maxDistinctMomentumPositions-heldSymbols.size)};
}
export function hasRecentSameSymbolFill(symbol,recentFilled=[],now=Date.now()){
  const cutoff=now-CRYPTO_PAPER_POLICY.sameSymbolCooldownHours*3600000;
  const normalized=normalizeCryptoSymbol(symbol);
  return recentFilled.some(o=>o.side==='buy'&&Number(o.filled_qty||0)>0
    &&normalizeCryptoSymbol(o.symbol)===normalized
    &&new Date(o.filled_at||o.submitted_at||0).getTime()>=cutoff);
}
