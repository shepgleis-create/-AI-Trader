import test from 'node:test';
import assert from 'node:assert/strict';
import {providerMetadata,validateMarketResearchEvent} from './event-contract.mjs';
import {normalizeCoinbaseTicker} from './stream-core.mjs';
import {tradierQuoteToEvent} from './tradier-market.mjs';
const now=Date.parse('2026-10-19T15:00:01Z');
test('neutral bus accepts provenance-correct public exchange tick and entitled brokerage quote',()=>{
 const coin=normalizeCoinbaseTicker({
  type:'ticker',product_id:'BTC-USD',price:'70000',
  best_bid:'69999',best_ask:'70001',time:'2026-10-19T15:00:00Z'
 },now);
 const stock=tradierQuoteToEvent({
  symbol:'SPY',type:'etf',last:530,bid:529.99,ask:530.01,
  trade_date:Date.parse('2026-10-19T15:00:00Z')
 },{receivedAt:now});
 assert.equal(validateMarketResearchEvent(coin).valid,true);
 assert.equal(validateMarketResearchEvent(stock).valid,true);
 assert.equal(providerMetadata().TRADIER_BROKERAGE_CONSOLIDATED.execution_supported,false);
});
test('never allow broker order commands or rebranding delayed sandbox data as consolidated live',()=>{
 const delayed=tradierQuoteToEvent({
  symbol:'AAPL',type:'stock',last:259,
  trade_date:Date.parse('2026-10-19T14:44:00Z')
 },{sandbox:true,receivedAt:now});
 assert.equal(validateMarketResearchEvent(delayed).valid,true);
 assert.equal(validateMarketResearchEvent({...delayed,
  source:'TRADIER_BROKERAGE_CONSOLIDATED'}).reason,'INCORRECT_DATA_COVERAGE');
 assert.equal(validateMarketResearchEvent({...delayed,execution_allowed:true}).reason,
   'EXECUTION_NOT_ALLOWED_ON_DATA_BUS');
 assert.equal(validateMarketResearchEvent({...delayed,kind:'PLACE_ORDER'}).valid,false);
});
test('reject missing, crossed and future-time quotes without inventing market data',()=>{
 const e=tradierQuoteToEvent({
  symbol:'MSFT',last:531,bid:530.99,ask:531.01,
  trade_date:Date.parse('2026-10-19T15:00:00Z')
 },{receivedAt:now});
 assert.equal(validateMarketResearchEvent({...e,ask:500}).valid,false);
 assert.equal(validateMarketResearchEvent({...e,event_at:'2026-10-19T16:00:00Z'}).valid,false);
 assert.equal(validateMarketResearchEvent({...e,source:'INVALID_PROVIDER'}).valid,false);
});
