import test from 'node:test';
import assert from 'node:assert/strict';
import {completedCryptoDollarVolume} from '../lib/crypto-liquidity.js';
const now=new Date('2026-10-16T23:30:00Z');
function bar(day,volume,price=10){return {t:day+'T00:00:00Z',v:volume,c:price}}
test('current incomplete UTC day volume does not falsely label an asset illiquid',()=>{
 const bars=[
  bar('2026-10-12',150000),bar('2026-10-13',160000),
  bar('2026-10-14',180000),bar('2026-10-15',170000),
  bar('2026-10-16',2)
 ];
 const r=completedCryptoDollarVolume(bars,now);
 assert.equal(r.dollar_volume,1650000);
 assert.equal(r.completed_days,4);
 assert.equal(r.source,'median_completed_daily_usd_volume_7d');
});
test('median is resilient to isolated unusually large daily volume',()=>{
 const bars=[bar('2026-10-13',100000),bar('2026-10-14',90000000),
   bar('2026-10-15',120000)];
 assert.equal(completedCryptoDollarVolume(bars,now).dollar_volume,1200000);
});
test('unknown historical liquidity fails closed rather than using tiny current volume',()=>{
 const r=completedCryptoDollarVolume([bar('2026-10-15',150000),bar('2026-10-16',1)],now);
 assert.equal(r.dollar_volume,null);
 assert.equal(r.completed_days,1);
});
