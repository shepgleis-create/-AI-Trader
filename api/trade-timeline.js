import {requireDashboardAuth} from '../lib/auth.js';
import {tradeTimeline} from '../lib/trade-timeline.js';

export async function tradeTimelineHandler(req,res){
  if(!requireDashboardAuth(req,res))return;
  if(req.method!=='GET')return res.status(405).json({error:'Method not allowed'});
  const base=process.env.ALPACA_BASE_URL||'https://paper-api.alpaca.markets';
  let parsed;
  try{parsed=new URL(base)}catch{return res.status(503).json({error:'Invalid paper broker URL'})}
  if(parsed.protocol!=='https:'||parsed.hostname!=='paper-api.alpaca.markets')
    return res.status(403).json({error:'This trading history is paper-only'});
  const key=process.env.ALPACA_API_KEY,secret=process.env.ALPACA_SECRET_KEY;
  if(!key||!secret)return res.status(503).json({error:'Paper brokerage not configured'});
  const headers={'APCA-API-KEY-ID':key,'APCA-API-SECRET-KEY':secret};
  const get=async url=>{
    const r=await fetch(url,{headers,signal:AbortSignal.timeout(9000)});
    const body=await r.json().catch(()=>null);
    if(!r.ok||!Array.isArray(body))throw Error('Broker historical data unavailable: HTTP '+r.status);
    return body;
  };
  try{
    const after=new Date(Date.now()-90*86400000).toISOString();
    const ordersUrl=new URL('/v2/orders',base);
    ordersUrl.searchParams.set('status','all');
    ordersUrl.searchParams.set('limit','500');
    ordersUrl.searchParams.set('direction','desc');
    ordersUrl.searchParams.set('nested','false');
    ordersUrl.searchParams.set('after',after);
    const fillsUrl=new URL('/v2/account/activities/FILL',base);
    fillsUrl.searchParams.set('page_size','100');
    fillsUrl.searchParams.set('direction','desc');
    fillsUrl.searchParams.set('after',after);
    let [orders,activities]=await Promise.all([get(ordersUrl),get(fillsUrl)]);
    const firstPageCount=orders.length,firstFillsCount=activities.length;
    // Alpaca's fill activities give individual execution times for partial fills.
    // Bound network work and publish coverage limitations instead of inventing history.
    let fillPages=1;
    while(activities.length<300&&fillPages<3&&firstFillsCount>0){
      const last=activities.at(-1);
      const previousCount=activities.length;
      if(previousCount%100!==0||!last?.id)break;
      fillsUrl.searchParams.set('page_token',String(last.id));
      const page=await get(fillsUrl);
      if(!page.length)break;
      activities=activities.concat(page);
      fillPages++;
      if(page.length<100)break;
    }
    const data=tradeTimeline(orders,activities,250);
    const filledOrdersKnown=new Set(orders.map(o=>o.id));
    const fillsWithoutOrder=activities.filter(a=>!filledOrdersKnown.has(a.order_id)).length;
    res.setHeader('Cache-Control','private, no-store');
    return res.status(200).json({
      ok:true,mode:'PAPER',
      generated_at:new Date().toISOString(),
      lookback_days:90,
      fill_coverage:activities.length,
      orders_scanned:orders.length,
      order_history_may_be_truncated:firstPageCount===500,
      fill_history_may_be_truncated:activities.length>=300,
      unmatched_fills:fillsWithoutOrder,
      ...data,
      explanations:{
        fill:'FILL times are Alpaca execution timestamps. SUBMITTED times are requests received by the broker, not trades.',
        origin:'AI_TRADER means the order carries the bot client ID. UNATTRIBUTED includes manual orders and bot-triggered position closes without the original client ID.',
        options:'Options CALL/PUT contracts appear under us_option. This timeline does not claim options entries are fully automated.',
        pnl:'This timeline reports transactions and execution prices, not realized profit after fees.'
      }
    });
  }catch(error){
    return res.status(502).json({error:'Could not retrieve broker-verified trading history',
      reason:String(error?.message||'Unknown broker error').slice(0,140)});
  }
}
export default tradeTimelineHandler;
