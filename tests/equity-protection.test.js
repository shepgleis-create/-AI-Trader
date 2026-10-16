import test from 'node:test';
import assert from 'node:assert/strict';
import {identifyBotFractionalPosition,equityProtectionDecision,newYorkMarketMinutes}
  from '../lib/equity-protection.js';

const position={asset_class:'us_equity',symbol:'MSFT',qty:'0.0463667',unrealized_plpc:'-0.037'};
const botBuy={id:'bot-1',symbol:'MSFT',side:'buy',client_order_id:'aitr-g-msft-demo',
  filled_qty:'0.0463667',filled_at:'2026-10-15T15:05:00Z'};

test('identifies an exact fractional bot fill and refuses unrelated account holdings',()=>{
 const recognized=identifyBotFractionalPosition(position,[botBuy]);
 assert.equal(recognized.managed,true);
 assert.equal(identifyBotFractionalPosition({...position,qty:'1'},[botBuy]).managed,false);
 assert.equal(identifyBotFractionalPosition({...position,symbol:'AAPL'},[botBuy]).managed,false);
 assert.equal(identifyBotFractionalPosition({...position,qty:'0.08'},[botBuy]).reason,
   'mixed_or_changed_position_quantity');
});
test('newer manual stock fills make bot ownership ineligible',()=>{
 const manual={symbol:'MSFT',side:'buy',client_order_id:'manual-investment',
   filled_qty:'0.0463667',filled_at:'2026-10-15T16:05:00Z'};
 assert.equal(identifyBotFractionalPosition(position,[botBuy,manual]).managed,false);
 const sell={...manual,side:'sell',client_order_id:'broker-close'};
 assert.equal(identifyBotFractionalPosition(position,[botBuy,sell]).managed,false);
});
test('five-minute risk decisions trigger on stop, target and close-window only',()=>{
 assert.deepEqual(equityProtectionDecision({unrealizedPct:-0.031,minutesEastern:660,marketOpen:true}),
   {action:'CLOSE',reason:'fractional_stop_loss_3pct'});
 assert.deepEqual(equityProtectionDecision({unrealizedPct:0.061,minutesEastern:660,marketOpen:true}),
   {action:'CLOSE',reason:'fractional_take_profit_6pct'});
 assert.equal(equityProtectionDecision({unrealizedPct:0,minutesEastern:945,marketOpen:true}).action,'CLOSE');
 assert.equal(equityProtectionDecision({unrealizedPct:0,minutesEastern:870,marketOpen:true}).action,'WAIT');
 assert.equal(equityProtectionDecision({unrealizedPct:-0.20,minutesEastern:900,marketOpen:false}).action,'WAIT');
});
test('New York timezone returns local minutes across daylight saving changes',()=>{
 assert.equal(newYorkMarketMinutes(new Date('2026-10-15T19:47:00Z')),15*60+47);
 assert.equal(newYorkMarketMinutes(new Date('2026-11-03T20:47:00Z')),15*60+47);
});
