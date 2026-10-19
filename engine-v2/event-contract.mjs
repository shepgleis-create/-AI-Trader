// Every market-data adapter must obey this neutral event boundary before any
// strategy uses it. The event bus accepts market research ONLY, never orders.
const providers=Object.freeze({
 COINBASE_EXCHANGE_PUBLIC:{
   coverage:'COINBASE_EXCHANGE_PAIRS_ONLY',kinds:['TRADE_TICK'],assets:['CRYPTO']
 },
 TRADIER_BROKERAGE_CONSOLIDATED:{
   coverage:'ENTITLED_BROKERAGE_QUOTE_ONLY',kinds:['QUOTE_SNAPSHOT'],assets:['STOCK','OPTION']
 },
 TRADIER_SANDBOX_DELAYED:{
   coverage:'DELAYED_15_MIN_BROKER_SANDBOX',kinds:['QUOTE_SNAPSHOT'],assets:['STOCK','OPTION']
 }
});
export function providerMetadata(){
 return Object.fromEntries(Object.entries(providers).map(([key,v])=>[key,{
  provider:key,coverage:v.coverage,asset_classes:[...v.assets],
  event_kinds:[...v.kinds],execution_supported:false
 }]));
}
export function validateMarketResearchEvent(e){
 if(!e||e.schema!=='ai_trader_market_event_v2')
  return {valid:false,reason:'UNSUPPORTED_EVENT_SCHEMA'};
 if(e.research_only!==true||e.execution_allowed!==false)
  return {valid:false,reason:'EXECUTION_NOT_ALLOWED_ON_DATA_BUS'};
 const provider=providers[e.source];
 if(!provider)return {valid:false,reason:'UNREGISTERED_DATA_PROVIDER'};
 if(e.provider_coverage!==provider.coverage)
  return {valid:false,reason:'INCORRECT_DATA_COVERAGE'};
 if(!provider.assets.includes(e.asset_class)||!provider.kinds.includes(e.kind))
  return {valid:false,reason:'PROVIDER_CANNOT_EMIT_THIS_ASSET_OR_KIND'};
 if(typeof e.symbol!=='string'||e.symbol.length<2||
    !(Number.isFinite(e.price)&&e.price>0))
  return {valid:false,reason:'INVALID_MARKET_SYMBOL_OR_PRICE'};
 const at=Date.parse(e.event_at),received=Date.parse(e.received_at);
 if(!Number.isFinite(at)||!Number.isFinite(received))
  return {valid:false,reason:'INVALID_EVENT_TIMESTAMP'};
 if(at>received+30000)return {valid:false,reason:'EVENT_FROM_FUTURE'};
 if(e.bid!=null||e.ask!=null){
  if(!(e.bid>0)||!(e.ask>=e.bid))
   return {valid:false,reason:'CROSSED_OR_INCOMPLETE_MARKET_QUOTE'};
 }
 return {valid:true,provider:e.source,asset_class:e.asset_class};
}
