import { requireDashboardAuth } from '../lib/auth.js';
import { fetchBarsForSymbols } from '../lib/strategy.js';
import { runChallengerComparison } from '../lib/challenger-strategies.js';

const HEADERS=(k,s)=>({'APCA-API-KEY-ID':k,'APCA-API-SECRET-KEY':s});
async function cryptoBars(symbols,key,secret){
  const end=new Date(),start=new Date(end.getTime()-450*86400000);
  const result=Object.fromEntries(symbols.map(s=>[s,[]]));
  let cursor='',pages=0;
  do{
    const url=new URL('https://data.alpaca.markets/v1beta3/crypto/us/bars');
    url.searchParams.set('symbols',symbols.join(','));
    url.searchParams.set('timeframe','1Day');
    url.searchParams.set('start',start.toISOString());
    url.searchParams.set('end',end.toISOString());
    url.searchParams.set('limit','10000');
    if(cursor)url.searchParams.set('page_token',cursor);
    const res=await fetch(url,{headers:HEADERS(key,secret)});
    const data=await res.json().catch(()=>({}));
    if(!res.ok)throw new Error('Crypto daily-bar history unavailable: HTTP '+res.status);
    for(const [symbol,bars] of Object.entries(data.bars||{})){
      if(result[symbol])result[symbol].push(...(Array.isArray(bars)?bars:[]));
    }
    cursor=data.next_page_token||'';
    pages++;
  }while(cursor&&pages<5);
  return result;
}
export default async function handler(req,res){
  if(!requireDashboardAuth(req,res))return;
  if(req.method!=='GET')return res.status(405).json({error:'Method not allowed'});
  const key=process.env.ALPACA_API_KEY,secret=process.env.ALPACA_SECRET_KEY;
  const base=process.env.ALPACA_BASE_URL||'https://paper-api.alpaca.markets';
  if(!key||!secret)return res.status(503).json({error:'Alpaca paper credentials missing'});
  if(!base.includes('paper-api.alpaca.markets'))return res.status(403).json({error:'Paper-only endpoint'});
  const isCrypto=String(req.query?.asset||'').toLowerCase()==='crypto';
  const requested=String(req.query?.symbols||'');
  const defaultSymbols=isCrypto?['BTC/USD','ETH/USD']:['SPY','QQQ','IWM'];
  const symbols=[...new Set(requested.split(',').map(s=>s.trim().toUpperCase()).filter(Boolean))]
    .filter(s=>isCrypto?/^[A-Z]{2,10}\/USD$/.test(s):/^[A-Z.]{1,8}$/.test(s)).slice(0,8);
  const effective=symbols.length?symbols:defaultSymbols;
  try{
    const bars=isCrypto?await cryptoBars(effective,key,secret):
      await fetchBarsForSymbols(effective,key,secret,450);
    const result=effective.map(symbol=>({
      symbol,bars:(bars[symbol]||[]).length,
      comparisons:runChallengerComparison(bars[symbol]||[],{assetClass:isCrypto?'crypto':'equity'})
    }));
    res.setHeader('Cache-Control','no-store');
    return res.status(200).json({
      mode:'PAPER_RESEARCH',asset_class:isCrypto?'crypto':'equity',
      generated_at:new Date().toISOString(),auto_execution:false,symbols:effective,
      result,
      tournament:{strategies_per_symbol:4,validation:'chronological 70/30 split',promotion:'manual review only',orders_submitted:0},
      limitations:[
        'Uses todays requested symbols; survivorship and selection bias are possible.',
        'Signals use prior daily bars; the next open is the simulated entry.',
        'Assumes stop-first on ambiguous same-day stop and target touches.',
        'Trading costs are hypothetical buffers, not measured Alpaca commissions or execution slippage.',
        'Compounded returns assume sequential non-overlapping full-notional trades; they are not portfolio returns.',
        'Stop gaps are simulated at the opening price; intrabar execution remains hypothetical.',
        'A promising simulation does not automatically change any active trading strategy.'
      ]
    });
  }catch(e){return res.status(502).json({error:String(e?.message||'Strategy comparison failed').slice(0,220)})}
}
