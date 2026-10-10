const DEFAULT_MODELS=[
  'gemini-3.8-flash',
  'gemini-3.7-flash',
  'gemini-3.6-flash',
  'gemini-3.5-flash-lite'
];

function shouldFallback(status){
  return status===404||status===408||status===429||status===500||status===502||status===503||status===504;
}

export async function generateStructuredGemini({
  apiKey,
  prompt,
  schema,
  models=DEFAULT_MODELS,
  totalTimeoutMs=10000,
  perModelTimeoutMs=2600
}){
  if(!apiKey)throw new Error('GEMINI_API_KEY is not configured');

  const errors=[];
  const deadline=Date.now()+Math.max(1000,Math.min(20000,Number(totalTimeoutMs)||10000));
  for(const model of models){
    const remaining=deadline-Date.now();
    if(remaining<300){errors.push('AI request time budget exhausted');break}
    let response;
    let data={};
    try{
      response=await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
        {
          method:'POST',
          signal:AbortSignal.timeout(Math.min(Math.max(500,Number(perModelTimeoutMs)||2600),remaining)),
          headers:{
            'x-goog-api-key':apiKey,
            'Content-Type':'application/json'
          },
          body:JSON.stringify({
            contents:[{parts:[{text:prompt}]}],
            generationConfig:{
              responseFormat:{
                text:{
                  mimeType:'APPLICATION_JSON',
                  schema
                }
              }
            }
          })
        }
      );
      data=await response.json().catch(()=>({}));
    }catch(error){
      errors.push(`${model}: network error ${String(error?.message||error).slice(0,120)}`);
      continue;
    }

    if(!response.ok){
      const msg=String(data?.error?.message||response.statusText||'request failed').slice(0,180);
      errors.push(`${model} HTTP ${response.status}: ${msg}`);
      if(shouldFallback(response.status))continue;
      throw new Error(msg);
    }

    const text=data?.candidates?.[0]?.content?.parts
      ?.map(p=>p?.text||'')
      .join('')
      .trim();

    if(!text){
      errors.push(`${model}: empty response`);
      continue;
    }

    let parsed;
    try{parsed=JSON.parse(text)}
    catch{
      errors.push(`${model}: unreadable structured response`);
      continue;
    }

    return {
      model,
      parsed,
      fallback_used:model!==models[0],
      attempted_models:models.slice(0,models.indexOf(model)+1)
    };
  }

  throw new Error(
    `Gemini models are temporarily unavailable — ${errors.slice(0,4).join(' · ')}`
  );
}
