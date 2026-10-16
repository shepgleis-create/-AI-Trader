import test from 'node:test';
import assert from 'node:assert/strict';
import {buildEquityEntryOrder} from '../lib/equity-order-policy.js';
const base={symbol:'MSFT',qty:0.0463667,limitPrice:'539.72',stopPrice:'516.72',
  takeProfitPrice:'584.10',clientOrderId:'aitr-q-msft-s100-c95-123'};
test('fractional stock orders use simple DAY limit without unsupported bracket fields',()=>{
  const p=buildEquityEntryOrder(base);
  assert.equal(p.ok,true);
  assert.equal(p.fractional,true);
  assert.equal(p.order.order_class,'simple');
  assert.equal(p.order.time_in_force,'day');
  assert.equal(p.order.type,'limit');
  assert.equal(p.order.qty,String(base.qty));
  assert.equal('take_profit' in p.order,false);
  assert.equal('stop_loss' in p.order,false);
  assert.equal(p.flatten_before_close,true);
});
test('whole shares retain broker-side stop and target brackets',()=>{
  const p=buildEquityEntryOrder({...base,symbol:'F',qty:2,limitPrice:'12.00',
    stopPrice:'11.40',takeProfitPrice:'13.25'});
  assert.equal(p.ok,true);
  assert.equal(p.order.order_class,'bracket');
  assert.equal(p.order.qty,'2');
  assert.equal(p.order.stop_loss.stop_price,'11.40');
  assert.equal(p.order.take_profit.limit_price,'13.25');
  assert.equal(p.flatten_before_close,false);
});
test('order helper fails closed on missing or incoherent risk prices',()=>{
  for(const change of [{qty:0},{qty:Infinity},{stopPrice:'600.00'},
      {takeProfitPrice:'500.00'},{symbol:'BAD/XYZ'},
      {clientOrderId:'a'.repeat(50)}]){
    const p=buildEquityEntryOrder({...base,...change});
    assert.equal(p.ok,false,JSON.stringify(change));
  }
});
