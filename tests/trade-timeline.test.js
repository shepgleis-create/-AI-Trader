import test from 'node:test';
import assert from 'node:assert/strict';
import {tradeTimeline,fillEvents,orderAssetClass,orderOrigin} from '../lib/trade-timeline.js';

const orders=[
 {id:'a',client_order_id:'aitr-g-msft-test',symbol:'MSFT',asset_class:'us_equity',
  side:'buy',status:'filled',qty:'0.04',filled_qty:'0.04',filled_avg_price:'520',
  submitted_at:'2026-10-15T14:00:00Z'},
 {id:'b',client_order_id:'aitr-c-auto-btc',symbol:'BTC/USD',asset_class:'crypto',
  side:'sell',status:'filled',qty:'0.01',filled_qty:'0.01',
  submitted_at:'2026-10-15T15:00:00Z'},
 {id:'c',client_order_id:'manual',symbol:'SPY261120C00500000',asset_class:'us_option',
  side:'buy',status:'rejected',qty:'1',rejected_at:'2026-10-15T16:00:00Z',
  submitted_at:'2026-10-15T15:58:00Z'}
];
const fills=[
 {id:'fill-a',activity_type:'FILL',type:'fill',order_id:'a',qty:'0.04',cum_qty:'0.04',
  transaction_time:'2026-10-15T14:00:03.456Z',symbol:'MSFT',side:'buy',price:'519.95'},
 {id:'fill-b',activity_type:'FILL',type:'partial_fill',order_id:'b',qty:'0.003',
  transaction_time:'2026-10-15T15:00:01Z',symbol:'BTC/USD',side:'sell',price:'71000'},
 {id:'fill-c',activity_type:'FILL',type:'fill',order_id:'b',qty:'0.007',
  transaction_time:'2026-10-15T15:00:04Z',symbol:'BTC/USD',side:'sell',price:'70990'}
];

test('all three assets and bot attribution are normalized',()=>{
 assert.equal(orderAssetClass(orders[0]),'us_equity');
 assert.equal(orderAssetClass(orders[1]),'crypto');
 assert.equal(orderAssetClass(orders[2]),'us_option');
 assert.equal(orderOrigin(orders[0]),'AI_TRADER');
 assert.equal(orderOrigin(orders[2]),'UNATTRIBUTED');
});
test('actual Alpaca transaction times take precedence over submission times',()=>{
 const t=tradeTimeline(orders,fills);
 assert.equal(t.stats.actual_fill_events,3);
 assert.equal(t.stats.confirmed_buy_fill_events,1);
 assert.equal(t.stats.confirmed_sell_fill_events,2);
 assert.equal(t.stats.unique_filled_orders,2);
 assert.equal(t.events.find(x=>x.id==='fill:fill-a').timestamp,'2026-10-15T14:00:03.456Z');
 assert.equal(t.events.find(x=>x.id==='a:SUBMITTED').event,'SUBMITTED');
});
test('partial fills are separately visible; rejected orders are never counted as fills',()=>{
 const t=tradeTimeline(orders,fills);
 assert.equal(t.events.filter(x=>x.event==='PARTIAL_FILL').length,1);
 assert.equal(t.events.filter(x=>x.event==='REJECTED').length,1);
 assert.equal(t.events.some(x=>x.order_id==='c'&&x.event==='FILL'),false);
 assert.equal(fillEvents([{activity_type:'FILL',qty:0,order_id:'x',transaction_time:'2026-10-15T10:00:00Z'}],orders).length,0);
});
