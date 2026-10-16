import test from 'node:test';
import assert from 'node:assert/strict';
import {identifyBotCryptoPosition,cryptoHasPendingExit} from '../lib/crypto-position-ownership.js';
const pos={symbol:'BTCUSD',asset_class:'crypto',qty:'0.002'};
const bot={id:'bot1',symbol:'BTC/USD',side:'buy',
  filled_qty:'0.002',client_order_id:'aitr-c-auto-btcusd-test',
  filled_at:'2026-10-15T16:30:00Z'};
test('bot-owned crypto is recognized across Alpaca symbol formats',()=>{
 assert.equal(identifyBotCryptoPosition(pos,[bot]).managed,true);
});
test('manually altered, enlarged, or replaced positions do not qualify for automatic exit',()=>{
 assert.equal(identifyBotCryptoPosition({...pos,qty:'0.003'},[bot]).managed,false);
 const newer={...bot,client_order_id:'manual-investment',filled_at:'2026-10-15T17:00:00Z'};
 assert.equal(identifyBotCryptoPosition(pos,[bot,newer]).managed,false);
});
test('pending crypto sell orders block duplicate exit requests',()=>{
 assert.equal(cryptoHasPendingExit('BTC/USD',[{symbol:'BTCUSD',side:'sell',status:'accepted'}]),true);
 assert.equal(cryptoHasPendingExit('BTC/USD',[{symbol:'BTCUSD',side:'sell',status:'filled'}]),false);
});
