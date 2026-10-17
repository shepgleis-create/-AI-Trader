// Alpaca order bookkeeping for autonomous PAPER stock entry attempts.
// A submitted, cancelled or rejected BUY is not a completed trade.
// Outstanding BUY orders must still block additional entries to avoid duplicate exposure.
const ACTIVE=new Set(['accepted','new','pending_new','partially_filled','calculated','pending_cancel','accepted_for_bidding']);
function alpacaOrderActive(o){return ACTIVE.has(String(o?.status||'').toLowerCase());}
export function equityEntryQuota(orders=[],now=new Date(),limit=1){
  const utcDay=now.toISOString().slice(0,10);
  const botBuys=(Array.isArray(orders)?orders:[]).filter(o=>o?.side==='buy'&&
    (/^aitr-[gq]-/.test(String(o?.client_order_id||''))));
  const filledToday=botBuys.filter(o=>Number(o.filled_qty||0)>0&&
    String(o.filled_at||o.submitted_at||'').slice(0,10)===utcDay);
  const pending=botBuys.filter(o=>alpacaOrderActive(o)&&Number(o.filled_qty||0)<=0);
  const todayAttempts=botBuys.filter(o=>String(o.submitted_at||'').slice(0,10)===utcDay);
  return {canEnter:filledToday.length<limit&&pending.length===0,
    filled_today:filledToday.length,
    submitted_today:todayAttempts.length,
    pending_count:pending.length,
    filled_trade_limit:limit,
    reason:pending.length?'UNFILLED_AUTONOMOUS_ORDER_PENDING':
      filledToday.length>=limit?'FILLED_DAILY_ENTRY_LIMIT':'CLEAR',
    pending_symbols:pending.map(o=>o.symbol).filter(Boolean)};
}
