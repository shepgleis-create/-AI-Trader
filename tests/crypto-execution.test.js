import test from 'node:test';
import assert from 'node:assert/strict';
import {rankedCryptoSetups,inspectCryptoQuote,planCryptoLimitBuy} from '../lib/crypto-execution.js';

const settings={scoreFloor:82,maxSpread:0.005,maxVolatility:1.2};
const candidate=(symbol,score,spread=0.001)=>({
  symbol,score,spread_pct:spread,pump_dump_risk:'LOW',
  volatility_14d:0.45,momentum_7d:0.10,dollar_volume:10000000,
  min_order_size:'0.001',min_trade_increment:'0.001',price_increment:'0.01'
});

test('ranks eligible candidates by trading quality rather than raw scanner score',()=>{
  const ranked=rankedCryptoSetups([
    candidate('A/USD',90,0.004),candidate('B/USD',89,0.0005),candidate('USDC/USD',100,0.0001)
  ],settings);
  assert.equal(ranked[0].candidate.symbol,'B/USD');
  assert.equal(ranked[1].candidate.symbol,'A/USD');
  assert.ok(ranked.at(-1).reasons.includes('stablecoin_excluded'));
});

test('fresh spreads qualify, missing or stale quotes cannot trigger an entry',()=>{
  const now=Date.parse('2026-10-09T17:00:00.000Z');
  const snapshot={latestQuote:{bp:99.95,ap:100.05,t:'2026-10-09T16:59:30.000Z'},
    latestTrade:{p:100}};
  const ok=inspectCryptoQuote(snapshot,now);
  assert.equal(ok.ok,true);
  assert.ok(ok.spread_pct<0.005);
  assert.equal(inspectCryptoQuote(snapshot,now+300000).reason,'crypto_quote_missing_or_stale');
  assert.equal(inspectCryptoQuote({latestQuote:{bp:100,ap:90,t:'2026-10-09T17:00:00Z'}},now).ok,false);
  assert.equal(inspectCryptoQuote({latestQuote:{bp:1,ap:1.03,t:'2026-10-09T17:00:00Z'}},now).ok,false);
});

test('limit-buy size follows exchange increments without exceeding paper budget',()=>{
  const quote={ok:true,ask:100.05,spread_pct:0.001};
  const plan=planCryptoLimitBuy(candidate('ETH/USD',92),quote,25);
  assert.equal(plan.ok,true,JSON.stringify(plan));
  assert.ok(Number(plan.qty)>0);
  assert.ok(Number(plan.qty)*Number(plan.limit_price)<=25.0000001);
  assert.ok(Number(plan.limit_price)>=quote.ask);
  assert.ok(Number(plan.qty)*1000%1<1e-6);
  assert.equal(planCryptoLimitBuy({...candidate('BTC/USD',95),min_order_size:'0.01'},quote,25).reason,
    'crypto_minimum_size_above_notional_cap');
});

test('unsafe or missing exchange tick metadata fails closed',()=>{
  const quote={ok:true,ask:100.05};
  assert.equal(planCryptoLimitBuy({...candidate('SOL/USD',95),price_increment:null},quote).ok,false);
  assert.equal(planCryptoLimitBuy({...candidate('SOL/USD',95),price_increment:'5'},quote).ok,false);
});
