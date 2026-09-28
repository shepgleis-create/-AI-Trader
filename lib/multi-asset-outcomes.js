function sleep(ms){return new Promise(r=>setTimeout(r,ms));}

async function resilientFetch(url,opts={},attempts=4){
  let last=null;
  for(let i=0;i<attempts;i++){
    last=await fetch(url,opts);
    if(last.status!==429&&last.status<500)return last;
    if(i<attempts-1){
      const retryAfter=Number(last.headers.get('retry-after')||0);
      await sleep(retryAfter>0?retryAfter*1000:450*(i+1));
    }
  }
  return last;
}

function chunks(rows,size){
  const out=[];
  for(let i=0;i<rows.length;i+=size)out.push(rows.slice(i,i+size));
  return out;
}

function dateKey(v){
  return String(v?.t||v||'').slice(0,10);
}

function sortBars(map){
  for(const symbol of Object.keys(map)){
    map[symbol].sort((a,b)=>String(a.t).localeCompare(String(b.t)));
  }
  return map;
}

async function pagedBars({url,params,headers,symbols,batchSize=40}){
  const out={};
  for(const batch of chunks(symbols,batchSize)){
    let token=null;
    let guard=0;
    do{
      const u=new URL(url);
      for(const [k,v] of Object.entries(params||{})){
        if(v!=null&&v!=='')u.searchParams.set(k,String(v));
      }
      u.searchParams.set('symbols',batch.join(','));
      u.searchParams.set('limit','10000');
      if(token)u.searchParams.set('page_token',token);

      const r=await resilientFetch(u,{headers});
      const data=await r.json().catch(()=>({}));
      if(!r.ok){
        const detail=String(data?.message||data?.error||r.statusText||'historical bars failed');
        throw new Error(`${u.pathname} HTTP ${r.status}: ${detail}`);
      }
      for(const [symbol,bars] of Object.entries(data?.bars||{})){
        out[symbol]=(out[symbol]||[]).concat(Array.isArray(bars)?bars:[]);
      }
      token=data?.next_page_token||null;
      guard++;
    }while(token&&guard<12);
  }
  return sortBars(out);
}

function laneReference(laneName,lane){
  if(!lane)return null;
  if(laneName==='LONG_CALL'||laneName==='LONG_PUT'){
    const p=Number(lane.mid||lane.ask||0);
    return p>0?p:null;
  }
  const p=Number(lane.price||0);
  return p>0?p:null;
}

function laneTicker(laneName,lane){
  if(!lane)return null;
  if(laneName==='LONG_CALL'||laneName==='LONG_PUT')return lane.contract||null;
  return lane.symbol||null;
}

function laneClass(laneName){
  if(laneName==='CRYPTO_LONG')return 'crypto';
  if(laneName==='LONG_CALL'||laneName==='LONG_PUT')return 'option';
  if(laneName==='LONG_EQUITY'||laneName==='SHORT_EQUITY')return 'stock';
  return null;
}

function directionalReturn(laneName,reference,close){
  if(!(reference>0&&close>0))return null;
  const raw=close/reference-1;
  return laneName==='SHORT_EQUITY'?-raw:raw;
}

function firstHourlyAfter(bars,createdAt){
  const target=new Date(createdAt).getTime()+60*60*1000;
  if(!Number.isFinite(target))return null;
  return (bars||[]).find(b=>{
    const t=new Date(b.t).getTime();
    return Number.isFinite(t)&&t>=target;
  })||null;
}

function dailyAtHorizon(bars,createdAt,index){
  const decisionDay=new Date(createdAt).toISOString().slice(0,10);
  const future=(bars||[])
    .filter(b=>dateKey(b)>decisionDay&&Number(b?.c)>0)
    .sort((a,b)=>String(a.t).localeCompare(String(b.t)));
  return future.length>index?future[index]:null;
}

function horizonResult(row,horizon,bars){
  const lanes=row?.lanes&&typeof row.lanes==='object'?row.lanes:{};
  const laneReturns={};
  const lanePrices={};
  const missing=[];

  for(const [laneName,lane] of Object.entries(lanes)){
    if(!lane)continue;
    const cls=laneClass(laneName);
    const symbol=laneTicker(laneName,lane);
    const reference=laneReference(laneName,lane);
    if(!cls||!symbol||!(reference>0))continue;

    const source=bars?.[cls]?.[horizon]?.[symbol]||[];
    const bar=horizon==='h1'
      ?firstHourlyAfter(source,row.created_at)
      :dailyAtHorizon(source,row.created_at,horizon==='d1'?0:horizon==='d3'?2:4);

    const close=Number(bar?.c||0);
    if(!(close>0)){
      missing.push(laneName);
      continue;
    }

    laneReturns[laneName]=directionalReturn(laneName,reference,close);
    lanePrices[laneName]={
      reference,
      close,
      at:bar.t||null,
      symbol
    };
  }

  const available=Object.entries(laneReturns)
    .filter(([,v])=>Number.isFinite(v));

  const selected=String(row.selected_lane||'SKIP');
  const chosenReturn=selected==='SKIP'
    ?0
    :(Number.isFinite(laneReturns[selected])?laneReturns[selected]:null);

  const ranked=[['CASH',0],...available]
    .sort((a,b)=>b[1]-a[1]);
  const best=ranked[0]||['CASH',0];

  return {
    lane_returns:laneReturns,
    lane_prices:lanePrices,
    missing_lanes:missing,
    chosen_lane:selected,
    chosen_return:chosenReturn,
    best_lane:best[0],
    best_return:best[1],
    opportunity_cost:chosenReturn==null?null:best[1]-chosenReturn,
    selected_best:chosenReturn==null?null:(chosenReturn>=best[1]-1e-12)
  };
}

export async function loadOutcomeBars(rows,key,secret){
  const decisions=Array.isArray(rows)?rows:[];
  if(!decisions.length)return {};

  const earliest=Math.min(...decisions.map(x=>new Date(x.created_at).getTime()).filter(Number.isFinite));
  const start=new Date(earliest-2*60*60*1000);
  const end=new Date(Date.now()+60*60*1000);
  const headers={
    'APCA-API-KEY-ID':key,
    'APCA-API-SECRET-KEY':secret
  };

  const symbols={stock:new Set(),crypto:new Set(),option:new Set()};
  for(const row of decisions){
    const lanes=row?.lanes&&typeof row.lanes==='object'?row.lanes:{};
    for(const [laneName,lane] of Object.entries(lanes)){
      const cls=laneClass(laneName);
      const symbol=laneTicker(laneName,lane);
      if(cls&&symbol)symbols[cls].add(symbol);
    }
  }

  const out={
    stock:{h1:{},d1:{}},
    crypto:{h1:{},d1:{}},
    option:{h1:{},d1:{}},
    errors:{}
  };

  const jobs=[];
  const stock=[...symbols.stock];
  if(stock.length){
    jobs.push(
      pagedBars({
        url:'https://data.alpaca.markets/v2/stocks/bars',
        params:{timeframe:'1Hour',start:start.toISOString(),end:end.toISOString(),adjustment:'all',feed:'iex'},
        headers,symbols:stock,batchSize:40
      }).then(x=>{out.stock.h1=x}).catch(e=>{out.errors.stock_h1=String(e.message||e)}),
      pagedBars({
        url:'https://data.alpaca.markets/v2/stocks/bars',
        params:{timeframe:'1Day',start:start.toISOString(),end:end.toISOString(),adjustment:'all',feed:'iex'},
        headers,symbols:stock,batchSize:40
      }).then(x=>{out.stock.d1=x}).catch(e=>{out.errors.stock_d1=String(e.message||e)})
    );
  }

  const crypto=[...symbols.crypto];
  if(crypto.length){
    jobs.push(
      pagedBars({
        url:'https://data.alpaca.markets/v1beta3/crypto/us/bars',
        params:{timeframe:'1Hour',start:start.toISOString(),end:end.toISOString()},
        headers,symbols:crypto,batchSize:25
      }).then(x=>{out.crypto.h1=x}).catch(e=>{out.errors.crypto_h1=String(e.message||e)}),
      pagedBars({
        url:'https://data.alpaca.markets/v1beta3/crypto/us/bars',
        params:{timeframe:'1Day',start:start.toISOString(),end:end.toISOString()},
        headers,symbols:crypto,batchSize:25
      }).then(x=>{out.crypto.d1=x}).catch(e=>{out.errors.crypto_d1=String(e.message||e)})
    );
  }

  const options=[...symbols.option];
  if(options.length){
    jobs.push(
      pagedBars({
        url:'https://data.alpaca.markets/v1beta1/options/bars',
        params:{timeframe:'1Hour',start:start.toISOString(),end:end.toISOString()},
        headers,symbols:options,batchSize:50
      }).then(x=>{out.option.h1=x}).catch(e=>{out.errors.option_h1=String(e.message||e)}),
      pagedBars({
        url:'https://data.alpaca.markets/v1beta1/options/bars',
        params:{timeframe:'1Day',start:start.toISOString(),end:end.toISOString()},
        headers,symbols:options,batchSize:50
      }).then(x=>{out.option.d1=x}).catch(e=>{out.errors.option_d1=String(e.message||e)})
    );
  }

  await Promise.all(jobs);

  out.stock.d3=out.stock.d1;
  out.stock.d5=out.stock.d1;
  out.crypto.d3=out.crypto.d1;
  out.crypto.d5=out.crypto.d1;
  out.option.d3=out.option.d1;
  out.option.d5=out.option.d1;

  return out;
}

export function gradeMultiAssetDecision(row,bars){
  const previous=row?.outcome&&typeof row.outcome==='object'?row.outcome:{};
  const ageMs=Date.now()-new Date(row.created_at).getTime();
  const next={...previous};

  if(ageMs>=55*60*1000&&!next.h1){
    const h=horizonResult(row,'h1',bars);
    if(Object.keys(h.lane_returns).length||String(row.selected_lane)==='SKIP')next.h1=h;
  }
  if(ageMs>=20*60*60*1000&&!next.d1){
    const h=horizonResult(row,'d1',bars);
    if(Object.keys(h.lane_returns).length||String(row.selected_lane)==='SKIP')next.d1=h;
  }
  if(ageMs>=3*20*60*60*1000&&!next.d3){
    const h=horizonResult(row,'d3',bars);
    if(Object.keys(h.lane_returns).length||String(row.selected_lane)==='SKIP')next.d3=h;
  }
  if(ageMs>=5*20*60*60*1000&&!next.d5){
    const h=horizonResult(row,'d5',bars);
    if(Object.keys(h.lane_returns).length||String(row.selected_lane)==='SKIP')next.d5=h;
  }

  if(ageMs>=10*24*60*60*1000)next.complete_5d=true;
  else if(next.d5){
    const lanes=Object.values(row?.lanes||{}).filter(Boolean).length;
    const graded=Object.keys(next.d5.lane_returns||{}).length;
    if(lanes===0||graded>=lanes)next.complete_5d=true;
  }

  next.last_graded_at=new Date().toISOString();
  next.data_errors=bars?.errors||{};
  return next;
}
