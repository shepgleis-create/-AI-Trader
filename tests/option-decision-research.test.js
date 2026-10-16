import test from 'node:test';
import assert from 'node:assert/strict';
import {analyzeLongOptionForEntry,reviewLongOption} from '../lib/option-decision-research.js';
const contract={contract:'SPY261120C00500000',quality_score:86,
  spread_pct:0.04,ask:0.65,mid:0.62,dte:25,delta:0.46,
  implied_volatility:0.38,theta:-0.03};
const args={contract,underlying:'SPY',underlyingPrice:510,direction:'BULLISH'};

test('valid small long-call paper contract passes independent screen',()=>{
 const d=analyzeLongOptionForEntry(args);
 assert.equal(d.approved,true,d.reasons.join(','));
 assert.equal(d.metrics.premium_dollars,65);
});
test('oversized, short-dated and wide-spread options fail before model is consulted',()=>{
 const d=analyzeLongOptionForEntry({...args,contract:{...contract,ask:1.50,dte:2,spread_pct:0.30}});
 assert.equal(d.approved,false);
 assert.ok(d.reasons.includes('premium_exceeds_paper_cap'));
 assert.ok(d.reasons.includes('expiry_outside_calibration'));
 assert.ok(d.reasons.includes('option_spread_exceeds_limit'));
});
test('paper option model fallback is explicitly recorded when no key is available',async()=>{
 const d=await reviewLongOption({...args,apiKey:''});
 assert.equal(d.approved,true);
 assert.equal(d.source,'QUANT_FALLBACK');
 assert.ok(d.warning.includes('No model'));
});
test('model cannot approve a contract that fails quantitative risk controls',async()=>{
 const d=await reviewLongOption({...args,contract:{...contract,ask:1.50},apiKey:'dummy'});
 assert.equal(d.approved,false);
 assert.equal(d.source,'OPTION_QUANT_VETO');
});
