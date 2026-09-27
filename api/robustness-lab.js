import { requireDashboardAuth } from '../lib/auth.js';
import { fetchBarsForSymbols, analyze, detectMarketRegime } from '../lib/strategy.js';
import { entryThresholdForRegime } from '../lib/risk.js';

const STARTING_CAPITAL=10000;
const UNIVERSE_SIZE=20;
const FALLBACK_UNIVERSE=[
  'SPY','QQQ','IWM','DIA','XLK','XLF','XLE','XLV','XLI','XLY',
  'AAPL','MSFT','NVDA','AMZN','META','GOOGL','JPM','XOM','LLY','COST'
];
const MAX_POSITIONS=3;
const ALLOCATION_PCT=0.10;
const SLIPPAGE=0.0005;

function clamp(n,min,max){return Math.max(min,Math.min(max,n));}
function dateKey(bar){return String(bar?.t||'').slice(0,10);}
function mean(xs){return xs.length?xs.reduce((a,b)=>a+b,0)/xs.length:0;}
function std(xs){
  if(!xs.length)return 0;
  const m=mean(xs);
  return Math.sqrt(xs.reduce((s,x)=>s+(x-m)**2,0)/xs.length);
}

function metricsFromCurve(curve,trades){
  if(!curve.length){
    return {return:0,max_drawdown:0,sharpe:0,trades:0,win_rate:0,profit_factor:0,ending_equity:STARTING_CAPITAL};
  }
  const values=curve.map(x=>x.equity);
  const rets=[];
  for(let i=1;i<values.length;i++) if(values[i-1]>0) rets.push(values[i]/values[i-1]-1);

  let peak=values[0],dd=0;
  for(const v of values){
    peak=Math.max(peak,v);
    dd=Math.min(dd,v/peak-1);
  }

  const wins=trades.filter(t=>t.pnl>0);
  const losses=trades.filter(t=>t.pnl<0);
  const gp=wins.reduce((s,t)=>s+t.pnl,0);
  const gl=Math.abs(losses.reduce((s,t)=>s+t.pnl,0));
  const s=std(rets);

  return {
    return:values.at(-1)/values[0]-1,
    max_drawdown:dd,
    sharpe:s>0?(mean(rets)/s)*Math.sqrt(252):0,
    trades:trades.length,
    win_rate:trades.length?wins.length/trades.length:0,
    profit_factor:gl>0?gp/gl:(gp>0?99:0),
    ending_equity:values.at(-1)
  };
}

function configScore(m){
  if(!m||m.trades<5)return -999;
  const ddPenalty=Math.abs(Math.min(0,m.max_drawdown))*3;
  const returnTerm=m.return*4;
  const sharpeTerm=clamp(m.sharpe,-2,3);
  const pfTerm=clamp((m.profit_factor||0)-1,-1,2)*0.5;
  return sharpeTerm+returnTerm+pfTerm-ddPenalty;
}

function spyReturn(spyBars,startIndex,endIndex){
  const start=Number(spyBars[startIndex]?.o||spyBars[startIndex]?.c||0);
  const end=Number(spyBars[Math.max(startIndex,endIndex-1)]?.c||0);
  return start>0&&end>0?end/start-1:0;
}

function simulate({
  spyBars,barsBySymbol,symbols,barMaps,startIndex,endIndex,
  thresholdOffset,stopAtrMultiple,rewardMultiple
}){
  let cash=STARTING_CAPITAL;
  const positions=new Map();
  const trades=[];
  const curve=[];

  for(let i=startIndex;i<endIndex;i++){
    const day=dateKey(spyBars[i]);

    for(const [symbol,p] of [...positions.entries()]){
      const bar=barMaps[symbol]?.get(day);
      if(!bar)continue;

      const low=Number(bar.l),high=Number(bar.h),close=Number(bar.c);
      let exit=null,reason=null;

      if(low<=p.stop){
        exit=p.stop*(1-SLIPPAGE);
        reason='stop';
      }else if(high>=p.target){
        exit=p.target*(1-SLIPPAGE);
        reason='target';
      }else if(p.days>=15){
        exit=close*(1-SLIPPAGE);
        reason='time';
      }

      if(exit!=null){
        const proceeds=p.qty*exit;
        cash+=proceeds;
        trades.push({
          symbol,
          pnl:proceeds-p.cost,
          return_pct:p.cost>0?(proceeds-p.cost)/p.cost:0,
          reason
        });
        positions.delete(symbol);
      }else{
        p.days++;
      }
    }

    if(i>60&&positions.size<MAX_POSITIONS){
      const spyHistory=spyBars.slice(0,i);
      const regime=detectMarketRegime(spyHistory);
      const threshold=clamp(entryThresholdForRegime(regime.label)+thresholdOffset,70,98);
      const benchmark20=Number(regime.spy_20d||0);
      const choices=[];

      for(const symbol of symbols){
        if(positions.has(symbol))continue;

        const history=(barsBySymbol[symbol]||[]).filter(b=>dateKey(b)<day);
        const candidate=analyze(symbol,history,{
          benchmark20,
          regimeAdjustment:regime.score_adjustment
        });
        if(!candidate||candidate.score<threshold)continue;

        const today=barMaps[symbol]?.get(day);
        const open=Number(today?.o||0);
        if(!(open>0))continue;

        choices.push({candidate,today,regime});
      }

      choices.sort((a,b)=>b.candidate.score-a.candidate.score);

      for(const item of choices){
        if(positions.size>=MAX_POSITIONS)break;

        const open=Number(item.today.o);
        const equityEstimate=cash+[...positions.values()].reduce((s,p)=>{
          const bar=barMaps[p.symbol]?.get(day);
          return s+p.qty*Number(bar?.c||p.entry);
        },0);

        const allocation=Math.min(cash,equityEstimate*ALLOCATION_PCT);
        if(allocation<50)break;

        const entry=open*(1+SLIPPAGE);
        const qty=allocation/entry;
        const cost=qty*entry;
        const stopPct=clamp(Number(item.candidate.atr_pct||0.03)*stopAtrMultiple,0.02,0.08);
        const targetPct=clamp(stopPct*rewardMultiple,0.03,0.18);

        cash-=cost;
        positions.set(item.candidate.symbol,{
          symbol:item.candidate.symbol,
          qty,cost,entry,
          stop:entry*(1-stopPct),
          target:entry*(1+targetPct),
          days:0
        });
      }
    }

    let equity=cash;
    for(const p of positions.values()){
      const bar=barMaps[p.symbol]?.get(day);
      equity+=p.qty*Number(bar?.c||p.entry);
    }
    curve.push({date:day,equity});
  }

  const lastDay=dateKey(spyBars[Math.max(startIndex,endIndex-1)]);
  for(const [symbol,p] of [...positions.entries()]){
    const bar=barMaps[symbol]?.get(lastDay);
    const exit=Number(bar?.c||p.entry)*(1-SLIPPAGE);
    const proceeds=p.qty*exit;
    cash+=proceeds;
    trades.push({
      symbol,
      pnl:proceeds-p.cost,
      return_pct:p.cost>0?(proceeds-p.cost)/p.cost:0,
      reason:'end_of_window'
    });
    positions.delete(symbol);
  }

  if(curve.length)curve[curve.length-1].equity=cash;
  return metricsFromCurve(curve,trades);
}

export default async function handler(req,res){
  if(!requireDashboardAuth(req,res))return;
  if(!['GET','POST'].includes(req.method))return res.status(405).json({error:'Method not allowed'});

  const key=process.env.ALPACA_API_KEY;
  const secret=process.env.ALPACA_SECRET_KEY;
  const baseUrl=process.env.ALPACA_BASE_URL||'https://paper-api.alpaca.markets';

  if(!key||!secret)return res.status(500).json({error:'Missing Alpaca credentials'});
  if(!baseUrl.includes('paper-api.alpaca.markets')){
    return res.status(403).json({error:'Paper-only build'});
  }

  try{
    const requested=Array.isArray(req.body?.symbols)
      ?req.body.symbols.map(x=>String(x||'').trim().toUpperCase()).filter(x=>/^[A-Z.]{1,12}$/.test(x))
      :[];
    const symbols=[...new Set((requested.length?requested:FALLBACK_UNIVERSE).slice(0,UNIVERSE_SIZE))];
    const universeSource=requested.length?'loaded_market_scan':'diversified_fallback';
    const barsBySymbol=await fetchBarsForSymbols([...new Set([...symbols,'SPY'])],key,secret,420);
    const spyBars=barsBySymbol.SPY||[];

    if(spyBars.length<220){
      return res.status(422).json({error:'Not enough daily history for robustness lab'});
    }

    const barMaps={};
    for(const symbol of symbols){
      barMaps[symbol]=new Map((barsBySymbol[symbol]||[]).map(b=>[dateKey(b),b]));
    }

    const windowStart=Math.max(60,spyBars.length-252);
    const totalDays=spyBars.length-windowStart;
    const split=windowStart+Math.floor(totalDays*0.60);
    const end=spyBars.length;

    const thresholdOffsets=[-2,0,2,4];
    const stopMultiples=[1.5,2.0,2.5];
    const rewardMultiples=[1.5,2.0,2.5];

    const rows=[];
    for(const thresholdOffset of thresholdOffsets){
      for(const stopAtrMultiple of stopMultiples){
        for(const rewardMultiple of rewardMultiples){
          const train=simulate({
            spyBars,barsBySymbol,symbols,barMaps,
            startIndex:windowStart,endIndex:split,
            thresholdOffset,stopAtrMultiple,rewardMultiple
          });
          const validation=simulate({
            spyBars,barsBySymbol,symbols,barMaps,
            startIndex:split,endIndex:end,
            thresholdOffset,stopAtrMultiple,rewardMultiple
          });

          rows.push({
            config:{threshold_offset:thresholdOffset,stop_atr_multiple:stopAtrMultiple,reward_multiple:rewardMultiple},
            train,
            validation,
            train_score:configScore(train)
          });
        }
      }
    }

    rows.sort((a,b)=>b.train_score-a.train_score);
    const selected=rows[0];

    const validationSpy=spyReturn(spyBars,split,end);
    const positiveValidation=rows.filter(x=>x.validation.return>0).length;
    const beatSpy=rows.filter(x=>x.validation.return>validationSpy).length;
    const validationSharpes=rows.map(x=>x.validation.sharpe).sort((a,b)=>a-b);
    const medianSharpe=validationSharpes.length
      ?validationSharpes[Math.floor(validationSharpes.length/2)]
      :0;

    return res.status(200).json({
      label:'Out-of-sample robustness lab',
      warning:'Uses either the dashboard’s loaded scan symbols or a fixed diversified liquid fallback universe. Survivorship/selection bias remains; Gemini, headlines, spreads and intraday confirmation are not replayed. This is a robustness screen, not proof of future returns.',
      universe:{
        source:universeSource,
        symbols:symbols.length,
        note:universeSource==='loaded_market_scan'
          ?'Reused symbols from the dashboard market scan to avoid duplicate full-market API bursts.'
          :'Used a fixed diversified liquid research universe because no dashboard scan symbols were supplied.'
      },
      split:{
        train_start:dateKey(spyBars[windowStart]),
        train_end:dateKey(spyBars[split-1]),
        validation_start:dateKey(spyBars[split]),
        validation_end:dateKey(spyBars.at(-1)),
        train_days:split-windowStart,
        validation_days:end-split
      },
      configs_tested:rows.length,
      selected_by_train: selected ? {
        config:selected.config,
        train:selected.train,
        validation:selected.validation,
        validation_spy_return:validationSpy,
        validation_excess_vs_spy:selected.validation.return-validationSpy
      }:null,
      stability:{
        positive_validation_pct:rows.length?positiveValidation/rows.length:0,
        beat_spy_validation_pct:rows.length?beatSpy/rows.length:0,
        median_validation_sharpe:medianSharpe
      },
      top_train_configs:rows.slice(0,8)
    });
  }catch(error){
    return res.status(500).json({error:error?.message||'Robustness lab failed'});
  }
}
