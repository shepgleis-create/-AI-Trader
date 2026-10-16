import {normalizeCryptoSymbol} from './crypto-eligibility.js';

export function identifyBotCryptoPosition(position,orders=[]){
  if(String(position?.asset_class||'').toLowerCase()!=='crypto')
    return {managed:false,reason:'not_crypto'};
  const symbol=normalizeCryptoSymbol(position?.symbol||'');
  const quantity=Number(position?.qty);
  if(!symbol||!Number.isFinite(quantity)||quantity<=0)
    return {managed:false,reason:'invalid_crypto_position'};
  const fills=(Array.isArray(orders)?orders:[])
    .filter(o=>normalizeCryptoSymbol(o?.symbol)===symbol&&
      Number(o.filled_qty)>0&&Number.isFinite(Date.parse(o.filled_at||'')))
    .sort((a,b)=>Date.parse(b.filled_at)-Date.parse(a.filled_at));
  const latest=fills[0];
  if(!latest||latest.side!=='buy'||!String(latest.client_order_id||'').startsWith('aitr-c-'))
    return {managed:false,reason:'latest_crypto_fill_not_bot_buy'};
  const filled=Number(latest.filled_qty);
  if(Math.abs(filled-quantity)>Math.max(0.00000001,quantity*0.0001))
    return {managed:false,reason:'crypto_quantity_changed_since_bot_buy'};
  return {managed:true,symbol,filled_at:latest.filled_at,
    client_order_id:latest.client_order_id,broker_order_id:latest.id||null};
}
export function cryptoHasPendingExit(symbol,openOrders=[]){
  const normalized=normalizeCryptoSymbol(symbol);
  return (Array.isArray(openOrders)?openOrders:[]).some(o=>
    normalizeCryptoSymbol(o?.symbol)===normalized&&o?.side==='sell'&&
    ['new','accepted','pending_new','partially_filled'].includes(String(o?.status||'').toLowerCase()));
}
