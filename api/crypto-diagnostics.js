import {requireDashboardAuth} from '../lib/auth.js';
import {getDatabaseUrl} from '../lib/database-url.js';
import {isStablecoinCrypto,normalizeCryptoSymbol} from '../lib/crypto-eligibility.js';
import pg from 'pg';

export default async function handler(req,res){
  if(!requireDashboardAuth(req,res))return;
  if(req.method!=='GET')return res.status(405).json({error:'Method not allowed'});
  const key=process.env.ALPACA_API_KEY,secret=process.env.ALPACA_SECRET_KEY;
  const base=process.env.ALPACA_BASE_URL||'https://paper-api.alpaca.markets';
  if(!key||!secret||new URL(base).hostname!=='paper-api.alpaca.markets')
    return res.status(503).json({error:'Paper brokerage is not configured'});
  const headers={'APCA-API-KEY-ID':key,'APCA-API-SECRET-KEY':secret};
  const results=await Promise.allSettled([
    fetch(base+'/v2/positions',{headers}),
    fetch(base+'/v2/orders?status=all&limit=100&direction=desc',{headers})
  ]);
  if(results.some(r=>r.status==='rejected'||!r.value.ok))
    return res.status(502).json({error:'Unable to retrieve current paper positions or order history'});
  const [positions,orders]=await Promise.all(results.map(r=>r.value.json()));
  if(!Array.isArray(positions)||!Array.isArray(orders))
    return res.status(502).json({error:'Unexpected paper-broker response'});
  const cryptoPositions=positions.filter(p=>String(p.asset_class||'').toLowerCase()==='crypto');
  const stablecoinPositions=cryptoPositions.filter(p=>isStablecoinCrypto(p.symbol));
  const momentumPositions=cryptoPositions.filter(p=>!isStablecoinCrypto(p.symbol));
  const cryptoOrders=orders.filter(o=>String(o.client_order_id||'').startsWith('aitr-c-'));
  const botEntries=cryptoOrders.filter(o=>o.side==='buy');
  const now=Date.now(),dayMs=86400000;
  const recentEntries=botEntries.filter(o=>now-new Date(o.submitted_at||0).getTime()<dayMs);
  const url=getDatabaseUrl();
  let recentCycles=[],auditError=null;
  if(url){
    const pool=new pg.Pool({connectionString:url,max:1,connectionTimeoutMillis:4500});
    try{
      const r=await pool.query("SELECT started_at,status,action,detail FROM ai_trader_cron_runs WHERE job='crypto-risk-cycle' ORDER BY started_at DESC LIMIT 20");
      recentCycles=r.rows;
    }catch(e){auditError='Crypto audit records unavailable'}
    finally{await pool.end().catch(()=>{})}
  }else auditError='Decision Memory database not configured';
  res.setHeader('Cache-Control','no-store');
  return res.status(200).json({
    mode:'PAPER',generated_at:new Date().toISOString(),
    trading_enabled:String(process.env.AUTO_TRADING_ENABLED||'').toLowerCase()==='true',
    positions:{
      stablecoins:stablecoinPositions.map(p=>({symbol:p.symbol,market_value:Number(p.market_value||0),unrealized_pl:Number(p.unrealized_pl||0)})),
      momentum:momentumPositions.map(p=>({symbol:p.symbol,market_value:Number(p.market_value||0),unrealized_pl:Number(p.unrealized_pl||0)})),
      momentum_slots_available:Math.max(0,1-momentumPositions.length)
    },
    bot_orders:{
      scanned_recent_count:cryptoOrders.length,
      entry_orders_seen:botEntries.length,
      entry_attempts_last_24h:recentEntries.length,
      latest_entries:botEntries.slice(0,8).map(o=>({
        symbol:o.symbol,status:o.status,filled_qty:o.filled_qty||'0',
        submitted_at:o.submitted_at||null,filled_at:o.filled_at||null,
        client_order_id:o.client_order_id
      }))
    },
    recent_cycles:recentCycles,
    audit_warning:auditError,
    notice:'Stablecoins are excluded from new momentum entries. Existing stablecoins are never silently liquidated. Unrealized figures are not realized profits. Order history is limited to the latest 100 orders.'
  });
}
