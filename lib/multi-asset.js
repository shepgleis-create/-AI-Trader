import { fetchBarsForSymbols } from './strategy.js';
import { isStablecoinCrypto } from './crypto-eligibility.js';

const STOCK_EXCHANGES=new Set(['NASDAQ','NYSE','ARCA','BATS','AMEX','NYSEARCA']);
const SECTOR_ETFS=['XLK','XLF','XLE','XLV','XLY','XLP','XLI','XLB','XLRE','XLC','XLU'];
const SHORT_SCAN_CACHE_MS=120_000;
const CRYPTO_SCAN_CACHE_MS=120_000;

function clamp(n,min,max){return Math.max(min,Math.min(max,n));}
function pct(a,b){return a>0&&b>0?b/a-1:0}
function sma(values,n){
  if(values.length<n)return null;
  const x=values.slice(-n);
  return x.reduce((a,b)=>a+b,0)/x.length;
}
function std(values){
  if(!values.length)return 0;
  const m=values.reduce((a,b)=>a+b,0)/values.length;
  return Math.sqrt(values.reduce((s,x)=>s+(x-m)**2,0)/values.length);
}
function rsi(values,n=14){
  if(values.length<n+1)return null;
  let gains=0,losses=0;
  for(let i=values.length-n;i<values.length;i++){
    const d=values[i]-values[i-1];
    if(d>=0)gains+=d;else losses-=d;
  }
  if(losses===0)return 100;
  const rs=(gains/n)/(losses/n);
  return 100-(100/(1+rs));
}
function atrPct(bars,n=14){
  if(!Array.isArray(bars)||bars.length<n+1)return null;
  const rows=bars.slice(-(n+1));
  const tr=[];
  for(let i=1;i<rows.length;i++){
    const h=Number(rows[i].h),l=Number(rows[i].l),pc=Number(rows[i-1].c);
    tr.push(Math.max(h-l,Math.abs(h-pc),Math.abs(l-pc)));
  }
  const price=Number(rows.at(-1).c);
  return price>0?tr.reduce((a,b)=>a+b,0)/n/price:null;
}
function annualVol(closes,n=20){
  if(closes.length<n+1)return null;
  const rows=closes.slice(-(n+1));
  const rs=[];
  for(let i=1;i<rows.length;i++)if(rows[i-1]>0)rs.push(rows[i]/rows[i-1]-1);
  return std(rs)*Math.sqrt(365);
}
function chunks(xs,n){
  const out=[];for(let i=0;i<xs.length;i+=n)out.push(xs.slice(i,i+n));return out;
}
async function mapLimit(items,limit,fn){
  const out=new Array(items.length);let next=0;
  async function worker(){while(true){const i=next++;if(i>=items.length)return;out[i]=await fn(items[i],i)}}
  await Promise.all(Array.from({length:Math.min(limit,items.length)},worker));
  return out;
}
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
function authHeaders(key,secret){
  return {'APCA-API-KEY-ID':key,'APCA-API-SECRET-KEY':secret};
}

async function fetchEquityAssets(key,secret){
  const r=await resilientFetch('https://paper-api.alpaca.markets/v2/assets?status=active&asset_class=us_equity',{
    headers:authHeaders(key,secret)
  });
  const data=await r.json().catch(()=>[]);
  if(!r.ok)throw new Error(data?.message||'Could not load equity assets');
  return (Array.isArray(data)?data:[]).filter(a=>
    a?.tradable===true&&
    STOCK_EXCHANGES.has(String(a?.exchange||'').toUpperCase())&&
    typeof a?.symbol==='string'
  );
}

async function fetchStockSnapshots(symbols,key,secret){
  const pages=await mapLimit(chunks(symbols,250),3,async batch=>{
    const u=new URL('https://data.alpaca.markets/v2/stocks/snapshots');
    u.searchParams.set('symbols',batch.join(','));
    u.searchParams.set('feed','iex');
    const r=await resilientFetch(u,{headers:authHeaders(key,secret)});
    if(!r.ok)return {};
    const d=await r.json().catch(()=>({}));
    return d?.snapshots||d||{};
  });
  return Object.assign({},...pages);
}

export function analyzeBearish(symbol,bars,context={}){
  const closes=(bars||[]).map(b=>Number(b.c)).filter(Number.isFinite);
  const volumes=(bars||[]).map(b=>Number(b.v)).filter(Number.isFinite);
  if(closes.length<55)return null;

  const price=closes.at(-1);
  const s20=sma(closes,20),s50=sma(closes,50);
  const mom5=pct(closes.at(-6),price),mom20=pct(closes.at(-21),price);
  const r=rsi(closes,14);
  const low20=Math.min(...closes.slice(-20));
  const avgVol=sma(volumes,20)||0;
  const volumeRatio=avgVol>0?(volumes.at(-1)||0)/avgVol:1;
  const atr=atrPct(bars,14);
  const vol=annualVol(closes,20);
  const spy20=Number(context.spy20||0);
  const relativeWeakness=spy20-mom20;
  const distanceFromLow=low20>0?(price-low20)/low20:1;

  let score=50;
  const reasons=[];
  if(price<s20){score+=12;reasons.push('Price below 20-day trend')}else score-=10;
  if(s20<s50){score+=15;reasons.push('20-day trend below 50-day trend')}else score-=12;
  if(mom20<=-0.08){score+=13;reasons.push('Strong negative 20-day momentum')}
  else if(mom20< -0.02){score+=7;reasons.push('Negative 20-day momentum')}
  else if(mom20>0.05)score-=10;
  if(mom5<0){score+=5;reasons.push('Negative 5-day momentum')}else score-=4;
  if(r>=30&&r<=48){score+=7;reasons.push('Bearish RSI without extreme oversold conditions')}
  else if(r<24){score-=12;reasons.push('Already extremely oversold')}
  if(distanceFromLow<=0.025){score+=6;reasons.push('Near 20-day low')}
  if(volumeRatio>=1.25){score+=5;reasons.push('Volume expansion')}
  if(relativeWeakness>=0.05){score+=8;reasons.push('Underperforming SPY')}
  else if(relativeWeakness>0)score+=3;
  if(vol!=null&&vol>1.2){score-=10;reasons.push('Very high realized volatility')}
  if(atr!=null&&atr>0.09){score-=9;reasons.push('Large ATR / squeeze risk')}

  score=clamp(Math.round(score),0,100);
  return {
    symbol,score,price,sma20:s20,sma50:s50,rsi14:r,
    momentum_5d:mom5,momentum_20d:mom20,
    relative_weakness_20d:relativeWeakness,
    distance_from_20d_low:distanceFromLow,
    atr_pct:atr,volatility_20d:vol,
    volume_ratio:volumeRatio,
    reasons:reasons.slice(0,6)
  };
}

export async function fetchShortScan(key,secret){
  const cached=globalThis.__aiTraderShortScanCache;
  if(cached?.value&&cached.expires>Date.now())return {...cached.value,cache_hit:true};
  const assets=await fetchEquityAssets(key,secret);
  const assetMap=new Map(assets.map(a=>[a.symbol,a]));
  const snapshots=await fetchStockSnapshots(assets.map(a=>a.symbol),key,secret);

  const liquid=Object.entries(snapshots).map(([symbol,s])=>{
    const d=s?.dailyBar||s?.daily_bar||{};
    const p=s?.prevDailyBar||s?.prev_daily_bar||{};
    const q=s?.latestQuote||s?.latest_quote||{};
    const t=s?.latestTrade||s?.latest_trade||{};
    const price=Number(t.p||d.c||0);
    const prev=Number(p.c||0);
    const volume=Number(d.v||0);
    const dv=price*volume;
    const bid=Number(q.bp||0),ask=Number(q.ap||0);
    const mid=bid>0&&ask>0?(bid+ask)/2:0;
    const spread=mid>0&&ask>=bid?(ask-bid)/mid:null;
    return {symbol,price,day_change:pct(prev,price),dollar_volume:dv,spread_pct:spread};
  }).filter(x=>x.price>=5&&x.dollar_volume>=5_000_000)
    .sort((a,b)=>(a.day_change-b.day_change)||b.dollar_volume-a.dollar_volume)
    .slice(0,180);

  const symbols=liquid.map(x=>x.symbol);
  const bars=await fetchBarsForSymbols([...new Set([...symbols,'SPY',...SECTOR_ETFS])],key,secret,120);
  const spy=(bars.SPY||[]).map(b=>Number(b.c)).filter(Number.isFinite);
  const spy20=spy.length>=21?pct(spy.at(-21),spy.at(-1)):0;
  const snapMap=new Map(liquid.map(x=>[x.symbol,x]));

  const rows=symbols.map(symbol=>{
    const a=assetMap.get(symbol)||{};
    const borrow=String(a.borrow_status||'').toLowerCase();
    const x=analyzeBearish(symbol,bars[symbol]||[],{spy20});
    if(!x)return null;
    const s=snapMap.get(symbol)||{};
    const shortable=a.shortable===true;
    const easy=borrow==='easy_to_borrow';
    let score=x.score;
    if(!shortable)score-=50;
    if(shortable&&!easy)score-=25;
    if(s.spread_pct!=null&&s.spread_pct>0.005)score-=12;
    if(s.day_change>0.08)score-=10;
    score=clamp(score,0,100);
    return {
      ...x,
      score,
      day_change:s.day_change,
      dollar_volume:s.dollar_volume,
      spread_pct:s.spread_pct,
      shortable,
      borrow_status:borrow||null,
      paper_short_eligible:shortable&&easy,
      squeeze_risk:
        Number(x.volatility_20d||0)>1.2||Number(x.atr_pct||0)>0.09||Number(s.day_change||0)>0.08
          ?'HIGH'
          :Number(x.volatility_20d||0)>0.75||Number(x.atr_pct||0)>0.06
            ?'MEDIUM':'LOW'
    };
  }).filter(Boolean).sort((a,b)=>b.score-a.score);

  const result={
    universe_size:assets.length,
    liquid_reviewed:liquid.length,
    eligible_easy_to_borrow:rows.filter(x=>x.paper_short_eligible).length,
    candidates:rows.slice(0,40),
    cache_hit:false
  };
  globalThis.__aiTraderShortScanCache={value:result,expires:Date.now()+SHORT_SCAN_CACHE_MS};
  return result;
}

async function fetchCryptoAssets(key,secret){
  const r=await resilientFetch('https://paper-api.alpaca.markets/v2/assets?status=active&asset_class=crypto',{
    headers:authHeaders(key,secret)
  });
  const data=await r.json().catch(()=>[]);
  if(!r.ok)throw new Error(data?.message||'Could not load crypto assets');
  return (Array.isArray(data)?data:[]).filter(a=>
    a?.tradable===true&&
    typeof a?.symbol==='string'&&
    /\/USD$/.test(a.symbol)
  );
}

async function fetchCryptoSnapshots(symbols,key,secret){
  const pages=await mapLimit(chunks(symbols,40),2,async batch=>{
    const u=new URL('https://data.alpaca.markets/v1beta3/crypto/us/snapshots');
    u.searchParams.set('symbols',batch.join(','));
    const r=await resilientFetch(u,{headers:authHeaders(key,secret)});
    if(!r.ok)return {};
    const d=await r.json().catch(()=>({}));
    return d?.snapshots||d||{};
  });
  return Object.assign({},...pages);
}

async function fetchCryptoBars(symbols,key,secret,days=60){
  const end=new Date();
  const start=new Date(end.getTime()-days*86400000);
  const pages=await mapLimit(chunks(symbols,20),2,async batch=>{
    const all={};let token=null;let guard=0;
    do{
      const u=new URL('https://data.alpaca.markets/v1beta3/crypto/us/bars');
      u.searchParams.set('symbols',batch.join(','));
      u.searchParams.set('timeframe','1Day');
      u.searchParams.set('start',start.toISOString());
      u.searchParams.set('end',end.toISOString());
      u.searchParams.set('limit','10000');
      if(token)u.searchParams.set('page_token',token);
      const r=await resilientFetch(u,{headers:authHeaders(key,secret)});
      const d=await r.json().catch(()=>({}));
      if(!r.ok)throw new Error(d?.message||'Crypto historical data failed');
      for(const [symbol,rows] of Object.entries(d?.bars||{})){
        all[symbol]=(all[symbol]||[]).concat(rows||[]);
      }
      token=d?.next_page_token||null;guard++;
    }while(token&&guard<8);
    return all;
  });
  return Object.assign({},...pages);
}

export function analyzeCrypto(symbol,bars,snapshot={}){
  const closes=(bars||[]).map(b=>Number(b.c)).filter(Number.isFinite);
  const volumes=(bars||[]).map(b=>Number(b.v)).filter(Number.isFinite);
  if(closes.length<15)return null;

  const price=Number(snapshot.price||closes.at(-1));
  const mom1=Number(snapshot.day_change||0);
  const mom7=closes.length>=8?pct(closes.at(-8),price):0;
  const mom30=closes.length>=31?pct(closes.at(-31),price):mom7;
  const r=rsi(closes,14);
  const vol=annualVol(closes,14);
  const avgVol=sma(volumes,14)||0;
  const vr=avgVol>0?(volumes.at(-1)||0)/avgVol:1;
  const high14=Math.max(...closes.slice(-14));
  const distanceFromHigh=high14>0?(high14-price)/high14:0;

  let score=50;
  const reasons=[];
  if(mom7>0.08&&mom7<0.35){score+=12;reasons.push('Strong 7-day momentum')}
  if(mom30>0.12&&mom30<0.70){score+=8;reasons.push('Positive 30-day trend')}
  if(mom1>0&&mom1<0.10){score+=5;reasons.push('Positive daily momentum')}
  if(vr>1.5){score+=6;reasons.push('Volume expansion')}
  if(distanceFromHigh<0.04){score+=4;reasons.push('Holding near recent high')}
  if(r>=48&&r<=70)score+=6;
  if(Number(snapshot.dollar_volume||0)>=5_000_000)score+=7;
  if(Number(snapshot.spread_pct||0)<=0.004)score+=5;

  let pumpRisk='LOW';
  if(mom1>=0.20||mom7>=0.60||Number(vol||0)>=1.8||Number(snapshot.spread_pct||0)>=0.02){
    pumpRisk='HIGH';score-=30;reasons.push('Extreme pump / liquidity risk');
  }else if(mom1>=0.10||mom7>=0.35||Number(vol||0)>=1.2||Number(snapshot.spread_pct||0)>=0.01){
    pumpRisk='MEDIUM';score-=12;reasons.push('Elevated pump / volatility risk');
  }

  if(r>82){score-=10;reasons.push('Extremely overbought')}
  if(mom1>0.12&&distanceFromHigh>0.08){score-=15;reasons.push('Intraday-style pump is fading')}

  score=clamp(Math.round(score),0,100);
  return {
    symbol,score,price,
    day_change:mom1,momentum_7d:mom7,momentum_30d:mom30,
    rsi14:r,volatility_14d:vol,volume_ratio:vr,
    spread_pct:snapshot.spread_pct??null,
    dollar_volume:snapshot.dollar_volume??0,
    pump_dump_risk:pumpRisk,
    research_signal:pumpRisk==='HIGH'?'AVOID_CHASE':score>=78?'MOMENTUM_WATCH':mom7<0?'WEAKNESS':'WATCH',
    reasons:reasons.slice(0,6)
  };
}

export async function fetchCryptoScan(key,secret){
  const cached=globalThis.__aiTraderCryptoScanCache;
  if(cached?.value&&cached.expires>Date.now())return {...cached.value,cache_hit:true};
  const assets=await fetchCryptoAssets(key,secret);
  const snapshots=await fetchCryptoSnapshots(assets.map(a=>a.symbol),key,secret);

  const snapRows=Object.entries(snapshots).map(([symbol,s])=>{
    const d=s?.dailyBar||s?.daily_bar||{};
    const p=s?.prevDailyBar||s?.prev_daily_bar||{};
    const q=s?.latestQuote||s?.latest_quote||{};
    const t=s?.latestTrade||s?.latest_trade||{};
    const price=Number(t.p||d.c||0);
    const prev=Number(p.c||0);
    const volume=Number(d.v||0);
    const bid=Number(q.bp||0),ask=Number(q.ap||0);
    const mid=bid>0&&ask>0?(bid+ask)/2:0;
    return {
      symbol,price,
      day_change:pct(prev,price),
      dollar_volume:price*volume,
      spread_pct:mid>0&&ask>=bid?(ask-bid)/mid:null
    };
  }).filter(x=>x.price>0&&!isStablecoinCrypto(x.symbol))
    .sort((a,b)=>
      (Math.abs(b.day_change)*2+Math.log10(Math.max(1,b.dollar_volume)))-
      (Math.abs(a.day_change)*2+Math.log10(Math.max(1,a.dollar_volume)))
    );

  const deep=snapRows.slice(0,60);
  const bars=await fetchCryptoBars(deep.map(x=>x.symbol),key,secret,60);
  const snapMap=new Map(deep.map(x=>[x.symbol,x]));
  const rows=deep.map(x=>analyzeCrypto(x.symbol,bars[x.symbol]||[],snapMap.get(x.symbol)||{}))
    .filter(Boolean).sort((a,b)=>b.score-a.score);

  const result={
    universe_size:assets.length,
    stablecoins_excluded:assets.filter(a=>isStablecoinCrypto(a.symbol)).length,
    deeply_analyzed:deep.length,
    high_pump_risk:rows.filter(x=>x.pump_dump_risk==='HIGH').length,
    candidates:rows.slice(0,40),
    cache_hit:false
  };
  globalThis.__aiTraderCryptoScanCache={value:result,expires:Date.now()+CRYPTO_SCAN_CACHE_MS};
  return result;
}

function parseOccSymbol(symbol){
  const m=String(symbol||'').match(/^([A-Z.]+)(\d{6})([CP])(\d{8})$/);
  if(!m)return null;
  const [,root,date,type,strikeRaw]=m;
  const yy=Number(date.slice(0,2)),mm=Number(date.slice(2,4)),dd=Number(date.slice(4,6));
  const expiry=`20${String(yy).padStart(2,'0')}-${String(mm).padStart(2,'0')}-${String(dd).padStart(2,'0')}`;
  return {root,expiry,type:type==='C'?'call':'put',strike:Number(strikeRaw)/1000};
}

export async function fetchOptionsForUnderlying(symbol,direction,key,secret,underlyingPrice){
  const now=new Date();
  const minExp=new Date(now.getTime()+7*86400000).toISOString().slice(0,10);
  const maxExp=new Date(now.getTime()+45*86400000).toISOString().slice(0,10);
  const type=direction==='BEARISH'?'put':'call';

  const u=new URL(`https://data.alpaca.markets/v1beta1/options/snapshots/${encodeURIComponent(symbol)}`);
  u.searchParams.set('feed','indicative');
  u.searchParams.set('type',type);
  u.searchParams.set('expiration_date_gte',minExp);
  u.searchParams.set('expiration_date_lte',maxExp);
  if(underlyingPrice>0){
    u.searchParams.set('strike_price_gte',String(underlyingPrice*0.85));
    u.searchParams.set('strike_price_lte',String(underlyingPrice*1.15));
  }
  u.searchParams.set('limit','1000');

  const r=await resilientFetch(u,{headers:authHeaders(key,secret)});
  const data=await r.json().catch(()=>({}));
  if(!r.ok){
    return {available:false,error:data?.message||`Options data HTTP ${r.status}`,contracts:[]};
  }

  const snapshots=data?.snapshots||{};
  const rows=Object.entries(snapshots).map(([contract,s])=>{
    const parsed=parseOccSymbol(contract)||{};
    const q=s?.latestQuote||s?.latest_quote||{};
    const bid=Number(q.bp||0),ask=Number(q.ap||0);
    const mid=bid>0&&ask>0?(bid+ask)/2:0;
    const spreadPct=mid>0&&ask>=bid?(ask-bid)/mid:null;
    const g=s?.greeks||{};
    const delta=Number(g.delta);
    const gamma=Number(g.gamma);
    const theta=Number(g.theta);
    const vega=Number(g.vega);
    const iv=Number(s?.impliedVolatility??s?.implied_volatility);
    const dte=parsed.expiry?Math.max(0,Math.ceil((new Date(parsed.expiry+'T20:00:00Z')-now)/86400000)):null;

    let quality=50;
    if(spreadPct!=null&&spreadPct<=0.08)quality+=14;
    else if(spreadPct!=null&&spreadPct>0.20)quality-=20;
    if(Math.abs(delta)>=0.30&&Math.abs(delta)<=0.65)quality+=12;
    if(dte>=14&&dte<=35)quality+=10;
    if(mid>=0.20&&mid<=8)quality+=5;
    if(iv>0&&iv<1.2)quality+=5;
    quality=clamp(Math.round(quality),0,100);

    return {
      contract,
      type:parsed.type||type,
      expiry:parsed.expiry||null,
      dte,
      strike:parsed.strike??null,
      bid,ask,mid,
      spread_pct:spreadPct,
      delta:Number.isFinite(delta)?delta:null,
      gamma:Number.isFinite(gamma)?gamma:null,
      theta:Number.isFinite(theta)?theta:null,
      vega:Number.isFinite(vega)?vega:null,
      implied_volatility:Number.isFinite(iv)?iv:null,
      quality_score:quality
    };
  }).filter(x=>x.mid>0)
    .sort((a,b)=>b.quality_score-a.quality_score);

  return {available:true,feed:'indicative',contracts:rows.slice(0,15)};
}
