const DEFAULT_TZ='America/New_York';

function sleep(ms){return new Promise(r=>setTimeout(r,ms));}

async function retryFetch(url,options={},attempts=3){
  let last=null;
  for(let i=0;i<attempts;i++){
    last=await fetch(url,options);
    if(last.status!==429&&last.status<500)return last;
    if(i<attempts-1){
      const retryAfter=Number(last.headers.get('retry-after')||0);
      await sleep(retryAfter>0?retryAfter*1000:350*(i+1));
    }
  }
  return last;
}

function collectObjects(value,out=[]){
  if(!value||typeof value!=='object')return out;
  if(Array.isArray(value)){
    for(const v of value)collectObjects(v,out);
    return out;
  }
  out.push(value);
  for(const v of Object.values(value)){
    if(v&&typeof v==='object')collectObjects(v,out);
  }
  return out;
}

function phaseIsOpen(phase){
  const p=String(phase||'').toUpperCase();
  if(!p)return null;
  if(/CLOSED|POST|PRE|OVERNIGHT|HALTED/.test(p))return false;
  if(/OPEN|REGULAR|CONTINUOUS|TRADING/.test(p))return true;
  return null;
}

function normalizeClockObject(raw){
  if(!raw||typeof raw!=='object')return null;
  const market=String(raw.market||raw.market_code||raw.code||raw.exchange||raw.name||'').toUpperCase();
  const directOpen=typeof raw.is_open==='boolean'?raw.is_open:null;
  const derivedOpen=phaseIsOpen(raw.phase||raw.status||raw.market_phase);
  const isOpen=directOpen??derivedOpen;

  const timestamp=
    raw.timestamp||raw.time||raw.current_time||raw.as_of||raw.now||null;
  const nextOpen=
    raw.next_open||raw.next_market_open||raw.next_session_open||raw.next_open_at||null;
  const nextClose=
    raw.next_close||raw.next_market_close||raw.next_session_close||raw.next_close_at||null;

  if(isOpen==null&&!timestamp&&!nextOpen&&!nextClose)return null;
  return {
    market,
    timestamp:timestamp||new Date().toISOString(),
    is_open:Boolean(isOpen),
    next_open:nextOpen||null,
    next_close:nextClose||null,
    phase:raw.phase||raw.status||raw.market_phase||null
  };
}

function pickV3Clock(data){
  const rows=collectObjects(data)
    .map(normalizeClockObject)
    .filter(Boolean);
  if(!rows.length)return null;
  const preferred=rows.find(x=>['XNYS','NYSE','XNAS','NASDAQ','IEX'].includes(x.market));
  return preferred||rows[0];
}

function tzParts(date,timeZone=DEFAULT_TZ){
  const parts=new Intl.DateTimeFormat('en-US',{
    timeZone,
    year:'numeric',month:'2-digit',day:'2-digit',
    hour:'2-digit',minute:'2-digit',second:'2-digit',
    hour12:false
  }).formatToParts(date);
  const get=t=>Number(parts.find(p=>p.type===t)?.value||0);
  return {
    year:get('year'),month:get('month'),day:get('day'),
    hour:get('hour')%24,minute:get('minute'),second:get('second')
  };
}

function tzOffsetMs(date,timeZone=DEFAULT_TZ){
  const p=tzParts(date,timeZone);
  const asUtc=Date.UTC(p.year,p.month-1,p.day,p.hour,p.minute,p.second);
  return asUtc-date.getTime();
}

function zonedDateTime(dateKey,timeText,timeZone=DEFAULT_TZ){
  if(!dateKey||!timeText)return null;
  const [y,m,d]=String(dateKey).split('-').map(Number);
  const match=String(timeText).match(/(\d{1,2}):(\d{2})/);
  if(!y||!m||!d||!match)return null;
  const hh=Number(match[1]),mm=Number(match[2]);
  const wall=new Date(Date.UTC(y,m-1,d,hh,mm,0));
  let offset=tzOffsetMs(wall,timeZone);
  let result=new Date(wall.getTime()-offset);
  const refined=tzOffsetMs(result,timeZone);
  if(refined!==offset)result=new Date(wall.getTime()-refined);
  return result;
}

function dateKeyInTz(date,timeZone=DEFAULT_TZ){
  const p=tzParts(date,timeZone);
  return `${p.year}-${String(p.month).padStart(2,'0')}-${String(p.day).padStart(2,'0')}`;
}

async function clockFromCalendar(baseUrl,headers){
  const now=new Date();
  const start=dateKeyInTz(new Date(now.getTime()-2*86400000));
  const end=dateKeyInTz(new Date(now.getTime()+10*86400000));
  const url=new URL(`${baseUrl}/v2/calendar`);
  url.searchParams.set('start',start);
  url.searchParams.set('end',end);

  const r=await retryFetch(url,{headers});
  const data=await r.json().catch(()=>[]);
  if(!r.ok||!Array.isArray(data)){
    return {
      ok:false,status:r.status,
      error:String(data?.message||data?.error||r.statusText||'Calendar fallback failed').slice(0,220)
    };
  }

  const sessions=data.map(row=>{
    const open=zonedDateTime(row.date,row.open);
    const close=zonedDateTime(row.date,row.close);
    return open&&close?{date:row.date,open,close}:null;
  }).filter(Boolean).sort((a,b)=>a.open-b.open);

  if(!sessions.length){
    return {ok:false,status:502,error:'Calendar fallback returned no usable market sessions'};
  }

  const nowMs=now.getTime();
  const active=sessions.find(s=>nowMs>=s.open.getTime()&&nowMs<s.close.getTime())||null;
  const nextSession=sessions.find(s=>s.open.getTime()>nowMs)||null;
  const afterActive=active?sessions.find(s=>s.open.getTime()>active.close.getTime()):null;

  return {
    ok:true,
    status:200,
    source:'calendar_fallback',
    data:{
      timestamp:now.toISOString(),
      is_open:Boolean(active),
      next_open:(active?afterActive:nextSession)?.open?.toISOString()||null,
      next_close:(active?.close||nextSession?.close)?.toISOString()||null
    }
  };
}


function nthWeekdayOfMonth(year,month,weekday,n){
  const first=new Date(Date.UTC(year,month-1,1));
  const delta=(weekday-first.getUTCDay()+7)%7;
  return new Date(Date.UTC(year,month-1,1+delta+(n-1)*7));
}
function lastWeekdayOfMonth(year,month,weekday){
  const last=new Date(Date.UTC(year,month,0));
  const delta=(last.getUTCDay()-weekday+7)%7;
  return new Date(Date.UTC(year,month-1,last.getUTCDate()-delta));
}
function observedFixedHoliday(year,month,day){
  const d=new Date(Date.UTC(year,month-1,day));
  const dow=d.getUTCDay();
  if(dow===6)return new Date(Date.UTC(year,month-1,day-1));
  if(dow===0)return new Date(Date.UTC(year,month-1,day+1));
  return d;
}
function easterSunday(year){
  const a=year%19,b=Math.floor(year/100),cc=year%100,d=Math.floor(b/4),e=b%4;
  const f=Math.floor((b+8)/25),g=Math.floor((b-f+1)/3),h=(19*a+b-d-g+15)%30;
  const i=Math.floor(cc/4),k=cc%4,l=(32+2*e+2*i-h-k)%7,m=Math.floor((a+11*h+22*l)/451);
  const month=Math.floor((h+l-7*m+114)/31);
  const day=((h+l-7*m+114)%31)+1;
  return new Date(Date.UTC(year,month-1,day));
}
function localHolidayKeys(year){
  const dates=[];
  dates.push(observedFixedHoliday(year,1,1));
  dates.push(nthWeekdayOfMonth(year,1,1,3)); // MLK
  dates.push(nthWeekdayOfMonth(year,2,1,3)); // Presidents
  const easter=easterSunday(year);
  dates.push(new Date(easter.getTime()-2*86400000)); // Good Friday
  dates.push(lastWeekdayOfMonth(year,5,1)); // Memorial
  if(year>=2022)dates.push(observedFixedHoliday(year,6,19)); // Juneteenth
  dates.push(observedFixedHoliday(year,7,4));
  dates.push(nthWeekdayOfMonth(year,9,1,1)); // Labor
  dates.push(nthWeekdayOfMonth(year,11,4,4)); // Thanksgiving
  dates.push(observedFixedHoliday(year,12,25));
  // Jan 1 of next year may be observed on Dec 31 of this year.
  const nextNewYear=observedFixedHoliday(year+1,1,1);
  if(nextNewYear.getUTCFullYear()===year)dates.push(nextNewYear);
  return new Set(dates.map(d=>d.toISOString().slice(0,10)));
}
function isLocalNyseTradingDay(date){
  const p=tzParts(date,DEFAULT_TZ);
  const wall=new Date(Date.UTC(p.year,p.month-1,p.day));
  const dow=wall.getUTCDay();
  if(dow===0||dow===6)return false;
  return !localHolidayKeys(p.year).has(dateKeyInTz(date,DEFAULT_TZ));
}
function isEarlyCloseDate(date){
  const p=tzParts(date,DEFAULT_TZ);
  const key=dateKeyInTz(date,DEFAULT_TZ);
  // Day after Thanksgiving.
  const thanksgiving=nthWeekdayOfMonth(p.year,11,4,4);
  const afterThanksgiving=new Date(thanksgiving.getTime()+86400000).toISOString().slice(0,10);
  if(key===afterThanksgiving)return true;
  // Christmas Eve when it is itself a trading day.
  if(p.month===12&&p.day===24&&isLocalNyseTradingDay(date))return true;
  // July 3 when it is itself a trading day.
  if(p.month===7&&p.day===3&&isLocalNyseTradingDay(date))return true;
  return false;
}
function sessionForLocalDate(date){
  const key=dateKeyInTz(date,DEFAULT_TZ);
  const open=zonedDateTime(key,'09:30',DEFAULT_TZ);
  const close=zonedDateTime(key,isEarlyCloseDate(date)?'13:00':'16:00',DEFAULT_TZ);
  return {key,open,close};
}
function localNyseClock(){
  const now=new Date();
  let cursor=new Date(now);
  const todayTrading=isLocalNyseTradingDay(now);
  const today=todayTrading?sessionForLocalDate(now):null;
  const isOpen=Boolean(today&&now>=today.open&&now<today.close);

  let nextOpen=null,nextClose=null;
  if(isOpen){
    nextClose=today.close;
    cursor=new Date(now.getTime()+86400000);
  }else if(today&&now<today.open){
    nextOpen=today.open;
    nextClose=today.close;
    cursor=null;
  }else{
    cursor=new Date(now.getTime()+86400000);
  }

  if(cursor){
    for(let i=0;i<14;i++){
      const d=new Date(cursor.getTime()+i*86400000);
      if(!isLocalNyseTradingDay(d))continue;
      const session=sessionForLocalDate(d);
      nextOpen=nextOpen||session.open;
      nextClose=nextClose||session.close;
      break;
    }
  }

  return {
    ok:true,
    status:200,
    source:'local_nyse_fallback',
    data:{
      timestamp:now.toISOString(),
      is_open:isOpen,
      next_open:nextOpen?.toISOString()||null,
      next_close:(isOpen?today.close:nextClose)?.toISOString()||null,
      fallback_note:'Exchange schedule computed locally because Alpaca clock/calendar endpoints were unavailable.'
    }
  };
}

export async function fetchMarketClock(baseUrl,headers){
  const v2=await retryFetch(`${baseUrl}/v2/clock`,{headers});
  const v2Data=await v2.json().catch(()=>({}));
  if(v2.ok&&typeof v2Data?.is_open==='boolean'){
    return {ok:true,status:v2.status,source:'v2',data:v2Data};
  }

  const v3Url=new URL(`${baseUrl}/v3/clock`);
  v3Url.searchParams.set('markets','XNYS');
  const v3=await retryFetch(v3Url,{headers});
  const v3Data=await v3.json().catch(()=>({}));
  if(v3.ok){
    const normalized=pickV3Clock(v3Data);
    if(normalized){
      if(normalized.next_open&&normalized.next_close){
        return {ok:true,status:v3.status,source:'v3',data:normalized};
      }
      const calendar=await clockFromCalendar(baseUrl,headers);
      if(calendar.ok){
        return {
          ok:true,status:v3.status,source:'v3+calendar',
          data:{
            ...calendar.data,
            ...normalized,
            next_open:normalized.next_open||calendar.data.next_open,
            next_close:normalized.next_close||calendar.data.next_close
          }
        };
      }
    }
  }

  const calendar=await clockFromCalendar(baseUrl,headers);
  if(calendar.ok)return calendar;

  const local=localNyseClock();
  return {
    ...local,
    upstream_errors:[
      `v2 HTTP ${v2.status}: ${String(v2Data?.message||v2Data?.error||v2.statusText||'failed').slice(0,100)}`,
      `v3 HTTP ${v3.status}: ${String(v3Data?.message||v3Data?.error||v3.statusText||'failed').slice(0,100)}`,
      `calendar: ${calendar.error||'failed'}`
    ]
  };
}
