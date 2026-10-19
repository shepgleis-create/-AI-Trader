import test from 'node:test';
import assert from 'node:assert/strict';
import {readTradierQuotes,tradierQuoteToEvent,validateQuoteSymbols,tradierSessionSubscribe}
  from './tradier-market.mjs';

const sample={symbol:'MSFT',type:'stock',last:532.5,
 bid:532.49,ask:532.51,change_percentage:2.35,prevclose:520.26,
 volume:14300000,trade_date:Date.parse('2026-10-19T15:00:00Z')};
test('consolidated brokerage quote distinguishes provider entitlement and preserves exchange timestamp',()=>{
 const q=tradierQuoteToEvent(sample,{receivedAt:Date.parse('2026-10-19T15:00:02Z')});
 assert.equal(q.source,'TRADIER_BROKERAGE_CONSOLIDATED');
 assert.equal(q.asset_class,'STOCK');
 assert.equal(q.event_at,'2026-10-19T15:00:00.000Z');
 assert.ok(q.spread_bps>0);
 assert.equal(q.execution_allowed,false);
});
test('Tradier paper sandbox is explicitly delayed, not mislabeled as nationwide live prices',()=>{
 const event=tradierQuoteToEvent({...sample,type:'option',symbol:'MSFT261120C00500000'},
  {sandbox:true});
 assert.equal(event.asset_class,'OPTION');
 assert.equal(event.provider_coverage,'DELAYED_15_MIN_BROKER_SANDBOX');
 assert.equal(event.research_only,true);
});
test('watchlist requests cannot abuse full-market API or send crafted symbols',()=>{
 assert.deepEqual(validateQuoteSymbols(['spy','AAPL','SPY']),['SPY','AAPL']);
 assert.throws(()=>validateQuoteSymbols(Array.from({length:41},(_,i)=>'SYM'+i)),/1 to 40/);
 assert.throws(()=>validateQuoteSymbols(['BTC-USD;POST']),/Invalid/);
});
test('read-only adapter builds authenticated GET quotes, no brokerage execution actions',async()=>{
 const called=[];
 const res=await readTradierQuotes({symbols:['MSFT'],token:'test-entitled-token-abc',
  fetchImpl:async(url,options)=>{
   called.push({url,options});
   return {ok:true,status:200,json:async()=>({quotes:{quote:sample}})};
  }});
 assert.equal(res.events.length,1);
 assert.equal(res.mode,'BROKER_LINKED_REALTIME_CONDITIONAL');
 assert.equal(called.length,1);
 assert.ok(called[0].url.startsWith('https://api.tradier.com/v1/markets/quotes?'));
 assert.equal(called[0].options.method,'GET');
 assert.ok(!called[0].url.includes('test-entitled-token'));
 assert.equal(res.events[0].execution_allowed,false);
});
test('read-only session subscription requires a short-lived broker id',()=>{
 const s=tradierSessionSubscribe(['SPY'],'12345678-abcd-ef00');
 assert.deepEqual(s.filter,['quote','trade']);
 assert.throws(()=>tradierSessionSubscribe(['SPY'],'x'),/session id/);
});
