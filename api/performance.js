function std(values) {
  if (!values.length) return 0;
  const mean = values.reduce((a,b)=>a+b,0)/values.length;
  return Math.sqrt(values.reduce((s,v)=>s+(v-mean)**2,0)/values.length);
}

export default async function handler(req,res){
  if(req.method!=='GET') return res.status(405).json({error:'Method not allowed'});

  const key=process.env.ALPACA_API_KEY;
  const secret=process.env.ALPACA_SECRET_KEY;
  const baseUrl=process.env.ALPACA_BASE_URL||'https://paper-api.alpaca.markets';
  if(!key||!secret) return res.status(500).json({error:'Missing Alpaca credentials'});
  if(!baseUrl.includes('paper-api.alpaca.markets')) return res.status(403).json({error:'Paper-only build'});

  const headers={
    'APCA-API-KEY-ID':key,
    'APCA-API-SECRET-KEY':secret
  };

  try{
    const historyUrl=new URL(`${baseUrl}/v2/account/portfolio/history`);
    historyUrl.searchParams.set('period','1M');
    historyUrl.searchParams.set('timeframe','1D');

    const hr=await fetch(historyUrl,{headers});
    const h=await hr.json();
    if(!hr.ok) return res.status(hr.status).json({error:h?.message||'Could not load portfolio history'});

    const equities=(h?.equity||[]).map(Number);
    const timestamps=h?.timestamp||[];
    const points=[];
    for(let i=0;i<Math.min(equities.length,timestamps.length);i++){
      if(Number.isFinite(equities[i])&&equities[i]>0){
        points.push({t:Number(timestamps[i]),equity:equities[i]});
      }
    }
    if(points.length<2){
      return res.status(200).json({
        period:'1M',
        points:points.length,
        strategy_return:0,
        spy_return:0,
        excess_return_vs_spy:0,
        max_drawdown:0,
        sharpe:0,
        note:'Not enough paper-account history yet.'
      });
    }

    const start=new Date(points[0].t*1000);
    const end=new Date(points.at(-1).t*1000);
    const spyUrl=new URL('https://data.alpaca.markets/v2/stocks/SPY/bars');
    spyUrl.searchParams.set('timeframe','1Day');
    spyUrl.searchParams.set('start',start.toISOString());
    spyUrl.searchParams.set('end',end.toISOString());
    spyUrl.searchParams.set('adjustment','all');
    spyUrl.searchParams.set('feed','iex');
    spyUrl.searchParams.set('limit','1000');

    const sr=await fetch(spyUrl,{headers});
    const sd=await sr.json();
    const spyBars=sr.ok?(sd?.bars||[]):[];

    const first=points[0].equity,last=points.at(-1).equity;
    const strategyReturn=first>0?last/first-1:0;

    let peak=first,maxDrawdown=0;
    const returns=[];
    for(let i=0;i<points.length;i++){
      peak=Math.max(peak,points[i].equity);
      maxDrawdown=Math.min(maxDrawdown,points[i].equity/peak-1);
      if(i>0&&points[i-1].equity>0) returns.push(points[i].equity/points[i-1].equity-1);
    }

    const avg=returns.length?returns.reduce((a,b)=>a+b,0)/returns.length:0;
    const s=std(returns);
    const sharpe=s>0?(avg/s)*Math.sqrt(252):0;

    const spyStart=Number(spyBars[0]?.o||spyBars[0]?.c||0);
    const spyEnd=Number(spyBars.at(-1)?.c||0);
    const spyReturn=spyStart>0?spyEnd/spyStart-1:0;

    return res.status(200).json({
      period:'1M',
      points:points.length,
      start:start.toISOString(),
      end:end.toISOString(),
      starting_equity:first,
      ending_equity:last,
      strategy_return:strategyReturn,
      spy_return:spyReturn,
      excess_return_vs_spy:strategyReturn-spyReturn,
      max_drawdown:maxDrawdown,
      sharpe,
      pnl_dollars:last-first
    });
  }catch(error){
    return res.status(500).json({error:error?.message||'Performance request failed'});
  }
}
