import {normalizeMover,rankMoverRows,screenMoverRows} from './mover-research.js';
import {fetchBarsForSymbols} from './strategy.js';
import {fetchCryptoScan} from './multi-asset.js';

function headers(key,secret){return {'APCA-API-KEY-ID':key,'APCA-API-SECRET-KEY':secret}}
const timeout=ms=>AbortSignal.timeout(ms);
const chunks=(items,size)=>Array.from({length:Math.ceil(items.length/size)},(_,i)=>items.slice(i*size,(i+1)*size));
async function getJson(url,key,secret,ms=7000){
  const response=await fetch(url,{headers:headers(key,secret),signal:timeout(ms)});
  const body=await response.json().catch(()=>null);
  if(!response.ok)return {ok:false,status:response.status,
    reason:String(body?.message||body?.error||'Market data HTTP '+response.status).slice(0,120)};
  return {ok:true,data:body};
}
export async function providerMovers(market,key,secret){
  const url='https://data.alpaca.markets/v1beta1/screener/'+
    (market==='crypto'?'crypto':'stocks')+'/movers?top=50';
  const r=await getJson(url,key,secret);
  if(!r.ok)return {...r,items:[]};
  const data=r.data||{};
  const items=[
    ...(Array.isArray(data.gainers)?data.gainers:[]).map(x=>normalizeMover(x,'gainers')),
    ...(Array.isArray(data.losers)?data.losers:[]).map(x=>normalizeMover(x,'losers'))
  ].filter(Boolean);
  if(!items.length)return {ok:false,status:200,reason:'Screener returned no valid symbols',items:[]};
  return {ok:true,items,last_updated:data.last_updated||null,
    source:'ALPACA_MOVERS'};
}
function readIexSnapshot(symbol,s){
  const daily=s?.dailyBar||s?.daily_bar||{};
  const previous=s?.prevDailyBar||s?.prev_daily_bar||{};
  const trade=s?.latestTrade||s?.latest_trade||{};
  const minute=s?.minuteBar||s?.minute_bar||{};
  const price=Number(trade.p||minute.c||daily.c||0);
  const close=Number(previous.c||0);
  if(!(price>0&&close>0))return null;
  return {symbol,price,day_pct:(price/close-1)*100,
    day_change_dollars:price-close,provider:'IEX_SNAPSHOT',
    direction:price>=close?'gainers':'losers'};
}
async function fallbackStocks(key,secret){
  const assets=await getJson('https://paper-api.alpaca.markets/v2/assets?status=active&asset_class=us_equity',key,secret,7000);
  if(!assets.ok||!Array.isArray(assets.data))
    throw Error('Stock screener unavailable and fallback equities unavailable: '+(assets.reason||'empty assets'));
  const symbols=assets.data.filter(a=>a.tradable&&a.status==='active'&&
    /^[A-Z.]{1,12}$/.test(String(a.symbol||''))).map(a=>a.symbol);
  const batches=chunks(symbols,110);
  const found=[],concurrency=6;
  const deadline=Date.now()+22000;
  for(let i=0;i<batches.length;i+=concurrency){
    if(Date.now()>deadline)break;
    const pages=await Promise.allSettled(batches.slice(i,i+concurrency).map(async batch=>{
      const url=new URL('https://data.alpaca.markets/v2/stocks/snapshots');
      url.searchParams.set('symbols',batch.join(','));
      url.searchParams.set('feed','iex');
      const r=await getJson(url,key,secret,7500);
      if(!r.ok)return [];
      const snapshots=r.data?.snapshots||r.data||{};
      return Object.entries(snapshots)
        .map(([symbol,s])=>readIexSnapshot(symbol,s)).filter(Boolean);
    }));
    for(const p of pages)if(p.status==='fulfilled')found.push(...p.value);
    if(found.length>=3500)break;
  }
  if(!found.length)throw Error('IEX fallback returned no current stock movers; coverage may require another data feed');
  const sorted=[...found].sort((a,b)=>Math.abs(b.day_pct)-Math.abs(a.day_pct));
  return {ok:true,items:sorted.slice(0,150),source:'IEX_SNAPSHOT',
    warning:'Alpaca consolidated SIP movers unavailable; using IEX-exchange-only snapshots. Thinly traded movers may be absent.',
    screened_symbols:symbols.length,priced_symbols:found.length};
}
async function cryptoFallback(key,secret){
  const scan=await fetchCryptoScan(key,secret);
  const items=(scan.candidates||[]).map(c=>({
    symbol:c.symbol,price:c.price,day_pct:Number(c.day_change)*100,
    day_change_dollars:null,provider:'CRYPTO_SCANNER',
    direction:Number(c.day_change)>=0?'gainers':'losers'
  })).filter(c=>c.price>0&&Number.isFinite(c.day_pct));
  return {ok:true,items,source:'CRYPTO_SCANNER',
    warning:'Crypto movers screener unavailable. Results cover the existing scanner shortlist, not every listed coin.',
    screened_symbols:scan.eligible_crypto_assets||items.length};
}
async function cryptoBars(symbols,key,secret){
  const out={},start=new Date(Date.now()-60*86400000).toISOString();
  const batches=chunks(symbols,18);
  for(let i=0;i<batches.length;i+=4){
    const pages=await Promise.allSettled(batches.slice(i,i+4).map(async batch=>{
      const url=new URL('https://data.alpaca.markets/v1beta3/crypto/us/bars');
      url.searchParams.set('symbols',batch.join(','));
      url.searchParams.set('timeframe','1Day');
      url.searchParams.set('start',start);
      url.searchParams.set('limit','10000');
      const r=await getJson(url,key,secret,9000);
      return r.ok?r.data?.bars||{}:{};
    }));
    for(const p of pages)if(p.status==='fulfilled')Object.assign(out,p.value);
  }
  return out;
}
let cache={};
export async function loadMarketMovers({market='stocks',window='1d',direction='gainers',key,secret}={}){
  if(!['stocks','crypto'].includes(market))throw Error('Unsupported mover market');
  if(!['1d','1w','1m'].includes(window))throw Error('Unsupported mover timeframe');
  if(!['gainers','losers'].includes(direction))throw Error('Unsupported mover direction');
  const token=market;
  let data=cache[token];
  if(!data||data.expires<Date.now()){
    const provider=await providerMovers(market,key,secret);
    const fallback=provider.ok?provider:
      market==='crypto'?await cryptoFallback(key,secret):await fallbackStocks(key,secret);
    const universe=fallback.items.slice(0,170);
    const symbols=[...new Set(universe.map(r=>r.symbol))].filter(Boolean);
    let bars={},history_warning=null;
    try{
      bars=market==='crypto'
        ?await cryptoBars(symbols,key,secret)
        :await fetchBarsForSymbols(symbols,key,secret,50);
    }catch(e){
      history_warning='Weekly and monthly historical bars unavailable: '+String(e?.message||'unknown').slice(0,140);
    }
    const rows=rankMoverRows({market,providers:universe,bars,limit:170});
    data={rows,market,provider:fallback.source,warning:fallback.warning||null,
      history_warning,provider_updated_at:fallback.last_updated||null,
      coverage:{
        candidates_observed:rows.length,
        source:fallback.source,
        universe_note:provider.ok
          ?'Daily top gainers and losers from Alpaca (up to 50 each); weekly/monthly are ranked within this daily-mover set, NOT the entire market.'
          :'Fallback market coverage is incomplete. Do not treat these as exhaustive market-wide leaders.',
        symbols_queried:fallback.screened_symbols||symbols.length,
        symbols_priced:fallback.priced_symbols||rows.length,
        subscription_restriction:provider.ok?null:provider.reason
      },generated_at:new Date().toISOString(),expires:Date.now()+90000};
    cache[token]=data;
  }
  return {...data,rows:screenMoverRows(data.rows,{window,direction,limit:60}),
    timeframe:window,direction};
}
export async function latestMoverSet(market,key,secret){
  const d=await loadMarketMovers({market,key,secret,window:'1d',direction:'gainers'});
  return {rows:d.rows.slice(0,50),source:d.provider,coverage:d.coverage,generated_at:d.generated_at};
}
