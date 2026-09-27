import { requireDashboardAuth } from '../lib/auth.js';

const BENCHMARKS = ['SPY','VTI','BND'];

function mean(xs){
  return xs.length ? xs.reduce((a,b)=>a+b,0)/xs.length : 0;
}
function std(xs){
  if(!xs.length) return 0;
  const m=mean(xs);
  return Math.sqrt(xs.reduce((s,x)=>s+(x-m)**2,0)/xs.length);
}
function dateKeyFromUnix(ts){
  return new Date(Number(ts)*1000).toISOString().slice(0,10);
}
function dateKeyFromBar(bar){
  return String(bar?.t||'').slice(0,10);
}
function dailyReturnsFromValues(rows,valueKey='value'){
  const out=[];
  for(let i=1;i<rows.length;i++){
    const a=Number(rows[i-1]?.[valueKey]);
    const b=Number(rows[i]?.[valueKey]);
    if(a>0&&b>0) out.push(b/a-1);
  }
  return out;
}
function maxDrawdown(values){
  let peak=0,dd=0;
  for(const v0 of values){
    const v=Number(v0);
    if(!(v>0)) continue;
    peak=Math.max(peak,v);
    if(peak>0) dd=Math.min(dd,v/peak-1);
  }
  return dd;
}
function metricsFromSeries(rows,valueKey='value',startingCapital=10000){
  const values=rows.map(x=>Number(x?.[valueKey])).filter(x=>Number.isFinite(x)&&x>0);
  if(values.length<2){
    return {
      points:values.length,total_return:0,max_drawdown:0,volatility:0,
      sharpe:0,sortino:0,ending_10000:startingCapital
    };
  }

  const rets=dailyReturnsFromValues(rows,valueKey);
  const avg=mean(rets);
  const vol=std(rets);
  const downside=rets.filter(x=>x<0);
  const downsideDev=Math.sqrt(downside.length?downside.reduce((s,x)=>s+x*x,0)/downside.length:0);
  const totalReturn=values.at(-1)/values[0]-1;

  return {
    points:values.length,
    total_return:totalReturn,
    max_drawdown:maxDrawdown(values),
    volatility:vol*Math.sqrt(252),
    sharpe:vol>0?(avg/vol)*Math.sqrt(252):0,
    sortino:downsideDev>0?(avg/downsideDev)*Math.sqrt(252):0,
    ending_10000:startingCapital*(1+totalReturn)
  };
}

async function fetchBenchmarkBars(symbols,start,end,headers){
  const url=new URL('https://data.alpaca.markets/v2/stocks/bars');
  url.searchParams.set('symbols',symbols.join(','));
  url.searchParams.set('timeframe','1Day');
  url.searchParams.set('start',start.toISOString());
  url.searchParams.set('end',new Date(end.getTime()+86400000).toISOString());
  url.searchParams.set('adjustment','all');
  url.searchParams.set('feed','iex');
  url.searchParams.set('limit','1000');

  const r=await fetch(url,{headers});
  const data=await r.json().catch(()=>({}));
  if(!r.ok) throw new Error(data?.message||'Could not load benchmark market data');
  return data?.bars||{};
}

function normalizedCloseSeries(bars,startDate,endDate){
  const rows=(Array.isArray(bars)?bars:[])
    .map(b=>({date:dateKeyFromBar(b),close:Number(b.c)}))
    .filter(x=>x.date>=startDate&&x.date<=endDate&&x.close>0)
    .sort((a,b)=>a.date.localeCompare(b.date));

  if(!rows.length) return [];
  const first=rows[0].close;
  return rows.map(x=>({date:x.date,value:x.close/first*10000}));
}

function synthetic6040(vtiBars,bndBars,startDate,endDate){
  const vti=new Map((vtiBars||[]).map(b=>[dateKeyFromBar(b),Number(b.c)]));
  const bnd=new Map((bndBars||[]).map(b=>[dateKeyFromBar(b),Number(b.c)]));
  const dates=[...new Set([...vti.keys(),...bnd.keys()])]
    .filter(d=>d>=startDate&&d<=endDate&&vti.has(d)&&bnd.has(d))
    .sort();

  if(dates.length<2) return [];

  let value=10000;
  const out=[{date:dates[0],value}];

  for(let i=1;i<dates.length;i++){
    const prev=dates[i-1],today=dates[i];
    const v0=vti.get(prev),v1=vti.get(today);
    const b0=bnd.get(prev),b1=bnd.get(today);
    if(!(v0>0&&v1>0&&b0>0&&b1>0)) continue;
    const daily=.60*(v1/v0-1)+.40*(b1/b0-1);
    value*=1+daily;
    out.push({date:today,value});
  }
  return out;
}

function alignSeriesToDates(series,dateSet){
  return series.filter(x=>dateSet.has(x.date));
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

  const headers={
    'APCA-API-KEY-ID':key,
    'APCA-API-SECRET-KEY':secret
  };

  try{
    const historyUrl=new URL(`${baseUrl}/v2/account/portfolio/history`);
    historyUrl.searchParams.set('period','1M');
    historyUrl.searchParams.set('timeframe','1D');

    const hr=await fetch(historyUrl,{headers});
    const h=await hr.json().catch(()=>({}));
    if(!hr.ok) return res.status(hr.status).json({error:h?.message||'Could not load paper-account history'});

    const equity=(h?.equity||[]).map(Number);
    const timestamps=h?.timestamp||[];

    let bot=(timestamps||[]).map((ts,i)=>({
      date:dateKeyFromUnix(ts),
      value:equity[i]
    })).filter(x=>x.value>0).sort((a,b)=>a.date.localeCompare(b.date));

    if(bot.length<2){
      return res.status(200).json({
        ready:false,
        points:bot.length,
        note:'Not enough paper-account history yet for a fair benchmark comparison.'
      });
    }

    const startDate=bot[0].date;
    const endDate=bot.at(-1).date;
    const start=new Date(startDate+'T00:00:00Z');
    const end=new Date(endDate+'T23:59:59Z');

    const bars=await fetchBenchmarkBars(BENCHMARKS,start,end,headers);

    const spy=normalizedCloseSeries(bars.SPY||[],startDate,endDate);
    const vti=normalizedCloseSeries(bars.VTI||[],startDate,endDate);
    const bnd=normalizedCloseSeries(bars.BND||[],startDate,endDate);
    const sixtyForty=synthetic6040(bars.VTI||[],bars.BND||[],startDate,endDate);

    const commonDates=new Set(
      bot.map(x=>x.date).filter(d=>
        spy.some(x=>x.date===d)&&
        vti.some(x=>x.date===d)&&
        sixtyForty.some(x=>x.date===d)
      )
    );

    bot=alignSeriesToDates(bot,commonDates);
    const spyAligned=alignSeriesToDates(spy,commonDates);
    const vtiAligned=alignSeriesToDates(vti,commonDates);
    const sixtyFortyAligned=alignSeriesToDates(sixtyForty,commonDates);

    if(bot.length<2||spyAligned.length<2||vtiAligned.length<2||sixtyFortyAligned.length<2){
      return res.status(200).json({
        ready:false,
        points:bot.length,
        note:'Not enough overlapping trading days across the bot and benchmark series yet.'
      });
    }

    const botMetrics=metricsFromSeries(bot,'value',10000);
    const startingEquity=bot[0].value;
    const botNormalized=bot.map(x=>({
      date:x.date,
      value:x.value/startingEquity*10000
    }));
    const normalizedBotMetrics=metricsFromSeries(botNormalized,'value',10000);

    const rows={
      AI_TRADER:{
        label:'AI Trader',
        ...normalizedBotMetrics,
        raw_start_equity:bot[0].value,
        raw_end_equity:bot.at(-1).value
      },
      SPY:{label:'SPY',...metricsFromSeries(spyAligned)},
      VTI:{label:'VTI',...metricsFromSeries(vtiAligned)},
      SIXTY_FORTY:{label:'60/40 VTI+BND',...metricsFromSeries(sixtyFortyAligned)}
    };

    return res.status(200).json({
      ready:true,
      period:{
        start:bot[0].date,
        end:bot.at(-1).date,
        trading_days:bot.length
      },
      methodology:{
        comparison:'Exact overlapping daily dates',
        benchmark_start_value:10000,
        sixty_forty:'60% VTI + 40% BND, daily-rebalanced research benchmark',
        note:'Risk-adjusted metrics use zero risk-free rate for comparison consistency.'
      },
      rows,
      excess_return:{
        vs_spy:rows.AI_TRADER.total_return-rows.SPY.total_return,
        vs_vti:rows.AI_TRADER.total_return-rows.VTI.total_return,
        vs_60_40:rows.AI_TRADER.total_return-rows.SIXTY_FORTY.total_return
      },
      series:{
        AI_TRADER:botNormalized,
        SPY:spyAligned,
        VTI:vtiAligned,
        SIXTY_FORTY:sixtyFortyAligned
      }
    });
  }catch(error){
    return res.status(500).json({error:error?.message||'Benchmark Lab failed'});
  }
}
