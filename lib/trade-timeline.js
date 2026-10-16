// Canonical paper brokerage event normalization, independent of prediction logs.
// Alpaca fill activity transaction_time is the execution timestamp, not the order submission time.
function safeIso(value){
  const n=Date.parse(String(value||''));
  return Number.isFinite(n)?new Date(n).toISOString():null;
}
function finite(value){
  if(value==null||value==='')return null;
  const n=Number(value);return Number.isFinite(n)?n:null;
}
export function orderAssetClass(order={}){
  const a=String(order.asset_class||'').toLowerCase();
  if(['crypto','us_equity','us_option'].includes(a))return a;
  const symbol=String(order.symbol||'').toUpperCase();
  if(/^[A-Z.]{1,6}\d{6}[CP]\d{8}$/.test(symbol))return 'us_option';
  if(symbol.includes('/')||symbol.endsWith('USD'))return 'crypto';
  return 'us_equity';
}
export function orderOrigin(order={}){
  const client=String(order.client_order_id||'');
  if(/^aitr-/.test(client))return 'AI_TRADER';
  // Alpaca-generated position close orders may not inherit the initiating bot ID.
  return 'UNATTRIBUTED';
}
export function orderEvents(orders=[]){
  const unique=new Map();
  function visit(order){
    if(!order||typeof order!=='object')return;
    if(order.id)unique.set(String(order.id),order);
    for(const leg of Array.isArray(order.legs)?order.legs:[])visit(leg);
  }
  for(const order of orders)visit(order);
  const events=[];
  for(const o of unique.values()){
    const common={
      order_id:String(o.id),client_order_id:String(o.client_order_id||''),
      asset_class:orderAssetClass(o),symbol:String(o.symbol||''),
      side:String(o.side||'').toUpperCase(),origin:orderOrigin(o),
      quantity:finite(o.qty),filled_quantity:finite(o.filled_qty),
      filled_avg_price:finite(o.filled_avg_price),limit_price:finite(o.limit_price),
      order_type:String(o.type||''),order_status:String(o.status||'')
    };
    if(safeIso(o.submitted_at))events.push({...common,
      id:common.order_id+':SUBMITTED',event:'SUBMITTED',timestamp:safeIso(o.submitted_at),
      price:finite(o.limit_price),timestamp_source:'broker_submission'});
    for(const [key,event] of [['canceled_at','CANCELED'],['rejected_at','REJECTED'],
      ['expired_at','EXPIRED'],['failed_at','FAILED']]){
      if(safeIso(o[key]))events.push({...common,id:common.order_id+':'+event,
        event,timestamp:safeIso(o[key]),timestamp_source:'broker_order'});
    }
  }
  return events;
}
export function fillEvents(activities=[],orders=[]){
  const byId=new Map();
  function visit(o){
    if(!o||typeof o!=='object')return;
    if(o.id)byId.set(String(o.id),o);
    for(const leg of Array.isArray(o.legs)?o.legs:[])visit(leg);
  }
  for(const o of orders)visit(o);
  return (Array.isArray(activities)?activities:[]).filter(a=>
    a?.activity_type==='FILL'&&safeIso(a.transaction_time)&&
    a.order_id&&Number(a.qty)>0
  ).map(a=>{
    const order=byId.get(String(a.order_id))||{};
    const isPartial=String(a.type||'').toLowerCase()==='partial_fill';
    return {
      id:'fill:'+String(a.id||a.order_id+':'+a.transaction_time),
      event:isPartial?'PARTIAL_FILL':'FILL',
      timestamp:safeIso(a.transaction_time),timestamp_source:'broker_execution',
      order_id:String(a.order_id),client_order_id:String(order.client_order_id||''),
      symbol:String(a.symbol||order.symbol||''),
      asset_class:orderAssetClass({...order,symbol:a.symbol||order.symbol}),
      side:String(a.side||order.side||'').toUpperCase(),
      origin:orderOrigin(order),quantity:finite(a.qty),
      filled_quantity:finite(a.cum_qty),price:finite(a.price),
      filled_avg_price:finite(order.filled_avg_price),
      order_status:String(order.status||''),order_type:String(order.type||'')
    };
  });
}
export function tradeTimeline(orders=[],activities=[],maxEvents=250){
  const fills=fillEvents(activities,orders);
  const submitted=orderEvents(orders);
  const events=[...fills,...submitted].sort((a,b)=>
    Date.parse(b.timestamp)-Date.parse(a.timestamp)||a.id.localeCompare(b.id));
  const stats={
    actual_fill_events:fills.length,
    confirmed_buy_fill_events:fills.filter(f=>f.side==='BUY').length,
    confirmed_sell_fill_events:fills.filter(f=>f.side==='SELL').length,
    unique_filled_orders:new Set(fills.map(f=>f.order_id)).size,
    recorded_order_submissions:submitted.filter(e=>e.event==='SUBMITTED').length,
    latest_broker_execution_at:fills[0]?.timestamp||null
  };
  return {events:events.slice(0,Math.max(1,Math.min(500,maxEvents))),stats};
}
