import test from 'node:test';
import assert from 'node:assert/strict';
import {runChallengerComparison,simulateDailyStrategy} from '../lib/challenger-strategies.js';
import {assessResearchCandidate} from '../lib/research-lenses.js';

function bars(count=240){
  return Array.from({length:count},(_,i)=>{
    const p=100+i*.25+Math.sin(i/8)*2;
    return {t:new Date(Date.UTC(2024,0,1+i)).toISOString(),o:p,h:p*1.015,l:p*.985,c:p*1.005};
  });
}
test('tournament evaluates 12 research-only variants without orders',()=>{
  const result=runChallengerComparison(bars());
  assert.equal(result.length,12);
  assert.equal(new Set(result.map(r=>r.strategy)).size,12);
  assert.ok(result.every(r=>r.auto_apply===false));
  assert.ok(result.every(r=>r.train.trades>=0&&r.validation.trades>=0));
});
test('outcome metrics remain bounded on synthetic bars',()=>{
  for(const s of runChallengerComparison(bars())){
    if(s.overall.trades) {
      assert.ok(s.overall.max_drawdown>=0&&s.overall.max_drawdown<=1);
      assert.ok(s.overall.win_rate>=0&&s.overall.win_rate<=1);
    }
  }
});
test('research flags contradictory evidence and never authorizes orders',()=>{
  const r=assessResearchCandidate({symbol:'XYZ',score:85,momentum_7d:-.1,momentum_20d:.2,pump_dump_risk:'HIGH'});
  assert.ok(r.conflicting_signals.length>=2);
  assert.equal(r.orders_allowed,false);
  assert.equal(r.human_review_required,true);
});
test('scanner quality checks reject out-of-range scores',()=>{
  const r=assessResearchCandidate({symbol:'ABC',score:150});
  assert.ok(r.data_quality_flags.includes('scanner_score_out_of_range'));
});
