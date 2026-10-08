import test from 'node:test';
import assert from 'node:assert/strict';
import { cronSlot, scheduledJobs } from '../lib/cron-telemetry.js';
import { wilsonLowerBound,evaluateLane,buildEvidenceScoreboard } from '../lib/evidence-scoreboard.js';

const trade=(pnl,time,overrides={})=>({
  lane:'LONG_EQUITY',symbol:'TEST',entry_price:100,qty:1,multiplier:1,
  pnl,entry_time:time,exit_time:time,...overrides
});

test('cron slots suppress same-window retries and separate later windows',()=>{
  assert.equal(cronSlot('crypto-risk-cycle','2026-10-07T14:01:00.000Z'),
    cronSlot('crypto-risk-cycle','2026-10-07T14:14:00.000Z'));
  assert.notEqual(cronSlot('crypto-risk-cycle','2026-10-07T14:14:00.000Z'),
    cronSlot('crypto-risk-cycle','2026-10-07T14:15:00.000Z'));
  assert.equal(scheduledJobs().length,6);
});
test('confidence interval stays conservative on tiny samples',()=>{
  assert.equal(wilsonLowerBound(0,0),0);
  assert.ok(wilsonLowerBound(5,5)<1);
  assert.ok(wilsonLowerBound(0,10)>=0);
  assert.ok(wilsonLowerBound(50,100)<0.5);
});
test('zero and negative trade histories do not trigger strategy promotion',()=>{
  assert.equal(evaluateLane([]).state,'INSUFFICIENT_SAMPLE');
  const sample=Array.from({length:40},(_,i)=>trade(-2,new Date(2026,0,i+1).toISOString()));
  assert.equal(evaluateLane(sample).state,'NO_VALIDATED_EDGE');
  assert.equal(evaluateLane(sample).eligible_for_live_money,false);
});
test('cost buffer can erase a gross paper edge',()=>{
  const sample=Array.from({length:40},(_,i)=>trade(0.05,new Date(2026,0,i+1).toISOString()));
  const s=evaluateLane(sample);
  assert.equal(s.state,'NO_VALIDATED_EDGE');
  assert.ok(s.all.estimated_net_pnl<0);
  assert.ok(s.all.estimated_total_cost>0);
});
test('out-of-time validation prevents promoting a strategy that deteriorates',()=>{
  const rows=Array.from({length:45},(_,i)=>
    trade(i<30?(i%3===0?-1:3):-4,new Date(2026,0,i+1).toISOString()));
  const s=evaluateLane(rows);
  assert.equal(s.state,'NO_VALIDATED_EDGE');
  assert.ok(s.earlier.net_expectancy_per_trade>0);
  assert.ok(s.later.net_expectancy_per_trade<0);
});
test('scoreboard keeps lanes separate and never auto-tunes',()=>{
  const rows=Array.from({length:35},(_,i)=>trade(i%3===0?-0.5:2,new Date(2026,0,i+1).toISOString()));
  const a=buildEvidenceScoreboard(rows);
  assert.equal(a.by_lane.CRYPTO_LONG.all.trades,0);
  assert.equal(a.by_lane.LONG_EQUITY.all.trades,35);
  assert.equal(a.by_lane.LONG_EQUITY.eligible_for_auto_tuning,false);
  assert.equal(a.ranking.length,5);
});
