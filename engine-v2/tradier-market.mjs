// V2 optional READ-ONLY Tradier market-data adapter.
// Real-time consolidated stocks/options require an entitled Tradier brokerage
// account. Sandbox market data is DELAYED, not real-time. No order endpoints here.

const n=value=>{if(value==null||value==='')return null;const v=Number(value);return Number.isFinite(v)?v:null};
const symbolOk=s=>/^[A-Z0-9.\/]{1,26}$/.test(String(s||''));
export function tradierQuoteToEvent(quote,{sandbox=false,receivedAt=Date.now()}={}){
  if(!quote||!symbolOk(quote.symbol))return null;
  const price=n(quote.last||quote.close),bid=n(quote.bid),ask=n(quote.ask);
  if(!(price>0))return null;
  const quoteIsValid=bid>0&&ask>=bid;
  const at=n(quote.trade_date);
  const eventAt=at&&at>0?new Date(at):new Date(receivedAt);
  if(!Number.isFinite(eventAt.getTime()))return null;
  const option=String(quote.type||'').toLowerCase()==='option';
  return {
    schema:'ai_trader_market_event_v2',
    kind:'QUOTE_SNAPSHOT',
    source:sandbox?'TRADIER_SANDBOX_DELAYED':'TRADIER_BROKERAGE_CONSOLIDATED',
    venue:'US_EQUITIES_AND_OPTIONS',
    asset_class:option?'OPTION':'STOCK',
    symbol:String(quote.symbol),
    price,bid:quoteIsValid?bid:null,ask:quoteIsValid?ask:null,
    spread_bps:quoteIsValid?Number((((ask-bid)/((bid+ask)/2))*10000).toFixed(2)):null,
    volume:n(quote.volume),day_change_pct:n(quote.change_percentage),
    previous_close:n(quote.prevclose),
    event_at:eventAt.toISOString(),received_at:new Date(receivedAt).toISOString(),
    timestamp_origin:at?'EXCHANGE':'RECEIPT_FALLBACK',
    provider_coverage:sandbox?'DELAYED_15_MIN_BROKER_SANDBOX':'ENTITLED_BROKERAGE_QUOTE_ONLY',
    research_only:true,execution_allowed:false
  };
}
function endpoint(sandbox){
 return sandbox?'https://sandbox.tradier.com/v1/markets/quotes':
   'https://api.tradier.com/v1/markets/quotes';
}
export function validateQuoteSymbols(symbols=[]){
 if(!Array.isArray(symbols)||symbols.length<1||symbols.length>40)
  throw Error('Require 1 to 40 watchlist symbols per request; Tradier does not permit bulk whole-exchange streaming abuse');
 const uniq=[...new Set(symbols.map(s=>String(s).trim().toUpperCase()))];
 if(uniq.some(s=>!symbolOk(s)))throw Error('Invalid equity or OCC option symbol');
 return uniq;
}
export async function readTradierQuotes({
 symbols=[],token,sandbox=false,fetchImpl=fetch
}={}){
 const selected=validateQuoteSymbols(symbols);
 if(typeof token!=='string'||token.length<12)
  throw Error('Optional broker-linked Tradier DATA token is not configured');
 const url=new URL(endpoint(Boolean(sandbox)));
 url.searchParams.set('symbols',selected.join(','));
 const response=await fetchImpl(url.toString(),{
  method:'GET',
  headers:{Authorization:'Bearer '+token,Accept:'application/json'},
  signal:AbortSignal.timeout(7000)
 });
 const body=await response.json().catch(()=>null);
 if(!response.ok)throw Error('Tradier market-data request failed HTTP '+response.status);
 const quotes=body?.quotes?.quote;
 const rows=(Array.isArray(quotes)?quotes:quotes?[quotes]:[])
  .map(q=>tradierQuoteToEvent(q,{sandbox})).filter(Boolean);
 return {
  provider:sandbox?'TRADIER_SANDBOX_DELAYED':'TRADIER_BROKERAGE_CONSOLIDATED',
  mode:sandbox?'DELAYED_SANDBOX':'BROKER_LINKED_REALTIME_CONDITIONAL',
  symbols_requested:selected.length,quotes_received:rows.length,
  events:rows,
  warning:sandbox?'Sandbox prices are delayed 15 minutes; do not route real-time trade orders from them.':
    'Brokerage entitlement required. REST watchlist quote access is NOT permission to stream all U.S. tickers. Data freshness must be verified before execution.'
 };
}
export function tradierSessionSubscribe(symbols=[],sessionId=''){
 const selected=validateQuoteSymbols(symbols);
 if(!/^[A-Za-z0-9\-]{8,80}$/.test(String(sessionId)))
  throw Error('Valid broker-issued short-lived streaming session id required');
 return {symbols:selected,sessionid:sessionId,
  filter:['quote','trade'],linebreak:false,validOnly:true};
}
