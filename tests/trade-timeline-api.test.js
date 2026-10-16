import test from 'node:test';
import assert from 'node:assert/strict';
import {tradeTimelineHandler} from '../api/trade-timeline.js';
import {createSession} from '../lib/auth.js';

test('authenticated broker timeline reports executed fills separately from submitted orders',async()=>{
 const oldFetch=globalThis.fetch;
 const original={};
 for(const k of ['CRON_SECRET','ALPACA_API_KEY','ALPACA_SECRET_KEY','ALPACA_BASE_URL']){
   original[k]=process.env[k]
 }
 try{
   process.env.CRON_SECRET='isolated-test-session-key';
   process.env.ALPACA_API_KEY='test';
   process.env.ALPACA_SECRET_KEY='test';
   process.env.ALPACA_BASE_URL='https://paper-api.alpaca.markets';
   const submitted='2026-10-15T17:00:00Z';
   const executed='2026-10-15T17:00:02.234Z';
   const urls=[];
   globalThis.fetch=async url=>{
     const u=new URL(String(url));urls.push(u.pathname);
     const data=u.pathname==='/v2/orders'?[
       {id:'abc',client_order_id:'aitr-c-auto-test',asset_class:'crypto',
         symbol:'ETH/USD',side:'buy',qty:'0.01',status:'filled',
         filled_qty:'0.01',submitted_at:submitted}
     ]:[
       {id:'trade123',activity_type:'FILL',type:'fill',order_id:'abc',
         symbol:'ETH/USD',side:'buy',qty:'0.01',cum_qty:'0.01',
         price:'2900',transaction_time:executed}
     ];
     return {ok:true,status:200,json:async()=>data};
   };
   const req={method:'GET',headers:{'x-dashboard-session':createSession()}};
   const res={statusCode:200,headers:{},
     status(v){this.statusCode=v;return this},
     setHeader(k,v){this.headers[k]=v},
     json(value){this.data=value;return this}};
   await tradeTimelineHandler(req,res);
   assert.equal(res.statusCode,200,JSON.stringify(res.data));
   assert.equal(res.data.stats.actual_fill_events,1);
   assert.equal(res.data.stats.recorded_order_submissions,1);
   assert.equal(res.data.events[0].timestamp,executed);
   assert.equal(res.data.events[0].origin,'AI_TRADER');
   assert.ok(urls.includes('/v2/account/activities/FILL'));
 }finally{
   globalThis.fetch=oldFetch;
   for(const k of Object.keys(original)){
     if(original[k]===undefined)delete process.env[k];else process.env[k]=original[k];
   }
 }
});
