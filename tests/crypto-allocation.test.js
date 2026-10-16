import test from 'node:test';
import assert from 'node:assert/strict';
import {cryptoEntryCapacity,hasRecentSameSymbolFill} from '../lib/crypto-allocation.js';

const now=Date.parse('2026-10-15T20:00:00Z');
const holding=(symbol,dollars=25)=>({symbol,asset_class:'crypto',market_value:String(dollars)});
const fill=(symbol,hoursAgo=1)=>({symbol,side:'buy',filled_qty:'1',
  filled_at:new Date(now-hoursAgo*3600000).toISOString()});

test('one crypto position can coexist with a second distinct paper position',()=>{
 const result=cryptoEntryCapacity({positions:[holding('BTCUSD')],recentFilled:[fill('BTC/USD')],
   now});
 assert.equal(result.allowed,true,JSON.stringify(result));
 assert.equal(result.available_slots,1);
 assert.equal(result.gross_notional,25);
 assert.equal(hasRecentSameSymbolFill('BTCUSD',[fill('BTC/USD')],now),true);
 assert.equal(hasRecentSameSymbolFill('ETHUSD',[fill('BTC/USD')],now),false);
});

test('two held coins or excessive gross crypto exposure block additional entries',()=>{
 assert.ok(cryptoEntryCapacity({positions:[holding('BTCUSD'),holding('ETHUSD')],now}).reasons
   .includes('crypto_position_capacity'));
 assert.ok(cryptoEntryCapacity({positions:[holding('BTCUSD',45)],now}).reasons
   .includes('crypto_gross_notional_budget'));
});

test('unfilled active entries block duplicates while rejected attempts do not',()=>{
 assert.ok(cryptoEntryCapacity({now,openOrders:[{side:'buy',symbol:'SOL/USD',status:'new'}]}).reasons
   .includes('unfilled_crypto_entry_order'));
 assert.equal(cryptoEntryCapacity({now,openOrders:[{side:'buy',symbol:'SOL/USD',status:'rejected'}]}).allowed,true);
});

test('two filled entries in rolling day block additional orders; older fills expire',()=>{
 assert.ok(cryptoEntryCapacity({now,recentFilled:[fill('BTCUSD'),fill('ETHUSD')]}).reasons
   .includes('crypto_24h_fill_limit'));
 assert.equal(cryptoEntryCapacity({now,recentFilled:[fill('BTCUSD',28)]}).allowed,true);
});

test('stablecoin balances do not fill momentum slots',()=>{
 const r=cryptoEntryCapacity({now,positions:[holding('USDCUSD',100),holding('USDT/USD',200)]});
 assert.equal(r.allowed,true);
 assert.equal(r.available_slots,2);
});
