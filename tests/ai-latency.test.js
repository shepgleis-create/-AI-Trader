import test from 'node:test';
import assert from 'node:assert/strict';
import {generateStructuredGemini} from '../lib/gemini-client.js';

test('unavailable AI model falls back to a working model instead of silently hanging',async()=>{
 const before=globalThis.fetch;
 const calls=[];
 try{
  globalThis.fetch=async (url,options)=>{
   calls.push({url:String(url),has_signal:Boolean(options.signal)});
   if(calls.length===1)return {ok:false,status:404,statusText:'Not Found',
     json:async()=>({error:{message:'No such model'}})};
   return {ok:true,json:async()=>({candidates:[{content:{parts:[{text:'{"action":"SKIP","symbol":"","confidence":60,"rationale":"No edge"}'}]}}]})};
  };
  const result=await generateStructuredGemini({
   apiKey:'test-key',prompt:'test',schema:{type:'object'},
   models:['unavailable-model','working-model']
  });
  assert.equal(result.model,'working-model');
  assert.equal(result.fallback_used,true);
  assert.equal(result.parsed.action,'SKIP');
  assert.equal(calls.length,2);
  assert.ok(calls.every(c=>c.has_signal));
 }finally{globalThis.fetch=before}
});
