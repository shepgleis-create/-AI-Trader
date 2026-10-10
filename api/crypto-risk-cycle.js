import { withCronTelemetry } from '../lib/cron-telemetry.js';
import { isDashboardAuthorized } from '../lib/auth.js';
import { buildAccountRisk } from '../lib/account-risk.js';
import { getPortfolioRisk } from '../lib/risk.js';
import { fetchCryptoScan } from '../lib/multi-asset.js';
import {isStablecoinCrypto,cryptoEntryRejectionReasons,normalizeCryptoSymbol} from '../lib/crypto-eligibility.js';

const STOP=-0.05;
const TARGET=0.10;
const MAX_HOURS=72;
const AUTO_NOTIONAL=25;
const AUTO_SCORE_FLOOR=82;
const AUTO_MAX_SPREAD=0.005;
const AUTO_MAX_VOLATILITY=1.20;
const AUTO_ENTRY_COOLDOWN_HOURS=24;
const AUTO_STALE_ORDER_MINUTES=30;

function h(key,secret,content=false){
  return{
    'APCA-API-KEY-ID':key,
    'APCA-API-SECRET-KEY':secret,
    ...(content?{'Content-Type':'application/json'}:{})
  };
}
async function jf(url,opts={}){
  const r=await fetch(url,opts);
  const d=await r.json().catch(()=>({}));
  return{r,d};
}
function isCryptoPosition(p){
  return String(p?.asset_class||'').toLowerCase()==='crypto';
}
function isAutoCryptoId(v){
  return String(v||'').startsWith('aitr-c-auto-');
}

async function handler(req,res){
  if(req.method!=='GET')return res.status(405).json({error:'Method not allowed'});

  const cronSecret=process.env.CRON_SECRET;
  const ok=(cronSecret&&req.headers.authorization===`Bearer ${cronSecret}`)||isDashboardAuthorized(req);
  if(!ok)return res.status(401).json({error:'Unauthorized'});

  const key=process.env.ALPACA_API_KEY;
  const secret=process.env.ALPACA_SECRET_KEY;
  const base=process.env.ALPACA_BASE_URL||'https://paper-api.alpaca.markets';
  const enabled=String(process.env.AUTO_TRADING_ENABLED||'').toLowerCase()==='true';

  if(!key||!secret)return res.status(500).json({error:'Missing Alpaca credentials'});
  if(!base.includes('paper-api.alpaca.markets'))return res.status(403).json({error:'Paper-only build'});

  try{
    const historyUrl=new URL(`${base}/v2/account/portfolio/history`);
    historyUrl.searchParams.set('period','1M');
    historyUrl.searchParams.set('timeframe','1D');

    const [ap,pp,op,rp,hp]=await Promise.all([
      jf(`${base}/v2/account`,{headers:h(key,secret)}),
      jf(`${base}/v2/positions`,{headers:h(key,secret)}),
      jf(`${base}/v2/orders?status=open&limit=100&nested=true`,{headers:h(key,secret)}),
      jf(`${base}/v2/orders?status=all&limit=500&direction=desc&nested=true`,{headers:h(key,secret)}),
      jf(historyUrl,{headers:h(key,secret)})
    ]);

    if(!ap.r.ok||!pp.r.ok||!op.r.ok||!rp.r.ok){
      return res.status(502).json({error:'Could not load crypto automation state'});
    }

    const account=ap.d;
    const positions=Array.isArray(pp.d)?pp.d:[];
    const openOrders=Array.isArray(op.d)?op.d:[];
    const recent=Array.isArray(rp.d)?rp.d:[];
    const actions=[];

    // App-managed protection applies to both manual and autonomous paper crypto.
    const cryptoParents=recent.filter(o=>String(o?.client_order_id||'').startsWith('aitr-c-'));
    for(const p of positions){
      if(!isCryptoPosition(p))continue;
      const parent=cryptoParents.find(o=>normalizeCryptoSymbol(o.symbol)===normalizeCryptoSymbol(p.symbol)&&Number(o.filled_qty||0)>0);
      if(!parent)continue;

      const plpc=Number(p.unrealized_plpc||0);
      const submitted=new Date(parent.filled_at||parent.submitted_at||0).getTime();
      const ageHours=submitted>0?(Date.now()-submitted)/3600000:0;
      let reason=null;
      if(plpc<=STOP)reason='crypto_app_stop';
      else if(plpc>=TARGET)reason='crypto_app_target';
      else if(ageHours>=MAX_HOURS)reason='crypto_time_exit';
      if(!reason)continue;

      const close=await jf(`${base}/v2/positions/${encodeURIComponent(p.symbol)}`,{
        method:'DELETE',
        headers:h(key,secret)
      });
      actions.push({
        type:'exit',
        symbol:p.symbol,
        reason,
        plpc,
        age_hours:Number(ageHours.toFixed(1)),
        submitted:close.r.ok,
        order_id:close.d?.id||null,
        error:close.r.ok?null:close.d?.message||'Close rejected'
      });
    }

    // Cancel stale autonomous crypto entry orders.
    for(const o of openOrders){
      if(!isAutoCryptoId(o?.client_order_id)||o?.side!=='buy'||!o?.id)continue;
      const submitted=new Date(o.submitted_at||0).getTime();
      if(!(submitted>0))continue;
      const ageMinutes=(Date.now()-submitted)/60000;
      if(ageMinutes<AUTO_STALE_ORDER_MINUTES)continue;

      if(!enabled){
        actions.push({
          type:'stale_crypto_entry_cancel_dry_run',
          symbol:o.symbol,
          age_minutes:Number(ageMinutes.toFixed(1))
        });
        continue;
      }

      const cancel=await fetch(`${base}/v2/orders/${encodeURIComponent(o.id)}`,{
        method:'DELETE',
        headers:h(key,secret)
      });
      actions.push({
        type:'stale_crypto_entry_cancel',
        symbol:o.symbol,
        age_minutes:Number(ageMinutes.toFixed(1)),
        submitted:cancel.ok
      });
    }

    // Do not replace a crypto position in the same cycle we just tried to close.
    if(actions.some(a=>a.type==='exit'&&a.submitted)){
      return res.status(200).json({
        ok:true,
        mode:'PAPER',
        autonomous_entry_enabled:enabled,
        monitored:cryptoParents.length,
        stop_pct:STOP,
        target_pct:TARGET,
        max_hold_hours:MAX_HOURS,
        actions
      });
    }

    const cryptoPositions=positions.filter(p=>isCryptoPosition(p)&&!isStablecoinCrypto(p.symbol));
    const autoOpenOrders=openOrders.filter(o=>isAutoCryptoId(o?.client_order_id)&&!isStablecoinCrypto(o.symbol));
    const cutoff=Date.now()-AUTO_ENTRY_COOLDOWN_HOURS*3600000;
    const autoAttempts=recent.filter(o=>
      isAutoCryptoId(o?.client_order_id)&&!isStablecoinCrypto(o.symbol)&&
      new Date(o.submitted_at||0).getTime()>=cutoff
    );

    if(!enabled||req.cronAuditLockUnavailable){
      actions.push({
        type:'crypto_entry_lock',
        reason:req.cronAuditLockUnavailable?'Cron lease unavailable; new entries blocked, exits monitored':'AUTO_TRADING_ENABLED is OFF; autonomous crypto entries are dry-run only'
      });
      return res.status(200).json({
        ok:true,
        mode:'PAPER',
        autonomous_entry_enabled:false,
        monitored:cryptoParents.length,
        actions
      });
    }

    if(account.trading_blocked||account.account_blocked){
      actions.push({type:'crypto_entry_lock',reason:'Account trading is blocked'});
      return res.status(200).json({ok:true,mode:'PAPER',autonomous_entry_enabled:true,actions});
    }

    const portfolioRisk=getPortfolioRisk(account,positions);
    const accountRisk=buildAccountRisk({
      account,
      positions,
      openOrders,
      recentOrders:recent,
      portfolioHistory:hp.r.ok?hp.d:{}
    });

    if(!hp.r.ok){
      actions.push({type:'crypto_entry_lock',reason:'Portfolio history unavailable; autonomous entry fails closed'});
      return res.status(200).json({ok:true,mode:'PAPER',autonomous_entry_enabled:true,portfolio_risk:portfolioRisk,account_risk:accountRisk,actions});
    }
    if(!accountRisk.approved){
      actions.push({type:'crypto_entry_lock',reason:(accountRisk.locks||[]).join(' · ')||'Account circuit breaker'});
      return res.status(200).json({ok:true,mode:'PAPER',autonomous_entry_enabled:true,portfolio_risk:portfolioRisk,account_risk:accountRisk,actions});
    }
    if(portfolioRisk.daily_loss_lock||portfolioRisk.exposure_lock||portfolioRisk.position_lock){
      actions.push({type:'crypto_entry_lock',reason:'Portfolio risk gate blocked new crypto entry'});
      return res.status(200).json({ok:true,mode:'PAPER',autonomous_entry_enabled:true,portfolio_risk:portfolioRisk,account_risk:accountRisk,actions});
    }
    if(cryptoPositions.length>=1){
      actions.push({type:'crypto_entry_lock',reason:'One crypto position is already open'});
      return res.status(200).json({ok:true,mode:'PAPER',autonomous_entry_enabled:true,actions});
    }
    if(autoOpenOrders.length){
      actions.push({type:'crypto_entry_lock',reason:'An autonomous crypto entry order is already open'});
      return res.status(200).json({ok:true,mode:'PAPER',autonomous_entry_enabled:true,actions});
    }
    if(autoAttempts.length>=1){
      actions.push({
        type:'crypto_entry_lock',
        reason:`Rolling ${AUTO_ENTRY_COOLDOWN_HOURS}h autonomous crypto entry limit reached`
      });
      return res.status(200).json({ok:true,mode:'PAPER',autonomous_entry_enabled:true,actions});
    }

    const scan=await fetchCryptoScan(key,secret);
    const scoreSettings={scoreFloor:AUTO_SCORE_FLOOR,maxSpread:AUTO_MAX_SPREAD,maxVolatility:AUTO_MAX_VOLATILITY};
    const evaluated=(scan.candidates||[]).map(x=>({candidate:x,reasons:cryptoEntryRejectionReasons(x,scoreSettings)}));
    const candidate=evaluated.find(x=>!x.reasons.length)?.candidate||null;
    const rejectionSummary={};
    for(const item of evaluated)for(const reason of item.reasons)
      rejectionSummary[reason]=(rejectionSummary[reason]||0)+1;

    if(!candidate){
      actions.push({
        type:'crypto_no_setup',
        reason:'No crypto candidate cleared autonomous quality, liquidity and pump-risk gates',
        score_floor:AUTO_SCORE_FLOOR,
        candidates_reviewed:evaluated.length,
        rejection_counts:rejectionSummary,
        nearest_candidates:evaluated.slice(0,5).map(x=>({symbol:x.candidate.symbol,score:x.candidate.score,reasons:x.reasons}))
      });
      return res.status(200).json({
        ok:true,
        mode:'PAPER',
        autonomous_entry_enabled:true,
        scanned:Number(scan.deeply_analyzed||0),
        stablecoins_excluded:Number(scan.stablecoins_excluded||0),
        actions
      });
    }

    const u=new URL('https://data.alpaca.markets/v1beta3/crypto/us/snapshots');
    u.searchParams.set('symbols',candidate.symbol);
    const sp=await jf(u,{headers:h(key,secret)});
    if(!sp.r.ok){
      actions.push({type:'crypto_entry_reject',symbol:candidate.symbol,reason:'Could not refresh crypto quote'});
      return res.status(200).json({ok:true,mode:'PAPER',autonomous_entry_enabled:true,actions});
    }

    const s=sp.d?.snapshots?.[candidate.symbol]||sp.d?.[candidate.symbol]||{};
    const q=s?.latestQuote||s?.latest_quote||{};
    const t=s?.latestTrade||s?.latest_trade||{};
    const bid=Number(q.bp||0),ask=Number(q.ap||0),last=Number(t.p||0);
    const px=ask>0?ask:last;
    const mid=bid>0&&ask>0?(bid+ask)/2:0;
    const spread=mid>0?(ask-bid)/mid:null;

    if(!(px>0)||spread==null||spread>AUTO_MAX_SPREAD){
      actions.push({type:'crypto_entry_reject',symbol:candidate.symbol,reason:'Final crypto quote/spread check failed'});
      return res.status(200).json({ok:true,mode:'PAPER',autonomous_entry_enabled:true,actions});
    }

    const limit=(px*1.002).toFixed(px<1?6:px<100?4:2);
    const clientId=`aitr-c-auto-${candidate.symbol.replace('/','').toLowerCase()}-${String(Date.now()).slice(-7)}`.slice(0,48);
    const order=await jf(`${base}/v2/orders`,{
      method:'POST',
      headers:h(key,secret,true),
      body:JSON.stringify({
        symbol:candidate.symbol,
        notional:String(AUTO_NOTIONAL),
        side:'buy',
        type:'limit',
        limit_price:limit,
        time_in_force:'gtc',
        order_class:'simple',
        client_order_id:clientId
      })
    });

    actions.push({
      type:'crypto_entry',
      symbol:candidate.symbol,
      score:candidate.score,
      pump_dump_risk:candidate.pump_dump_risk,
      notional:AUTO_NOTIONAL,
      reference_price:px,
      limit_price:Number(limit),
      submitted:order.r.ok,
      order_id:order.d?.id||null,
      status:order.d?.status||null,
      error:order.r.ok?null:order.d?.message||'Crypto paper order rejected'
    });

    return res.status(200).json({
      ok:true,
      mode:'PAPER',
      autonomous_entry_enabled:true,
      monitored:cryptoParents.length,
      stop_pct:STOP,
      target_pct:TARGET,
      max_hold_hours:MAX_HOURS,
      rules:{
        max_crypto_positions:1,
        existing_stablecoins_do_not_occupy_momentum_slot:true,
        entry_cooldown_hours:AUTO_ENTRY_COOLDOWN_HOURS,
        score_floor:AUTO_SCORE_FLOOR,
        max_spread_pct:AUTO_MAX_SPREAD,
        max_volatility_14d:AUTO_MAX_VOLATILITY,
        max_entry_dollars:AUTO_NOTIONAL
      },
      actions
    });
  }catch(error){
    return res.status(500).json({error:error?.message||'Crypto automation cycle failed'});
  }
}

export default withCronTelemetry('crypto-risk-cycle',handler);
