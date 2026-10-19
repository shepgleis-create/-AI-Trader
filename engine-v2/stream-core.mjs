// AI Trader V2 standalone, broker-neutral MARKET RESEARCH event core.
// No Alpaca/Tradier/Coinbase trading orders here. All emissions are WATCH-only.

const productSymbol=value=>String(value||'').toUpperCase().trim();
const finite=value=>{if(value==null||value==='')return null;const n=Number(value);return Number.isFinite(n)?n:null};

export function normalizeCoinbaseTicker(message,receivedAt=Date.now()){
  if(!message||!['ticker','ticker_batch'].includes(message.type))return null;
  const symbol=productSymbol(message.product_id);
  if(!/^[A-Z0-9]{1,20}-USD$/.test(symbol))return null;
  const price=finite(message.price);
  if(!(price>0))return null;
  const bid=finite(message.best_bid),ask=finite(message.best_ask);
  const executableQuote=bid>0&&ask>=bid;
  const spreadBps=executableQuote?(ask-bid)/((ask+bid)/2)*10000:null;
  const stamp=Date.parse(String(message.time||''));
  const eventAt=Number.isFinite(stamp)?stamp:receivedAt;
  if(eventAt>receivedAt+30_000||eventAt<receivedAt-120_000)return null;
  return {
    schema:'ai_trader_market_event_v2',kind:'TRADE_TICK',source:'COINBASE_EXCHANGE_PUBLIC',
    asset_class:'CRYPTO',symbol,venue:'COINBASE_EXCHANGE',price,
    bid:executableQuote?bid:null,ask:executableQuote?ask:null,
    spread_bps:spreadBps===null?null:Number(spreadBps.toFixed(2)),
    last_size:Math.max(0,finite(message.last_size)||0),
    event_at:new Date(eventAt).toISOString(),received_at:new Date(receivedAt).toISOString(),
    timestamp_origin:Number.isFinite(stamp)?'EXCHANGE':'RECEIPT_FALLBACK',
    provider_coverage:'COINBASE_EXCHANGE_PAIRS_ONLY',research_only:true
  };
}

export function validateResearchEvent(event){
  if(event?.schema!=='ai_trader_market_event_v2'||event?.kind!=='TRADE_TICK'||
    event?.research_only!==true)return {valid:false,reason:'INVALID_RESEARCH_EVENT'};
  if(!event.source||!event.symbol||!(event.price>0)||!
    Number.isFinite(Date.parse(event.event_at)))return {valid:false,reason:'INCOMPLETE_TICK'};
  if(event.source==='COINBASE_EXCHANGE_PUBLIC'&&event.provider_coverage!=='COINBASE_EXCHANGE_PAIRS_ONLY')
    return {valid:false,reason:'MISREPRESENTED_PROVIDER_COVERAGE'};
  return {valid:true};
}

export class RollingCoinRadar{
  constructor({lookbackMs=5*60000,minWindowMs=20_000,
    minMovePct=1.5,minDollarTurnover=300,signalCooldownMs=120000,
    maxSpreadBps=100,maxSymbols=500}={}){
    this.config={lookbackMs,minWindowMs,minMovePct,minDollarTurnover,
      signalCooldownMs,maxSpreadBps,maxSymbols};
    this.states=new Map();
    this.totalTicks=0;this.totalSignals=0;
  }
  ingest(event){
    const check=validateResearchEvent(event);
    if(!check.valid)return {accepted:false,reason:check.reason,signal:null};
    const t=Date.parse(event.event_at);
    let state=this.states.get(event.symbol);
    if(!state){
      if(this.states.size>=this.config.maxSymbols){
        const oldest=[...this.states.entries()].sort((a,b)=>a[1].last_at-b[1].last_at)[0];
        if(oldest)this.states.delete(oldest[0]);
      }
      state={points:[],last_at:0,last_signal_at:0};
      this.states.set(event.symbol,state);
    }
    // Out-of-order exchange ticks must not corrupt rolling windows.
    if(t<=state.last_at)return {accepted:false,reason:'STALE_OR_OUT_OF_ORDER',signal:null};
    state.last_at=t;
    state.points.push({at:t,price:event.price,
      turnover:event.last_size*event.price,spread_bps:event.spread_bps});
    const oldest=t-this.config.lookbackMs;
    while(state.points.length&&state.points[0].at<oldest)state.points.shift();
    // Bounded state even on a high-activity venue.
    if(state.points.length>600)state.points.splice(0,state.points.length-600);
    this.totalTicks++;
    if(state.points.length<2)return {accepted:true,signal:null};

    const first=state.points[0],minutes=(t-first.at)/60000;
    if(minutes*60000<this.config.minWindowMs)return {accepted:true,signal:null};
    const changePct=(event.price/first.price-1)*100;
    const turnover=state.points.reduce((n,p)=>n+p.turnover,0);
    if(!(changePct>=this.config.minMovePct)||turnover<this.config.minDollarTurnover||
      t-state.last_signal_at<this.config.signalCooldownMs)
      return {accepted:true,signal:null};
    // An extreme pump is for investigation, not an implied entry.
    const alert='PRICE_ACCELERATION_WATCH';
    const spreadValid=Number.isFinite(event.spread_bps)&&
      event.spread_bps>=0&&event.spread_bps<=this.config.maxSpreadBps;
    const signal={
      schema:'ai_trader_signal_v2',type:alert,source:event.source,
      symbol:event.symbol,asset_class:'CRYPTO',venue:event.venue,
      detected_at:event.event_at,price:event.price,
      lookback_minutes:Number(minutes.toFixed(2)),
      return_pct:Number(changePct.toFixed(3)),
      observed_turnover_usd:Number(turnover.toFixed(2)),
      observed_samples:state.points.length,
      spread_bps:event.spread_bps,
      spread_valid:spreadValid,
      warnings:[
        ...(changePct>=20?['EXTREME_MOVE_CHASE_RISK']:[]),
        ...(!spreadValid?['MISSING_OR_WIDE_EXCHANGE_QUOTE']:[]),
        ...(event.timestamp_origin!=='EXCHANGE'?['UNVERIFIED_EXCHANGE_TIMESTAMP']:[])
      ],
      execution_allowed:false,
      mode:'RESEARCH_ONLY',
      note:'Streaming venue-only momentum observation; not an order, forecast or proof of a profitable strategy.'
    };
    state.last_signal_at=t;this.totalSignals++;
    return {accepted:true,signal};
  }
  snapshot(){
    return {tracked_symbols:this.states.size,ticks:this.totalTicks,
      signals:this.totalSignals,
      last_event_at:[...this.states.values()].reduce((latest,s)=>Math.max(latest,s.last_at),0)
        ?new Date(Math.max(...[...this.states.values()].map(s=>s.last_at))).toISOString():null,
      research_only:true};
  }
}
