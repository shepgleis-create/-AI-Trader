import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeMover,computeMoverReturns,rankMoverRows,screenMoverRows,momentSignal} from '../lib/mover-research.js';

const day='2026-10-19';
const bars=Array.from({length:26},(_,i)=>{
 const d=new Date(Date.UTC(2026,8,1+i*1));
 return {t:d.toISOString(),c:10+i};
});
test('Alpaca percent_change remains actual percentage points and not fractions',()=>{
 const r=normalizeMover({symbol:'WORX',price:8.25,percent_change:176.09,change:5.26});
 assert.equal(r.day_pct,176.09);
 assert.equal(r.price,8.25);
});
test('last incomplete UTC day is excluded from weekly monthly baselines',()=>{
 const b=[
  {t:'2026-10-09T00:00:00Z',c:100},
  {t:'2026-10-12T00:00:00Z',c:102},
  {t:'2026-10-13T00:00:00Z',c:104},
  {t:'2026-10-14T00:00:00Z',c:106},
  {t:'2026-10-15T00:00:00Z',c:108},
  {t:'2026-10-16T00:00:00Z',c:110},
  {t:'2026-10-19T00:00:00Z',c:999}
 ];
 const r=computeMoverReturns(b,120,new Date(day+'T17:00:00Z'));
 assert.equal(r.completed_sessions,6);
 assert.ok(r.week_pct>17&&r.week_pct<18);
 assert.equal(r.month_pct,null);
});
test('daily, weekly and monthly ranking uses the relevant window, not daily gains in every tab',()=>{
 const rows=[
  {symbol:'AAA',day_pct:21,week_pct:-3,month_pct:5},
  {symbol:'BBB',day_pct:3,week_pct:17,month_pct:4},
  {symbol:'CCC',day_pct:-12,week_pct:2,month_pct:35}
 ];
 assert.deepEqual(screenMoverRows(rows,{window:'1d'}).map(x=>x.symbol),['AAA','BBB','CCC']);
 assert.deepEqual(screenMoverRows(rows,{window:'1w'}).map(x=>x.symbol),['BBB','CCC','AAA']);
 assert.deepEqual(screenMoverRows(rows,{window:'1m'}).map(x=>x.symbol),['CCC','AAA','BBB']);
 assert.equal(screenMoverRows(rows,{window:'1d',direction:'losers'})[0].symbol,'CCC');
});
test('penny-stock extreme movers are visible but marked with risk labels',()=>{
 const rows=rankMoverRows({providers:[{symbol:'WORX',price:0.8,day_pct:176,
  provider:'ALPACA_MOVERS'}],bars:{}});
 assert.equal(rows.length,1);
 assert.ok(rows[0].risk_flags.includes('PENNY_STOCK'));
 assert.ok(rows[0].risk_flags.includes('EXTREME_MOVE'));
});
test('fast early acceleration is WATCH-only, not a buy',()=>{
 const previous={symbol:'WORX',asset_class:'stock',day_pct:2,observed_at:'2026-10-19T15:00:00Z'};
 const current={...previous,day_pct:5,observed_at:'2026-10-19T15:15:00Z'};
 assert.equal(momentSignal(previous,current).type,'INTRADAY_ACCELERATION_WATCH');
 assert.equal(momentSignal(previous,{...current,day_pct:180}),null);
});
