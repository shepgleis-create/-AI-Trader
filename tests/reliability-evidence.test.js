import test from 'node:test';
import assert from 'node:assert/strict';
import { simulateDailyStrategy,runChallengerComparison } from '../lib/challenger-strategies.js';
import { selectDatabaseUrl } from '../lib/database-url.js';
import { cronSlot, scheduledJobs, cronDatabaseConfig } from '../lib/cron-telemetry.js';
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

test('challenger strategies stay research-only and do not auto-apply',()=>{
  const rows=Array.from({length:180},(_,i)=>{
    const p=100+Math.sin(i/6)*4+i*.03;
    return {t:new Date(Date.UTC(2025,0,i+1)).toISOString(),
      o:p,h:p+2,l:p-2,c:p+Math.sin(i/3),v:100000};
  });
  const comparison=runChallengerComparison(rows,{assetClass:'equity'});
  assert.equal(comparison.length,4);
  assert.deepEqual(comparison.map(x=>x.strategy),['TREND','BREAKOUT','PULLBACK','MEAN_REVERSION']);
  assert.ok(comparison.every(x=>x.auto_apply===false));
  assert.ok(comparison.every(x=>x.validation_begins));
});
test('invalid market bars never create simulated entries',()=>{
  const malformed=Array.from({length:120},(_,i)=>({t:new Date(Date.UTC(2025,0,i+1)).toISOString(),
    o:0,h:0,l:0,c:0}));
  assert.deepEqual(simulateDailyStrategy(malformed,'TREND'),[]);
});

test('invalid Neon placeholder host fails closed before trying to access network',()=>{
  const prior=process.env.DATABASE_URL;
  const alt=process.env.POSTGRES_URL;
  try{
    delete process.env.POSTGRES_URL;
    process.env.DATABASE_URL='postgresql://dbuser:fakepassword@base/neondb?sslmode=require';
    assert.equal(cronDatabaseConfig().configured,true);
    assert.equal(cronDatabaseConfig().valid,false);
    assert.match(cronDatabaseConfig().error,/No valid PostgreSQL connection URL/);
    process.env.DATABASE_URL='not a connection URL';
    assert.equal(cronDatabaseConfig().valid,false);
  }finally{
    if(prior==null)delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL=prior;
    if(alt==null)delete process.env.POSTGRES_URL;
    else process.env.POSTGRES_URL=alt;
  }
});
test('scheduled jobs now include independent continuous market research',()=>{
  assert.ok(scheduledJobs().includes('research-cycle'));
  assert.equal(cronSlot('research-cycle','2026-10-08T10:01:00Z'),
    cronSlot('research-cycle','2026-10-08T10:29:00Z'));
  assert.notEqual(cronSlot('research-cycle','2026-10-08T10:29:00Z'),
    cronSlot('research-cycle','2026-10-08T10:30:00Z'));
});

test('Neon integration production unpooled URL overrides stale placeholder configuration',()=>{
  const env={
    DATABASE_URL:'postgresql://user:password@base/neondb?sslmode=require',
    DATABASE_URL_UNPOOLED:'postgresql://user:password@ep-test.us-east-2.aws.neon.tech/neondb?sslmode=require'
  };
  const picked=selectDatabaseUrl(env);
  assert.equal(picked.valid,true);
  assert.equal(picked.key,'DATABASE_URL_UNPOOLED');
  assert.equal(picked.configured,true);
  assert.equal(picked.error,null);
});
test('proper original production URL is preferred to fallback',()=>{
  const env={
    DATABASE_URL:'postgresql://user:password@ep-primary-pooler.us-east-2.aws.neon.tech/neondb?sslmode=require',
    DATABASE_URL_UNPOOLED:'postgresql://user:password@ep-alternate.us-east-2.aws.neon.tech/neondb?sslmode=require'
  };
  assert.equal(selectDatabaseUrl(env).key,'DATABASE_URL');
  assert.equal(selectDatabaseUrl({DATABASE_URL:'postgresql://bad@base/neondb'}).valid,false);
});
