import test from 'node:test';
import assert from 'node:assert/strict';
import {rankEquityShortlist,equityOpportunityQuality} from '../lib/opportunity-ranking.js';

const c=(symbol,spread,age,score=100)=>({
  symbol,score,spread_pct:spread,data_age_seconds:age,
  rs_percentile:0.85,avg_dollar_volume_20d:150000000,atr_pct:0.025
});

test('cost and quote quality distinguish equal scanner scores',()=>{
 const names=rankEquityShortlist([c('WIDE',0.012,1200),c('TIGHT',0.0005,40),c('MID',0.003,240)],{entryThreshold:82,limit:3}).map(x=>x.symbol);
 assert.deepEqual(names,['TIGHT','MID','WIDE']);
});

test('previous positions and outstanding orders remain blocked',()=>{
 const chosen=rankEquityShortlist([c('A',0.001,90),c('B',0.001,90),c('C',0.001,90)],{
   held:new Set(['A']),ordered:new Set(['B'])
 }).map(x=>x.symbol);
 assert.deepEqual(chosen,['C']);
});

test('small-sample historical return never increases quality score',()=>{
 const basic=c('X',0.001,90);
 assert.equal(
   equityOpportunityQuality({...basic,historical_edge:{samples:2,avg_5d_return:0.9,win_rate:1}}).rank_score,
   equityOpportunityQuality(basic).rank_score
 );
});
