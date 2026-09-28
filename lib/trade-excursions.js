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

function laneClass(lane){
  if(lane==='CRYPTO_LONG')return 'crypto';
  if(lane==='LONG_CALL'||lane==='LONG_PUT'||lane==='OPTION_UNKNOWN')return 'option';
  return 'stock';
}

async function fetchBars({url,headers,symbols,start,end,timeframe,batchSize,extra={}}){
  const out={};
  for(const batch of chunks(symbols,batchSize)){
    let token=null;
    let guard=0;
    do{
      const u=new URL(url);
      u.searchParams.set('symbols',batch.join(','));
      u.searchParams.set('timeframe',timeframe);
      u.searchParams.set('start',start.toISOString());
      u.searchParams.set('end',end.toISOString());
      u.searchParams.set('limit','10000');
      for(const [k,v] of Object.entries(extra))u.searchParams.set(k,String(v));
      if(token)u.searchParams.set('page_token',token);

      const r=await resilientFetch(u,{headers});
      const data=await r.json().catch(()=>({}));
      if(!r.ok){
        throw new Error(`${u.pathname} HTTP ${r.status}: ${String(data?.message||data?.error||r.statusText||'bars failed')}`);
      }
      for(const [symbol,bars] of Object.entries(data?.bars||{})){
        out[symbol]=(out[symbol]||[]).concat(Array.isArray(bars)?bars:[]);
      }
      token=data?.next_page_token||null;
      guard++;
    }while(token&&guard<12);
  }
  for(const symbol of Object.keys(out)){
    out[symbol].sort((a,b)=>String(a.t).localeCompare(String(b.t)));
  }
  return out;
}

export async function loadExcursionBars(trades,key,secret){
  const rows=(Array.isArray(trades)?trades:[]).filter(t=>t.entry_time&&t.exit_time);
  if(!rows.length)return {stock:{},crypto:{},option:{},errors:{}};

  const earliest=Math.min(...rows.map(t=>new Date(t.entry_time).getTime()).filter(Number.isFinite));
  const latest=Math.max(...rows.map(t=>new Date(t.exit_time).getTime()).filter(Number.isFinite));
  const start=new Date(earliest-30*60*1000);
  const end=new Date(latest+30*60*1000);
  const headers={
    'APCA-API-KEY-ID':key,
    'APCA-API-SECRET-KEY':secret
  };

  const symbols={stock:new Set(),crypto:new Set(),option:new Set()};
  for(const t of rows)symbols[laneClass(t.lane)].add(t.symbol);

  const result={stock:{},crypto:{},option:{},errors:{}};
  const jobs=[];

  if(symbols.stock.size){
    jobs.push(fetchBars({
      url:'https://data.alpaca.markets/v2/stocks/bars',
      headers,
      symbols:[...symbols.stock],
      start,end,timeframe:'15Min',batchSize:40,
      extra:{adjustment:'all',feed:'iex'}
    }).then(x=>{result.stock=x}).catch(e=>{result.errors.stock=String(e.message||e)}));
  }
  if(symbols.crypto.size){
    jobs.push(fetchBars({
      url:'https://data.alpaca.markets/v1beta3/crypto/us/bars',
      headers,
      symbols:[...symbols.crypto],
      start,end,timeframe:'15Min',batchSize:25
    }).then(x=>{result.crypto=x}).catch(e=>{result.errors.crypto=String(e.message||e)}));
  }
  if(symbols.option.size){
    jobs.push(fetchBars({
      url:'https://data.alpaca.markets/v1beta1/options/bars',
      headers,
      symbols:[...symbols.option],
      start,end,timeframe:'15Min',batchSize:50
    }).then(x=>{result.option=x}).catch(e=>{result.errors.option=String(e.message||e)}));
  }

  await Promise.all(jobs);
  return result;
}

export function tradeExcursion(trade,barsByClass){
  const cls=laneClass(trade.lane);
  const bars=(barsByClass?.[cls]?.[trade.symbol]||[]);
  const start=new Date(trade.entry_time).getTime();
  const end=new Date(trade.exit_time).getTime();
  const entry=Number(trade.entry_price||0);
  if(!(entry>0&&Number.isFinite(start)&&Number.isFinite(end)))return null;

  const held=bars.filter(b=>{
    const t=new Date(b.t).getTime();
    return Number.isFinite(t)&&t>=start&&t<=end;
  });
  if(!held.length)return null;

  let mfe=-Infinity;
  let mae=Infinity;
  const isShort=trade.lane==='SHORT_EQUITY';

  for(const b of held){
    const high=Number(b.h||0),low=Number(b.l||0);
    if(!(high>0&&low>0))continue;

    const favorable=isShort?(entry-low)/entry:(high-entry)/entry;
    const adverse=isShort?(entry-high)/entry:(low-entry)/entry;

    if(Number.isFinite(favorable))mfe=Math.max(mfe,favorable);
    if(Number.isFinite(adverse))mae=Math.min(mae,adverse);
  }

  if(!Number.isFinite(mfe)||!Number.isFinite(mae))return null;

  const realized=Number(trade.return_pct||0);
  return {
    ...trade,
    mfe,
    mae,
    captured_mfe_ratio:mfe>0?realized/mfe:null,
    drawdown_to_return_ratio:realized!==0?Math.abs(mae)/Math.abs(realized):null,
    bars_observed:held.length
  };
}

function avg(rows,field){
  const vals=rows.map(x=>Number(x?.[field])).filter(Number.isFinite);
  return vals.length?vals.reduce((a,b)=>a+b,0)/vals.length:null;
}

function summarize(rows){
  return {
    trades:rows.length,
    avg_mfe:avg(rows,'mfe'),
    avg_mae:avg(rows,'mae'),
    avg_realized_return:avg(rows,'return_pct'),
    avg_mfe_capture:avg(rows,'captured_mfe_ratio'),
    avg_drawdown_to_return:avg(rows,'drawdown_to_return_ratio')
  };
}

export function summarizeExcursions(rows=[]){
  const all=Array.isArray(rows)?rows:[];
  const lanes=['LONG_EQUITY','SHORT_EQUITY','CRYPTO_LONG','LONG_CALL','LONG_PUT'];
  const byLane={};
  for(const lane of lanes)byLane[lane]=summarize(all.filter(x=>x.lane===lane));
  return {total:summarize(all),by_lane:byLane};
}
