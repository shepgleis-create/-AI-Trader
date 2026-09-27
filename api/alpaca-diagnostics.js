import { requireDashboardAuth } from '../lib/auth.js';

async function retryFetch(url,options={},attempts=3){
  let last=null;
  for(let i=0;i<attempts;i++){
    const started=Date.now();
    last=await fetch(url,options);
    last._elapsed=Date.now()-started;
    if(last.status!==429&&last.status<500)return last;
    if(i<attempts-1){
      const retryAfter=Number(last.headers.get('retry-after')||0);
      await new Promise(r=>setTimeout(r,retryAfter>0?retryAfter*1000:300*(i+1)));
    }
  }
  return last;
}

async function probe(name,url,headers){
  try{
    const r=await retryFetch(url,{headers});
    const body=await r.json().catch(()=>({}));
    return{
      name,
      ok:r.ok,
      status:r.status,
      elapsed_ms:r._elapsed||null,
      message:r.ok?null:String(body?.message||body?.error||r.statusText||'request failed').slice(0,220)
    };
  }catch(e){
    return{name,ok:false,status:null,elapsed_ms:null,message:String(e?.message||'network error').slice(0,220)};
  }
}

export default async function handler(req,res){
  if(!requireDashboardAuth(req,res))return;
  if(req.method!=='GET')return res.status(405).json({error:'Method not allowed'});

  const key=process.env.ALPACA_API_KEY;
  const secret=process.env.ALPACA_SECRET_KEY;
  const baseUrl=process.env.ALPACA_BASE_URL||'https://paper-api.alpaca.markets';

  if(!key||!secret)return res.status(500).json({error:'Missing Alpaca credentials'});
  if(!baseUrl.includes('paper-api.alpaca.markets'))return res.status(403).json({error:'Paper endpoint safety lock failed'});

  const headers={
    'APCA-API-KEY-ID':key,
    'APCA-API-SECRET-KEY':secret
  };

  const historyUrl=new URL(`${baseUrl}/v2/account/portfolio/history`);
  historyUrl.searchParams.set('period','1M');
  historyUrl.searchParams.set('timeframe','1D');

  const tests=[
    ['Account',`${baseUrl}/v2/account`],
    ['Market clock',`${baseUrl}/v2/clock`],
    ['Positions',`${baseUrl}/v2/positions`],
    ['Open orders',`${baseUrl}/v2/orders?status=open&limit=100&nested=true`],
    ['Recent orders',`${baseUrl}/v2/orders?status=all&limit=500&direction=desc&nested=true`],
    ['Portfolio history',historyUrl.toString()],
    ['Market data','https://data.alpaca.markets/v2/stocks/SPY/snapshot?feed=iex']
  ];

  const results=[];
  for(const [name,url] of tests){
    results.push(await probe(name,url,headers));
    await new Promise(r=>setTimeout(r,80));
  }

  return res.status(200).json({
    ok:results.every(x=>x.ok),
    results,
    checked_at:new Date().toISOString()
  });
}
