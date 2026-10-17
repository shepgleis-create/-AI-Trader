import test from 'node:test';
import assert from 'node:assert/strict';
import {equityEntryQuota} from '../lib/equity-entry-quota.js';
const now=new Date('2026-10-16T15:00:00Z');
const base={client_order_id:'aitr-q-ewz-test',side:'buy',symbol:'EWZ',
  submitted_at:'2026-10-16T14:15:00Z'};
test('rejected and canceled orders do not consume one filled entry per day',()=>{
 for(const status of ['rejected','canceled','expired']){
  const s=equityEntryQuota([{...base,status,filled_qty:'0'}],now);
  assert.equal(s.canEnter,true,status);
  assert.equal(s.filled_today,0);
  assert.equal(s.submitted_today,1);
 }
});
test('pending orders are blocked, even though daily fill limit is unused',()=>{
 for(const status of ['pending_new','new','partially_filled']){
  const s=equityEntryQuota([{...base,status,filled_qty:'0'}],now);
  assert.equal(s.canEnter,false,status);
  assert.equal(s.reason,'UNFILLED_AUTONOMOUS_ORDER_PENDING');
 }
});
test('filled entries count against daily limit but not a canceled prior day',()=>{
 const orders=[{...base,status:'filled',filled_qty:'0.59',filled_at:'2026-10-16T14:20:00Z'}];
 const result=equityEntryQuota(orders,now);
 assert.equal(result.canEnter,false);
 assert.equal(result.reason,'FILLED_DAILY_ENTRY_LIMIT');
 assert.equal(result.filled_today,1);
 const yesterday={...base,status:'filled',filled_qty:'1',filled_at:'2026-10-15T14:20:00Z'};
 assert.equal(equityEntryQuota([yesterday],now).canEnter,true);
});
test('manual account orders never enter autonomous paper quota',()=>{
 const s=equityEntryQuota([{...base,client_order_id:'manual',status:'new'}],now);
 assert.equal(s.canEnter,true);
});
