import test from 'node:test';
import assert from 'node:assert/strict';
import {selectDeepResearchUniverse} from '../lib/momentum-universe.js';
function stock(i,override={}){
 return {symbol:'SYM'+i,price:15,dollarVolume:1_000_000+i*10000,
  dayChange:0.005,moveFromOpenPct:0.002,spreadPct:0.001,data_age_seconds:30,...override};
}
test('research selection includes safe emerging momentum names beyond liquidity-only leaders',()=>{
 const rows=Array.from({length:100},(_,i)=>stock(i));
 const newcomer=stock(998,{symbol:'EARLY',dollarVolume:1_100_000,
  dayChange:0.08,moveFromOpenPct:0.05});
 const picked=selectDeepResearchUniverse([...rows,newcomer],40);
 assert.equal(picked.length,40);
 assert.ok(picked.some(x=>x.symbol==='EARLY'));
});
test('extreme penny spikes and unacceptable execution spreads are not promoted',()=>{
 const rows=Array.from({length:45},(_,i)=>stock(i));
 const wild=stock(996,{symbol:'WILD',price:0.8,dayChange:1.4,
  moveFromOpenPct:1.1,dollarVolume:950_000});
 const wide=stock(997,{symbol:'WIDE',dayChange:0.1,
  moveFromOpenPct:0.08,dollarVolume:1_100_000,spreadPct:0.1});
 const picked=selectDeepResearchUniverse([...rows,wild,wide],25);
 assert.ok(!picked.some(x=>x.symbol==='WILD'));
 assert.ok(!picked.some(x=>x.symbol==='WIDE'));
});
