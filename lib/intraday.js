function pct(a,b){
  if(!(a>0&&b>0)) return 0;
  return b/a-1;
}

function sessionStats(bars=[]){
  const rows=(Array.isArray(bars)?bars:[])
    .filter(b=>Number(b?.c)>0)
    .sort((a,b)=>new Date(a.t)-new Date(b.t));

  if(!rows.length){
    return {
      bars:0,
      first_price:null,
      last_price:null,
      session_return:null,
      vwap:null,
      distance_from_vwap:null,
      momentum_45m:null
    };
  }

  const first=Number(rows[0].o||rows[0].c);
  const last=Number(rows.at(-1).c);

  let weighted=0,volume=0;
  for(const b of rows){
    const v=Number(b.v||0);
    const vw=Number(b.vw||0);
    const proxy=vw>0?vw:(Number(b.h||0)+Number(b.l||0)+Number(b.c||0))/3;
    if(v>0&&proxy>0){
      weighted+=proxy*v;
      volume+=v;
    }
  }

  const vwap=volume>0?weighted/volume:null;
  const last4=rows.slice(-4);
  const momentum45=last4.length>=4
    ? pct(Number(last4[0].o||last4[0].c),Number(last4.at(-1).c))
    : null;

  return {
    bars:rows.length,
    first_price:first,
    last_price:last,
    session_return:first>0?pct(first,last):null,
    vwap,
    distance_from_vwap:vwap>0?pct(vwap,last):null,
    momentum_45m:momentum45
  };
}

export async function getIntradayConfirmation(symbol,key,secret){
  const end=new Date();
  const start=new Date(end.getTime()-14*60*60*1000);
  const url=new URL('https://data.alpaca.markets/v2/stocks/bars');
  url.searchParams.set('symbols',[symbol,'SPY'].join(','));
  url.searchParams.set('timeframe','15Min');
  url.searchParams.set('start',start.toISOString());
  url.searchParams.set('end',end.toISOString());
  url.searchParams.set('feed','iex');
  url.searchParams.set('adjustment','all');
  url.searchParams.set('limit','1000');

  const r=await fetch(url,{
    headers:{
      'APCA-API-KEY-ID':key,
      'APCA-API-SECRET-KEY':secret
    }
  });
  const data=await r.json().catch(()=>({}));
  if(!r.ok){
    return {
      available:false,
      approved:false,
      reasons:[`Intraday data unavailable: ${String(data?.message||r.statusText||'request failed').slice(0,180)}`]
    };
  }

  const stock=sessionStats(data?.bars?.[symbol]||[]);
  const spy=sessionStats(data?.bars?.SPY||[]);
  const reasons=[];

  if(stock.bars<3){
    return {
      available:false,
      approved:false,
      reasons:['Not enough 15-minute bars for execution confirmation'],
      stock,
      spy
    };
  }

  const relativeSession =
    stock.session_return!=null&&spy.session_return!=null
      ? stock.session_return-spy.session_return
      : null;

  if(stock.distance_from_vwap!=null&&stock.distance_from_vwap<=-0.01){
    reasons.push('Intraday confirmation failed: price is more than 1% below session VWAP');
  }
  if(stock.momentum_45m!=null&&stock.momentum_45m<=-0.02){
    reasons.push('Intraday confirmation failed: last ~45 minutes are sharply negative');
  }
  if(relativeSession!=null&&relativeSession<=-0.02){
    reasons.push('Intraday confirmation failed: stock is materially underperforming SPY today');
  }

  return {
    available:true,
    approved:reasons.length===0,
    reasons,
    relative_session_strength:relativeSession,
    stock,
    spy
  };
}
