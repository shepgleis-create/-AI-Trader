import { requireDashboardAuth } from '../lib/auth.js';
import { fetchMarketScan, fetchBarsForSymbols, analyze, detectMarketRegime } from '../lib/strategy.js';
import { entryThresholdForRegime } from '../lib/risk.js';

const SYMBOL_LIMIT = 24;
const TEST_DAYS = 60;
const SLIPPAGE = 0.0005;
const STARTING_CAPITAL = 10000;
const ALLOCATION_PCT = 0.10;

function dateKey(bar) {
  return String(bar?.t || '').slice(0,10);
}

function nyParts(ts) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone:'America/New_York',
    year:'numeric', month:'2-digit', day:'2-digit',
    hour:'2-digit', minute:'2-digit', hour12:false
  }).formatToParts(new Date(ts));
  const get=t=>parts.find(p=>p.type===t)?.value;
  return {
    date:`${get('year')}-${get('month')}-${get('day')}`,
    minutes:Number(get('hour'))*60+Number(get('minute'))
  };
}

function clamp(n,min,max){return Math.max(min,Math.min(max,n));}

async function fetchIntraday(symbols,key,secret,days=110){
  const end=new Date();
  const start=new Date(end.getTime()-days*86400000);
  const batches=[];
  for(let i=0;i<symbols.length;i+=8) batches.push(symbols.slice(i,i+8));

  const merged={};
  for(const batch of batches){
    let token=null;
    let guard=0;
    do{
      const url=new URL('https://data.alpaca.markets/v2/stocks/bars');
      url.searchParams.set('symbols',batch.join(','));
      url.searchParams.set('timeframe','15Min');
      url.searchParams.set('start',start.toISOString());
      url.searchParams.set('end',end.toISOString());
      url.searchParams.set('adjustment','all');
      url.searchParams.set('feed','iex');
      url.searchParams.set('limit','10000');
      if(token) url.searchParams.set('page_token',token);

      const r=await fetch(url,{
        headers:{
          'APCA-API-KEY-ID':key,
          'APCA-API-SECRET-KEY':secret
        }
      });
      const data=await r.json();
      if(!r.ok) throw new Error(data?.message||'Intraday data request failed');

      for(const [symbol,bars] of Object.entries(data?.bars||{})){
        merged[symbol]=(merged[symbol]||[]).concat(bars||[]);
      }

      token=data?.next_page_token||null;
      guard++;
    }while(token&&guard<20);
  }
  return merged;
}

function summarize(rows){
  const trades=Array.isArray(rows)?rows:[];
  const wins=trades.filter(t=>t.pnl>0);
  const losses=trades.filter(t=>t.pnl<0);
  const gp=wins.reduce((s,t)=>s+t.pnl,0);
  const gl=Math.abs(losses.reduce((s,t)=>s+t.pnl,0));
  return {
    trades:trades.length,
    win_rate:trades.length?wins.length/trades.length:0,
    pnl:trades.reduce((s,t)=>s+t.pnl,0),
    avg_return:trades.length?trades.reduce((s,t)=>s+t.return_pct,0)/trades.length:0,
    profit_factor:gl>0?gp/gl:gp>0?99:0
  };
}

function groups(trades,field){
  const m={};
  for(const t of trades)(m[t[field]||'UNKNOWN']??=[]).push(t);
  return Object.fromEntries(Object.entries(m).map(([k,v])=>[k,summarize(v)]));
}

export default async function handler(req,res){
  if(!requireDashboardAuth(req,res)) return;
  if(req.method!=='GET') return res.status(405).json({error:'Method not allowed'});

  const key=process.env.ALPACA_API_KEY;
  const secret=process.env.ALPACA_SECRET_KEY;
  const baseUrl=process.env.ALPACA_BASE_URL||'https://paper-api.alpaca.markets';

  if(!key||!secret) return res.status(500).json({error:'Missing Alpaca credentials'});
  if(!baseUrl.includes('paper-api.alpaca.markets')){
    return res.status(403).json({error:'Paper-only build'});
  }

  try{
    const scan=await fetchMarketScan(key,secret);
    const symbols=scan.candidates.slice(0,SYMBOL_LIMIT).map(c=>c.symbol);
    const allSymbols=[...new Set([...symbols,'SPY'])];

    const [daily,intraday]=await Promise.all([
      fetchBarsForSymbols(allSymbols,key,secret,230),
      fetchIntraday(allSymbols,key,secret,120)
    ]);

    const spyDaily=daily.SPY||[];
    if(spyDaily.length<90) return res.status(422).json({error:'Not enough daily history for intraday test'});

    const intradayBySymbolDay={};
    for(const symbol of allSymbols){
      const map=new Map();
      for(const bar of (intraday[symbol]||[])){
        const p=nyParts(bar.t);
        if(!map.has(p.date)) map.set(p.date,[]);
        map.get(p.date).push({...bar,_minutes:p.minutes});
      }
      for(const bars of map.values()) bars.sort((a,b)=>a._minutes-b._minutes);
      intradayBySymbolDay[symbol]=map;
    }

    const candidateDays=spyDaily.slice(-TEST_DAYS).map(dateKey);
    let equity=STARTING_CAPITAL;
    const trades=[];

    for(const day of candidateDays){
      const spyHistory=spyDaily.filter(b=>dateKey(b)<day);
      if(spyHistory.length<55) continue;

      const regime=detectMarketRegime(spyHistory);
      const threshold=entryThresholdForRegime(regime.label);
      const benchmark20=Number(regime.spy_20d||0);
      const scored=[];

      for(const symbol of symbols){
        const history=(daily[symbol]||[]).filter(b=>dateKey(b)<day);
        const candidate=analyze(symbol,history,{
          benchmark20,
          regimeAdjustment:regime.score_adjustment
        });
        if(!candidate||candidate.score<threshold) continue;

        const bars=intradayBySymbolDay[symbol]?.get(day)||[];
        if(!bars.length) continue;

        const entryBar=bars.find(b=>b._minutes>=585&&b._minutes<630); // 9:45–10:29 ET
        if(!entryBar) continue;

        scored.push({candidate,bars,entryBar,regime});
      }

      scored.sort((a,b)=>b.candidate.score-a.candidate.score);
      const pick=scored[0];
      if(!pick) continue;

      const entryPrice=Number(pick.entryBar.o||pick.entryBar.c)*(1+SLIPPAGE);
      if(!(entryPrice>0)) continue;

      const stopPct=clamp(Number(pick.candidate.atr_pct||0.03)*2,0.025,0.06);
      const targetPct=clamp(stopPct*2,0.05,0.12);
      const stop=entryPrice*(1-stopPct);
      const target=entryPrice*(1+targetPct);

      const activeBars=pick.bars.filter(b=>b._minutes>=pick.entryBar._minutes&&b._minutes<=945); // through 3:45 ET
      let exitPrice=null;
      let exitReason='end_of_day';

      for(const bar of activeBars){
        const low=Number(bar.l),high=Number(bar.h);
        if(low<=stop){
          exitPrice=stop*(1-SLIPPAGE);
          exitReason='stop';
          break;
        }
        if(high>=target){
          exitPrice=target*(1-SLIPPAGE);
          exitReason='target';
          break;
        }
      }

      if(exitPrice==null){
        const exitBar=[...activeBars].reverse().find(b=>b._minutes<=945)||activeBars.at(-1);
        exitPrice=Number(exitBar?.c||pick.entryBar.c)*(1-SLIPPAGE);
      }

      const allocation=equity*ALLOCATION_PCT;
      const qty=allocation/entryPrice;
      const pnl=(exitPrice-entryPrice)*qty;
      equity+=pnl;

      trades.push({
        date:day,
        symbol:pick.candidate.symbol,
        setup_type:pick.candidate.setup_type||'TREND',
        regime:pick.regime.label,
        score:pick.candidate.score,
        entry_price:entryPrice,
        exit_price:exitPrice,
        reason:exitReason,
        pnl,
        return_pct:exitPrice/entryPrice-1
      });
    }

    const stats=summarize(trades);
    const spyStart=Number(spyDaily.find(b=>dateKey(b)>=candidateDays[0])?.o||0);
    const spyEnd=Number(spyDaily.at(-1)?.c||0);
    const spyBuyHold=spyStart>0?spyEnd/spyStart-1:0;

    return res.status(200).json({
      label:'Intraday calibration walk-forward test',
      warning:'Uses today’s liquid universe and does not replay Gemini, news, spreads, or every live breadth input. Results are research estimates, not expected future returns.',
      period:{
        start:candidateDays[0],
        end:candidateDays.at(-1),
        trading_days:candidateDays.length
      },
      universe:{
        symbols:symbols.length,
        source_market_universe:scan.universe_size
      },
      assumptions:{
        entry_window:'09:45–10:29 ET',
        forced_exit_by:'15:45 ET',
        allocation_pct:ALLOCATION_PCT,
        slippage_each_side_pct:SLIPPAGE,
        one_trade_per_day:true
      },
      metrics:{
        ...stats,
        starting_equity:STARTING_CAPITAL,
        ending_equity:equity,
        total_return:equity/STARTING_CAPITAL-1,
        spy_buy_hold_return:spyBuyHold
      },
      attribution:{
        by_setup:groups(trades,'setup_type'),
        by_regime:groups(trades,'regime'),
        by_exit:groups(trades,'reason')
      },
      recent_trades:trades.slice(-15).reverse()
    });
  }catch(error){
    return res.status(500).json({error:error?.message||'Intraday backtest failed'});
  }
}
