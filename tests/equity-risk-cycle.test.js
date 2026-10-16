import test from 'node:test';
import assert from 'node:assert/strict';
import {equityRiskHandlerForTests} from '../api/equity-risk-cycle.js';
function response(){
 return {statusCode:200,status(n){this.statusCode=n;return this},
  json(payload){this.payload=payload;return this}};
}
const samplePositions=[
 {asset_class:'us_equity',symbol:'MSFT',qty:'0.05',unrealized_plpc:'-0.04'},
 {asset_class:'us_equity',symbol:'AAPL',qty:'0.1',unrealized_plpc:'-0.10'}
];
const sampleOrders=[
 {id:'bot1',side:'buy',symbol:'MSFT',client_order_id:'aitr-q-msft-test',
   filled_qty:'0.05',filled_at:'2026-10-15T15:30:00Z'},
 {id:'manual1',side:'buy',symbol:'AAPL',client_order_id:'manual-investment',
   filled_qty:'0.1',filled_at:'2026-10-15T16:00:00Z'}
];
async function run(enabled){
 const oldFetch=globalThis.fetch,oldEnv={...process.env};
 const calls=[];
 try{
  process.env.CRON_SECRET='unit-cron';
  process.env.ALPACA_API_KEY='paper-test-key';
  process.env.ALPACA_SECRET_KEY='paper-test-secret';
  process.env.ALPACA_BASE_URL='https://paper-api.alpaca.markets';
  process.env.AUTO_TRADING_ENABLED=enabled?'true':'false';
  globalThis.fetch=async (url,options={})=>{
   const u=new URL(String(url));
   calls.push({path:u.pathname,method:options.method||'GET',search:u.search});
   let result={},status=200;
   if(u.pathname==='/v2/clock')result={is_open:true,timestamp:'2026-10-15T17:00:00Z'};
   else if(u.pathname==='/v2/positions')result=samplePositions;
   else if(u.pathname==='/v2/orders'&&u.searchParams.get('status')==='all')result=sampleOrders;
   else if(u.pathname==='/v2/orders'&&u.searchParams.get('status')==='open')result=[];
   else if(u.pathname==='/v2/positions/MSFT'&&options.method==='DELETE')result={id:'paper-close-test'};
   else{status=404;result={message:'Unmocked test route'}}
   return {ok:status<400,status,json:async()=>result};
  };
  const res=response();
  await equityRiskHandlerForTests({method:'GET',headers:{authorization:'Bearer unit-cron'}},res);
  assert.equal(res.statusCode,200,JSON.stringify(res.payload));
  assert.equal(res.payload.mode,'PAPER');
  assert.equal(res.payload.monitored,1);
  const exits=calls.filter(c=>c.method==='DELETE');
  if(enabled){
   assert.deepEqual(exits.map(c=>c.path),['/v2/positions/MSFT']);
   assert.equal(res.payload.actions[0].submitted,true);
   assert.equal(res.payload.actions[0].reason,'fractional_stop_loss_3pct');
  }else{
   assert.equal(exits.length,0);
   assert.equal(res.payload.actions[0].type,'fractional_exit_dry_run');
  }
 }finally{
  globalThis.fetch=oldFetch;
  for(const name of ['CRON_SECRET','ALPACA_API_KEY','ALPACA_SECRET_KEY','ALPACA_BASE_URL','AUTO_TRADING_ENABLED']){
   if(oldEnv[name]===undefined)delete process.env[name];
   else process.env[name]=oldEnv[name];
  }
 }
}
test('paper stop exits only matching bot fractional stock, never manual stocks',()=>run(true));
test('disabled automation monitors positions without submitting close orders',()=>run(false));
