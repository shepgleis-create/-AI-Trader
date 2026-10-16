import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const auto=readFileSync(new URL('../api/auto-cycle.js',import.meta.url),'utf8');

test('stock automation submits validated broker-compatible order payload',()=>{
  assert.match(auto,/import \{ buildEquityEntryOrder \}/);
  assert.match(auto,/const policy=buildEquityEntryOrder\(/);
  assert.match(auto,/body: JSON\.stringify\(policy\.order\)/);
  assert.doesNotMatch(auto,/order_class: 'bracket'/);
});

test('paper stock bot exit controls never liquidate unrelated manual holdings',()=>{
  assert.match(auto,/identifyBotOwnedEquityPosition\(p,recentOrders\)/);
  assert.match(auto,/if\(!owner\.managed\|\|protectedSymbols\.has\(p\.symbol\)\) continue/);
  assert.match(auto,/identifyBotFractionalPosition\(p,recentOrders\)/);
});

test('market data is refreshed before risk evaluation and reused at execution',()=>{
  const refresh=auto.indexOf('latestExecutionSnapshot(pick.symbol,key,secret)');
  const risk=auto.indexOf('const risk = evaluateEntry(');
  assert.ok(refresh>0&&risk>refresh);
  assert.match(auto,/candidate: riskCandidate/);
  assert.equal((auto.match(/latestExecutionSnapshot\(pick\.symbol/g)||[]).length,1);
});
