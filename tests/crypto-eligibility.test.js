import test from 'node:test';
import assert from 'node:assert/strict';
import {cryptoBaseSymbol,isStablecoinCrypto,normalizeCryptoSymbol,cryptoEntryRejectionReasons} from '../lib/crypto-eligibility.js';

test('stablecoin detection handles quotes and Alpaca position formats',()=>{
  for(const symbol of ['USDC/USD','USDCUSD','USDT/USD','DAIUSD','PYUSD/USD','RLUSDUSD']){
    assert.equal(isStablecoinCrypto(symbol),true,symbol);
  }
  for(const symbol of ['BTC/USD','ETHUSD','SOL/USD','AVAXUSD','LINK/USD']){
    assert.equal(isStablecoinCrypto(symbol),false,symbol);
  }
  assert.equal(cryptoBaseSymbol('USDCUSD'),'USDC');
  assert.equal(normalizeCryptoSymbol('BTC/USD'),normalizeCryptoSymbol('BTCUSD'));
});

test('stablecoins never clear the crypto momentum entry filter',()=>{
  const otherwiseValid={score:95,pump_dump_risk:'LOW',spread_pct:0.001,volatility_14d:0.3,momentum_7d:0.1};
  assert.deepEqual(cryptoEntryRejectionReasons({...otherwiseValid,symbol:'BTC/USD'}),[]);
  assert.ok(cryptoEntryRejectionReasons({...otherwiseValid,symbol:'USDC/USD'}).includes('stablecoin_excluded'));
});

test('no-trade explanations identify independent market-quality problems',()=>{
  const reasons=cryptoEntryRejectionReasons({
    symbol:'SOL/USD',score:70,pump_dump_risk:'HIGH',spread_pct:null,
    volatility_14d:1.5,momentum_7d:-0.05
  });
  assert.ok(reasons.includes('score_below_floor'));
  assert.ok(reasons.includes('elevated_pump_risk'));
  assert.ok(reasons.includes('spread_unacceptable_or_unknown'));
  assert.ok(reasons.includes('volatility_unacceptable_or_unknown'));
  assert.ok(reasons.includes('no_positive_momentum'));
});
