// App-managed exits are restricted to matching fractional shares opened by this bot.
// Separate brokerage bracket orders protect whole-share trades.
const BOT_STOCK_IDS=/^aitr-[gq]-/;
export function identifyBotFractionalPosition(position,orders=[]){
  if(String(position?.asset_class||'').toLowerCase()!=='us_equity')
    return {managed:false,reason:'not_equity'};
  const quantity=Number(position.qty);
  if(!(quantity>0)||Number.isInteger(quantity))
    return {managed:false,reason:'not_fractional'};
  const ownOrders=(Array.isArray(orders)?orders:[]).filter(o=>
    o.symbol===position.symbol&&Number(o.filled_qty||0)>0&&
    Number.isFinite(new Date(o.filled_at||'').getTime())
  ).sort((a,b)=>new Date(b.filled_at)-new Date(a.filled_at));
  const latest=ownOrders[0];
  if(!latest||latest.side!=='buy'||!BOT_STOCK_IDS.test(String(latest.client_order_id||'')))
    return {managed:false,reason:'latest_fill_not_bot_buy'};
  if(Math.abs(Number(latest.filled_qty)-quantity)>Math.max(0.000001,quantity*0.0001))
    return {managed:false,reason:'mixed_or_changed_position_quantity'};
  return {managed:true,order_id:latest.id||null,client_order_id:latest.client_order_id,
    filled_at:latest.filled_at,quantity};
}
export function equityProtectionDecision({unrealizedPct,minutesEastern,marketOpen}={}){
  if(!marketOpen)return {action:'WAIT',reason:'stock_market_closed'};
  if(!Number.isFinite(Number(unrealizedPct)))
    return {action:'WAIT',reason:'missing_position_return'};
  if(Number(unrealizedPct)<=-0.03)
    return {action:'CLOSE',reason:'fractional_stop_loss_3pct'};
  if(Number(unrealizedPct)>=0.06)
    return {action:'CLOSE',reason:'fractional_take_profit_6pct'};
  if(Number(minutesEastern)>=15*60+45)
    return {action:'CLOSE',reason:'fractional_flatten_before_close'};
  return {action:'WAIT',reason:'within_managed_exit_bands'};
}
export function newYorkMarketMinutes(timestamp=new Date()){
  const parts=new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',hour12:false,
    hour:'2-digit',minute:'2-digit'}).formatToParts(timestamp);
  const get=name=>Number(parts.find(p=>p.type===name)?.value||0);
  return get('hour')*60+get('minute');
}
