import { requireDashboardAuth } from '../lib/auth.js';
import { buildAccountRisk } from '../lib/account-risk.js';
import { getPortfolioRisk } from '../lib/risk.js';
import { getMultiAssetAiDecision } from '../lib/multi-asset-ai.js';
import {
  saveMultiAssetDecision,
  getAdaptiveResearchDataset
} from '../lib/decision-memory.js';
import {
  buildHistoricalRegimePriors,
  buildRegimeEnsemble
} from '../lib/regime-intelligence.js';

function sanitizeCandidate(x){
  if(!x||typeof x!=='object')return null;
  const y={...x};
  for(const k of Object.keys(y)){
    const v=y[k];
    if(typeof v==='string')y[k]=v.slice(0,500);
  }
  return y;
}
async function jf(url,opts={}){
  const r=await fetch(url,opts);const d=await r.json().catch(()=>({}));return{r,d};
}

export default async function handler(req,res){
  if(!requireDashboardAuth(req,res))return;
  if(req.method!=='POST')return res.status(405).json({error:'Method not allowed'});

  const key=process.env.ALPACA_API_KEY;
  const secret=process.env.ALPACA_SECRET_KEY;
  const gemini=process.env.GEMINI_API_KEY;
  const base=process.env.ALPACA_BASE_URL||'https://paper-api.alpaca.markets';
  if(!key||!secret)return res.status(500).json({error:'Missing Alpaca credentials'});
  if(!gemini)return res.status(503).json({error:'GEMINI_API_KEY is not configured'});
  if(!base.includes('paper-api.alpaca.markets'))return res.status(403).json({error:'Paper-only build'});

  const headers={'APCA-API-KEY-ID':key,'APCA-API-SECRET-KEY':secret};

  try{
    const historyUrl=new URL(`${base}/v2/account/portfolio/history`);
    historyUrl.searchParams.set('period','1M');
    historyUrl.searchParams.set('timeframe','1D');

    const [ap,pp,op,rp,hp]=await Promise.all([
      jf(`${base}/v2/account`,{headers}),
      jf(`${base}/v2/positions`,{headers}),
      jf(`${base}/v2/orders?status=open&limit=100&nested=true`,{headers}),
      jf(`${base}/v2/orders?status=all&limit=500&direction=desc&nested=true`,{headers}),
      jf(historyUrl,{headers})
    ]);

    if(!ap.r.ok||!pp.r.ok||!op.r.ok||!rp.r.ok){
      return res.status(502).json({error:'Could not load account context for multi-asset AI'});
    }

    const account=ap.d;
    const positions=Array.isArray(pp.d)?pp.d:[];
    const openOrders=Array.isArray(op.d)?op.d:[];
    const recent=Array.isArray(rp.d)?rp.d:[];

    const portfolioRisk=getPortfolioRisk(account,positions);
    const accountRisk=buildAccountRisk({
      account,positions,openOrders,recentOrders:recent,
      portfolioHistory:hp.r.ok?hp.d:{}
    });

    const supplied={
      longCandidate:sanitizeCandidate(req.body?.longCandidate),
      shortCandidate:sanitizeCandidate(req.body?.shortCandidate),
      cryptoCandidate:sanitizeCandidate(req.body?.cryptoCandidate),
      optionCandidate:sanitizeCandidate(req.body?.optionCandidate),
      callOptionCandidate:sanitizeCandidate(req.body?.callOptionCandidate),
      putOptionCandidate:sanitizeCandidate(req.body?.putOptionCandidate)
    };

    let adaptiveDataset={configured:false,router:[]};
    try{adaptiveDataset=await getAdaptiveResearchDataset(1000)}catch{}

    const regimeContext=req.body?.regimeContext&&typeof req.body.regimeContext==='object'
      ?req.body.regimeContext
      :{};
    const priors=buildHistoricalRegimePriors(regimeContext,adaptiveDataset?.router||[]);

    const decision=await getMultiAssetAiDecision({
      apiKey:gemini,
      account,
      positions,
      ...supplied,
      regimeContext:priors.current,
      historicalPriors:priors.lanes
    });

    const lanes={
      LONG_EQUITY:supplied.longCandidate,
      SHORT_EQUITY:supplied.shortCandidate,
      CRYPTO_LONG:supplied.cryptoCandidate,
      LONG_CALL:supplied.callOptionCandidate||
        (supplied.optionCandidate?.direction==='BULLISH'?supplied.optionCandidate:null),
      LONG_PUT:supplied.putOptionCandidate||
        (supplied.optionCandidate?.direction==='BEARISH'?supplied.optionCandidate:null)
    };

    const regimeEnsemble=buildRegimeEnsemble({
      regime:regimeContext,
      lanes,
      aiDecision:decision,
      historicalRows:adaptiveDataset?.router||[]
    });

    const hardLocks=[];
    if(account.trading_blocked||account.account_blocked)hardLocks.push('Account trading blocked');
    if(portfolioRisk.daily_loss_lock)hardLocks.push('Daily loss lock');
    if(portfolioRisk.exposure_lock)hardLocks.push('Portfolio exposure lock');
    if(portfolioRisk.position_lock)hardLocks.push('Position-count lock');
    if(!accountRisk.approved)hardLocks.push(...(accountRisk.locks||[]));

    const memory=await saveMultiAssetDecision({
      origin:'manual_router',
      mode:'PAPER',
      shadow:false,
      execution:false,
      decision,
      hard_risk_clear:hardLocks.length===0,
      hard_locks:hardLocks,
      lanes,
      account_risk:accountRisk,
      portfolio_risk:portfolioRisk,
      meta:{
        source:'dashboard',
        long_regime:regimeContext,
        regime_ensemble:regimeEnsemble
      }
    });

    return res.status(200).json({
      mode:'PAPER_RESEARCH',
      execution:false,
      decision,
      regime_ensemble:regimeEnsemble,
      memory,
      hard_risk_clear:hardLocks.length===0,
      hard_locks:hardLocks,
      account_risk:accountRisk,
      portfolio_risk:portfolioRisk,
      note:'This router recommends a lane only. Every execution endpoint independently revalidates live market and risk conditions.'
    });
  }catch(error){
    return res.status(500).json({error:error?.message||'Multi-asset AI routing failed'});
  }
}
