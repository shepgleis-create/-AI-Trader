// Build only order classes supported by the paper broker.
// Alpaca cannot attach bracket legs to fractional stock orders.
export function buildEquityEntryOrder({symbol,qty,limitPrice,stopPrice,takeProfitPrice,clientOrderId}={}){
  const q=Number(qty),limit=Number(limitPrice),stop=Number(stopPrice),target=Number(takeProfitPrice);
  if(!/^[A-Z.]{1,12}$/.test(String(symbol||''))||!(q>0)||!Number.isFinite(q)||
     !(limit>0)||!(stop>0)||!(target>limit)||!(stop<limit)||
     !clientOrderId||String(clientOrderId).length>48){
    return {ok:false,reason:'Invalid paper order symbol, sizing or protective prices'};
  }
  const fractional=!Number.isInteger(q);
  const order={
    symbol,qty:String(q),side:'buy',type:'limit',limit_price:limitPrice,
    time_in_force:'day',order_class:fractional?'simple':'bracket',
    client_order_id:clientOrderId
  };
  if(!fractional){
    order.take_profit={limit_price:takeProfitPrice};
    order.stop_loss={stop_price:stopPrice};
  }
  return {
    ok:true,order,fractional,
    protection:fractional?'APP_MANAGED_INTRADAY_STOP_AND_TARGET':'BROKER_BRACKET',
    flatten_before_close:fractional,
    // Fractional simple orders cannot contain broker bracket legs.
    warning:fractional?'Stops and targets depend on scheduled monitoring until standalone protection is confirmed.':null
  };
}
