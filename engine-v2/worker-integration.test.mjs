import test from 'node:test';
import assert from 'node:assert/strict';
import {startResearchWorker} from './coinbase-worker.mjs';

function fakeWebSocketHarness(){
 const created=[];
 class FakeWebSocket{
  constructor(url){this.url=url;this.listeners=new Map();this.sent=[];this.closed=false;
   created.push(this);queueMicrotask(()=>this.fire('open',{}));}
  addEventListener(name,fn){
   if(!this.listeners.has(name))this.listeners.set(name,[]);
   this.listeners.get(name).push(fn);
  }
  fire(name,event){for(const fn of this.listeners.get(name)||[])fn(event)}
  send(s){this.sent.push(JSON.parse(s))}
  close(){if(this.closed)return;this.closed=true;this.fire('close',{})}
  emit(message){this.fire('message',{data:JSON.stringify(message)})}
 }
 return {FakeWebSocket,created};
}
const pause=()=>new Promise(resolve=>setTimeout(resolve,5));
test('standalone always-on worker serves local health, emits watch alerts and NEVER places orders',async()=>{
 const {FakeWebSocket,created}=fakeWebSocketHarness();
 const logs=[];
 const env={WATCH_PAIRS:'BTC-USD,PEPE-USD',MAX_PAIRS:'20',
  TRADING_MODE:'RESEARCH_ONLY',HEALTH_HOST:'127.0.0.1',
  HEALTH_PORT:'18793',MIN_WATCH_MOVE_PCT:'1',
  MIN_OBSERVED_TURNOVER_USD:'20'};
 const worker=await startResearchWorker({env,WebSocketImpl:FakeWebSocket,
  fetchImpl:async()=>{throw Error('Pair list should come from explicit env')},
  log:o=>logs.push(o)});
 try{
  await pause();
  assert.equal(created.length,1);
  assert.deepEqual(created[0].sent[0].channels,['ticker_batch']);
  assert.deepEqual(created[0].sent[0].product_ids,['BTC-USD','PEPE-USD']);
  const now=Date.now();
  created[0].emit({type:'ticker',product_id:'PEPE-USD',
   price:'0.000010',best_bid:'0.00000999',best_ask:'0.00001001',
   last_size:'5000000',time:new Date(now-32000).toISOString()});
  created[0].emit({type:'ticker',product_id:'PEPE-USD',
   price:'0.000011',best_bid:'0.00001099',best_ask:'0.00001101',
   last_size:'5000000',time:new Date(now).toISOString()});
  await pause();
  const h=await fetch('http://127.0.0.1:18793/health').then(r=>r.json());
  const s=await fetch('http://127.0.0.1:18793/signals').then(r=>r.json());
  assert.equal(h.connected,true);
  assert.equal(h.mode,'RESEARCH_ONLY');
  assert.equal(h.provider,'COINBASE_EXCHANGE_PUBLIC');
  assert.equal(s.signals.length,1);
  assert.equal(s.signals[0].execution_allowed,false);
  assert.ok(logs.some(x=>x.event==='watch_alert'));
  assert.ok(!logs.some(x=>/order|fill|trade_executed/.test(x.event||'')));
 }finally{await worker.shutdown()}
});
test('worker rejects attempts to turn market-data process into real-money order service',async()=>{
 await assert.rejects(
  startResearchWorker({env:{TRADING_MODE:'LIVE'},
    WebSocketImpl:class MockWS{},log:()=>{}}),
  /RESEARCH_ONLY/
 );
});
