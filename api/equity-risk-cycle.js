import {withCronTelemetry} from '../lib/cron-telemetry.js';
import {isDashboardAuthorized} from '../lib/auth.js';
import {fetchMarketClock} from '../lib/alpaca-clock.js';
import {identifyBotFractionalPosition,equityProtectionDecision,newYorkMarketMinutes}
  from '../lib/equity-protection.js';

// Five-minute safety backup for PAPER fractional stocks, whose broker orders
// cannot contain native bracket legs. This is not continuous or guaranteed
// stop-loss execution; exchange and serverless outages remain possible.
async function handler(req,res){
  if(req.method!=='GET')return res.status(405).json({error:'Method not allowed'});
  const cron=process.env.CRON_SECRET&&req.headers.authorization==='Bearer '+process.env.CRON_SECRET;
  if(!cron&&!isDashboardAuthorized(req))return res.status(401).json({error:'Unauthorized'});
  const base=process.env.ALPACA_BASE_URL||'https://paper-api.alpaca.markets';
  let broker;
  try{broker=new URL(base)}catch{}
  if(broker?.protocol!=='https:'||broker?.hostname!=='paper-api.alpaca.markets')
    return res.status(403).json({error:'Paper-only risk worker'});
  const key=process.env.ALPACA_API_KEY,secret=process.env.ALPACA_SECRET_KEY;
  if(!key||!secret)return res.status(503).json({error:'Paper brokerage credentials are not configured'});
  const headers={'APCA-API-KEY-ID':key,'APCA-API-SECRET-KEY':secret};
  const get=async path=>{
    const r=await fetch(base+path,{headers,signal:AbortSignal.timeout(7000)});
    const data=await r.json().catch(()=>null);
    if(!r.ok)throw Error('Paper broker '+path.split('?')[0]+' HTTP '+r.status+
      ': '+String(data?.message||data?.error||'read failed').slice(0,110));
    return data;
  };
  try{
    // Alpaca v2/clock can return 404 for a connected account. Reuse the
    // established v3/calendar/exchange-session clock fallback used by stock automation.
    const clockPack=await fetchMarketClock(base,headers);
    if(!clockPack.ok||!clockPack.data)
      throw Error('Market clock unavailable: '+String(clockPack.error||'No session data'));
    const clock=clockPack.data;
    const enabled=String(process.env.AUTO_TRADING_ENABLED||'').toLowerCase()==='true';
    const actions=[],monitored=[];
    const marketOpen=clock.is_open===true;
    const minutesEastern=newYorkMarketMinutes(new Date(clock.timestamp||Date.now()));
    if(!marketOpen)return res.status(200).json({ok:true,mode:'PAPER',action:'market_closed',
      clock_source:clockPack.source,monitored:0,actions});
    const [positions,orders]=await Promise.all([
      get('/v2/positions'),
      get('/v2/orders?status=all&limit=500&direction=desc&nested=true')
    ]);
    if(!Array.isArray(positions)||!Array.isArray(orders))
      throw Error('Incomplete paper brokerage positions or order history');
    for(const position of positions){
      const owner=identifyBotFractionalPosition(position,orders);
      if(!owner.managed){
        if(owner.reason==='mixed_or_changed_position_quantity'&&String(position.asset_class)==='us_equity')
          actions.push({type:'protection_warning',symbol:position.symbol,reason:owner.reason});
        continue;
      }
      const decision=equityProtectionDecision({
        unrealizedPct:Number(position.unrealized_plpc),
        minutesEastern,marketOpen
      });
      monitored.push({symbol:position.symbol,return_pct:Number(position.unrealized_plpc),
        decision:decision.action,reason:decision.reason});
      if(decision.action!=='CLOSE')continue;
      if(!enabled){
        actions.push({type:'fractional_exit_dry_run',symbol:position.symbol,reason:decision.reason});
        continue;
      }
      // Re-query open sells before closing to avoid conflicting protection/exit orders.
      const open=await get('/v2/orders?status=open&limit=100');
      if(!Array.isArray(open))throw Error('Could not verify open stock orders');
      if(open.some(o=>o.symbol===position.symbol&&o.side==='sell')){
        actions.push({type:'fractional_exit_deferred',symbol:position.symbol,
          reason:'existing_sell_order_pending'});
        continue;
      }
      const close=await fetch(base+'/v2/positions/'+encodeURIComponent(position.symbol),{
        method:'DELETE',headers,signal:AbortSignal.timeout(7000)
      });
      const result=await close.json().catch(()=>({}));
      actions.push({type:'fractional_exit',symbol:position.symbol,reason:decision.reason,
        submitted:close.ok,order_id:result?.id||null,
        error:close.ok?null:String(result?.message||'Broker rejected close request').slice(0,140)});
    }
    return res.status(200).json({ok:true,mode:'PAPER',automation_enabled:enabled,
      clock_source:clockPack.source,
      monitored:monitored.length,positions:monitored,actions,
      warning:'Fractional positions rely on periodic app-managed exits, not guaranteed broker stops.'});
  }catch(error){return res.status(503).json({ok:false,mode:'PAPER',
    error:'Equity fraction protection data unavailable',
    reason:String(error?.message||'unknown').slice(0,180)})}
}
export {handler as equityRiskHandlerForTests};
export default withCronTelemetry('equity-risk-cycle',handler);
