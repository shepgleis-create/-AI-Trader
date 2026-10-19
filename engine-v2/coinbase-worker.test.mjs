import test from 'node:test';
import assert from 'node:assert/strict';
import {createSubscription,eligibleUsdProducts,getResearchPairs}
  from './coinbase-worker.mjs';

const products=[
 {id:'BTC-USD',quote_currency:'USD',status:'online',trading_disabled:false},
 {id:'DOGE-USD',quote_currency:'USD',status:'online',trading_disabled:false},
 {id:'PEPE-USD',quote_currency:'USD',status:'online',trading_disabled:false},
 {id:'JUNK-USD',quote_currency:'USD',status:'online',trading_disabled:true},
 {id:'ETH-EUR',quote_currency:'EUR',status:'online',trading_disabled:false},
 {id:'SOL-USD',quote_currency:'USD',status:'offline',trading_disabled:false}
];
test('public USD discovery includes low-price coin markets but excludes halted/unavailable pairs',()=>{
 const list=eligibleUsdProducts(products,20);
 assert.ok(list.includes('PEPE-USD'));
 assert.ok(list.includes('BTC-USD'));
 assert.ok(!list.includes('JUNK-USD'));
 assert.ok(!list.includes('ETH-EUR'));
 assert.ok(!list.includes('SOL-USD'));
});
test('feed subscription requests read-only ticker batch data, no order permission',()=>{
 const req=createSubscription(['BTC-USD','PEPE-USD']);
 assert.equal(req.type,'subscribe');
 assert.deepEqual(req.channels,['ticker_batch']);
 assert.ok(!('auth' in req));
 assert.ok(!('orders' in req));
});
test('dynamic USD discovery obtains public instruments without keys',async()=>{
 const observed=[];
 const result=await getResearchPairs({
  env:{MAX_PAIRS:'3'},
  fetchImpl:async(url,opts)=>{
   observed.push({url,opts});
   return {ok:true,json:async()=>products};
  }
 });
 assert.deepEqual(result,['BTC-USD','DOGE-USD','PEPE-USD']);
 assert.equal(observed.length,1);
 assert.ok(observed[0].url.includes('api.exchange.coinbase.com/products'));
 assert.ok(!('Authorization' in observed[0].opts.headers));
});
test('explicit pair list is bounded and rejects crafted product names',async()=>{
 const list=await getResearchPairs({env:{
   WATCH_PAIRS:'BTC-USD,<script>,DOGE-USD,BTC-USD,PEPE-USD',MAX_PAIRS:'2'
 },fetchImpl:async()=>{throw Error('Should not fetch product list')}});
 assert.deepEqual(list,['BTC-USD','DOGE-USD']);
});
