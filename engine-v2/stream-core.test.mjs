import test from 'node:test';
import assert from 'node:assert/strict';
import {RollingCoinRadar,normalizeCoinbaseTicker,validateResearchEvent}
  from './stream-core.mjs';

const base=Date.parse('2026-10-19T14:00:00Z');
function ticker(at,price,{bid=price*.999,ask=price*1.001,
 size='2',symbol='PEPE-USD'}={}){
 return normalizeCoinbaseTicker({
  type:'ticker',product_id:symbol,
  price:String(price),best_bid:String(bid),best_ask:String(ask),
  last_size:size,time:new Date(at).toISOString()
 },at);
}
test('normalization records originating venue/time and refuses invalid products',()=>{
 const tick=ticker(base,100);
 assert.equal(tick.schema,'ai_trader_market_event_v2');
 assert.equal(tick.source,'COINBASE_EXCHANGE_PUBLIC');
 assert.equal(tick.research_only,true);
 assert.equal(tick.timestamp_origin,'EXCHANGE');
 assert.equal(validateResearchEvent(tick).valid,true);
 assert.equal(normalizeCoinbaseTicker({type:'ticker',product_id:'BTC-EUR',price:'100'},base),null);
 assert.equal(normalizeCoinbaseTicker({type:'ticker',product_id:'BTC-USD',price:'-1'},base),null);
 assert.equal(validateResearchEvent({...tick,provider_coverage:'ALL_CRYPTO'}).valid,false);
});
test('replay of orderly venue ticks yields one WATCH, never an executable trade',()=>{
 const radar=new RollingCoinRadar({minMovePct:1.5,minWindowMs:20_000,
  minDollarTurnover:100,signalCooldownMs:120000});
 const start=radar.ingest(ticker(base,100));
 assert.equal(start.signal,null);
 const next=radar.ingest(ticker(base+30_000,102.25));
 assert.equal(next.accepted,true);
 assert.equal(next.signal.type,'PRICE_ACCELERATION_WATCH');
 assert.equal(next.signal.execution_allowed,false);
 assert.equal(next.signal.mode,'RESEARCH_ONLY');
 assert.equal(next.signal.symbol,'PEPE-USD');
 assert.equal(next.signal.return_pct,2.25);
 const repeated=radar.ingest(ticker(base+40_000,103));
 assert.equal(repeated.signal,null);
 assert.equal(radar.totalSignals,1);
});
test('missing bid-ask never becomes certified quote execution',()=>{
 const radar=new RollingCoinRadar({minMovePct:0.5,minWindowMs:10_000,minDollarTurnover:0});
 radar.ingest(ticker(base,100,{bid:0,ask:0}));
 const p=radar.ingest(ticker(base+15_000,103,{bid:0,ask:0}));
 assert.equal(p.signal.spread_valid,false);
 assert.ok(p.signal.warnings.includes('MISSING_OR_WIDE_EXCHANGE_QUOTE'));
});
test('rejects out-of-order replay and bounds retained market state',()=>{
 const radar=new RollingCoinRadar({lookbackMs:60_000,minDollarTurnover:0,maxSymbols:2});
 radar.ingest(ticker(base,100,{symbol:'BTC-USD'}));
 radar.ingest(ticker(base+1000,100,{symbol:'ETH-USD'}));
 assert.equal(radar.ingest(ticker(base-1000,101,{symbol:'BTC-USD'})).reason,
   'STALE_OR_OUT_OF_ORDER');
 radar.ingest(ticker(base+2000,100,{symbol:'SOL-USD'}));
 assert.equal(radar.snapshot().tracked_symbols,2);
});
test('a large price jump is identified as chase risk instead of guaranteeing profit',()=>{
 const radar=new RollingCoinRadar({minMovePct:1.5,minWindowMs:20_000,minDollarTurnover:100});
 radar.ingest(ticker(base,100));
 const result=radar.ingest(ticker(base+30_000,160));
 assert.ok(result.signal.warnings.includes('EXTREME_MOVE_CHASE_RISK'));
 assert.equal(result.signal.execution_allowed,false);
});

test('low observed meme-coin turnover is still a research WATCH, with explicit risk warning',()=>{
 const radar=new RollingCoinRadar({minMovePct:1,minWindowMs:20_000,
  minDollarTurnover:10000,signalCooldownMs:120000});
 radar.ingest(ticker(base,100,{size:'0.1'}));
 const result=radar.ingest(ticker(base+30000,104,{size:'0.1'}));
 assert.equal(result.signal.type,'LOW_TURNOVER_MOVE_WATCH');
 assert.ok(result.signal.warnings.includes('LOW_OBSERVED_VENUE_TURNOVER'));
 assert.equal(result.signal.execution_allowed,false);
});
