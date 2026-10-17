import test from 'node:test';
import assert from 'node:assert/strict';
import {equityRiskHandlerForTests} from '../api/equity-risk-cycle.js';

test('paper fraction risk worker survives Alpaca v2 clock 404 via calendar fallback',async()=>{
 const previous={fetch:globalThis.fetch,cron:process.env.CRON_SECRET,
   key:process.env.ALPACA_API_KEY,secret:process.env.ALPACA_SECRET_KEY,
   base:process.env.ALPACA_BASE_URL};
 try{
  process.env.CRON_SECRET='isolated-clock-fallback-test';
  process.env.ALPACA_API_KEY='paper-unit-key';
  process.env.ALPACA_SECRET_KEY='paper-unit-secret';
  process.env.ALPACA_BASE_URL='https://paper-api.alpaca.markets';
  const localDay=new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York',
    year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
  const parts=new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',
    year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date());
  const d=kind=>parts.find(p=>p.type===kind)?.value;
  const day=d('year')+'-'+d('month')+'-'+d('day');
  const calls=[];
  globalThis.fetch=async input=>{
   const u=new URL(String(input));calls.push(u.pathname);
   if(u.pathname==='/v2/clock'||u.pathname==='/v3/clock')
     return {ok:false,status:404,statusText:'Not Found',
       json:async()=>({message:'Clock not available'})};
   if(u.pathname==='/v2/calendar')
     return {ok:true,status:200,json:async()=>[{date:day,open:'00:00',close:'23:59'}]};
   if(u.pathname==='/v2/positions'||u.pathname==='/v2/orders')
     return {ok:true,status:200,json:async()=>[]};
   return {ok:false,status:404,json:async()=>({message:'Unmocked endpoint'})};
  };
  const res={statusCode:200,status(n){this.statusCode=n;return this},
    json(payload){this.payload=payload;return this}};
  await equityRiskHandlerForTests({method:'GET',headers:{
    authorization:'Bearer isolated-clock-fallback-test'
  }},res);
  assert.equal(res.statusCode,200,JSON.stringify(res.payload));
  assert.equal(res.payload.ok,true);
  assert.ok(calls.includes('/v2/clock'));
  assert.ok(calls.includes('/v2/calendar'));
 }finally{
  globalThis.fetch=previous.fetch;
  for(const [k,v] of Object.entries({
    CRON_SECRET:previous.cron,ALPACA_API_KEY:previous.key,
    ALPACA_SECRET_KEY:previous.secret,ALPACA_BASE_URL:previous.base
  })){if(v===undefined)delete process.env[k];else process.env[k]=v}
 }
});
