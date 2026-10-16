import test from 'node:test';
import assert from 'node:assert/strict';
import {analyzeCryptoForEntry,researchCryptoEntry} from '../lib/crypto-decision-research.js';

const good={symbol:'BTC/USD',score:92,momentum_7d:0.13,momentum_30d:0.22,
  pump_dump_risk:'LOW',volatility_14d:0.65,dollar_volume:50000000,
  price:69000,rsi14:61,day_change:0.02,volume_ratio:1.8};
const quote={ok:true,spread_pct:0.001,quote_age_seconds:28};

test('healthy liquid momentum setup passes deterministic independent review',()=>{
 const report=analyzeCryptoForEntry(good,quote);
 assert.equal(report.approved,true,JSON.stringify(report.reasons));
 assert.equal(report.kind,'QUANT_RESEARCH');
 assert.ok(report.strengths.includes('positive_7day_momentum'));
});
test('weak, stale, risky or illiquid crypto fails before any AI override',()=>{
 const report=analyzeCryptoForEntry({...good,momentum_7d:-0.05,
   pump_dump_risk:'HIGH',dollar_volume:4000,rsi14:88},{...quote,quote_age_seconds:400});
 assert.equal(report.approved,false);
 assert.ok(report.reasons.includes('nonpositive_7day_momentum'));
 assert.ok(report.reasons.includes('stale_live_quote'));
 assert.ok(report.reasons.includes('elevated_pump_risk'));
});
test('absent model key uses clearly labeled quantitative fallback',async()=>{
 const result=await researchCryptoEntry({candidate:good,quote,apiKey:''});
 assert.equal(result.approved,true);
 assert.equal(result.source,'QUANT_FALLBACK');
 assert.ok(result.warning.includes('No AI'));
});
test('a risky setup can never be approved by model review',async()=>{
 const result=await researchCryptoEntry({candidate:{...good,score:40},quote,apiKey:'dummy'});
 assert.equal(result.approved,false);
 assert.equal(result.source,'DETERMINISTIC_VETO');
});
