import { isDashboardAuthorized } from '../lib/auth.js';
import { fetchMarketClock } from '../lib/alpaca-clock.js';
import { fetchMarketScan } from '../lib/strategy.js';
import { fetchShortScan, fetchCryptoScan, fetchOptionsForUnderlying } from '../lib/multi-asset.js';
import { getMultiAssetAiDecision } from '../lib/multi-asset-ai.js';
import { buildAccountRisk } from '../lib/account-risk.js';
import { getPortfolioRisk } from '../lib/risk.js';
import {
  saveMultiAssetDecision,
  getAdaptiveResearchDataset,
  syncResearchChallengers,
  getActiveResearchChallengers,
  recordResearchChallengerObservations,
  ensureSystemResearchChallenger,
  recordDirectChallengerObservation
} from '../lib/decision-memory.js';
import { buildAdaptiveRecommendations } from '../lib/research-recommendations.js';
import {
  buildHistoricalRegimePriors,
  buildRegimeEnsemble
} from '../lib/regime-intelligence.js';

function headers(key,secret){
  return {'APCA-API-KEY-ID':key,'APCA-API-SECRET-KEY':secret};
}
async function jf(url,opts={}){
  const r=await fetch(url,opts);
  const d=await r.json().catch(()=>({}));
  return {r,d};
}
function eligibleOption(chain){
  return (chain?.contracts||[]).find(x=>
    Number(x.quality_score||0)>=75 &&
    x.spread_pct!=null && Number(x.spread_pct)<=0.12 &&
    Number(x.ask||0)>0 &&
    Number(x.ask)*100<=100 &&
    Number(x.dte||0)>=7 &&
    Number(x.dte||0)<=45
  )||null;
}
function compactLane(x){
  if(!x)return null;
  const y={...x};
  delete y.reasons;
  return y;
}

async function updateChallengerResearch(memory,decision,lanes){
  if(!memory?.saved||!memory?.decision_id){
    return {configured:memory?.configured??false,recorded:0};
  }
  try{
    const dataset=await getAdaptiveResearchDataset(1000);
    if(!dataset.configured)return {configured:false,recorded:0};

    const recommendations=buildAdaptiveRecommendations(dataset);
    const sync=await syncResearchChallengers(recommendations.recommendations||[]);
    const experiments=await getActiveResearchChallengers();
    const observations=await recordResearchChallengerObservations({
      decision_id:memory.decision_id,
      decision,
      lanes,
      experiments
    });
    return {
      configured:true,
      synced:sync,
      active_experiments:experiments.length,
      recorded:observations.recorded||0
    };
  }catch(error){
    return {
      configured:true,
      recorded:0,
      error:String(error?.message||'Challenger research update failed').slice(0,220)
    };
  }
}

export default async function handler(req,res){
  if(req.method!=='GET') return res.status(405).json({error:'Method not allowed'});

  const cronSecret=process.env.CRON_SECRET;
  const cronAuthorized=Boolean(cronSecret)&&req.headers.authorization===`Bearer ${cronSecret}`;
  const dashboardAuthorized=isDashboardAuthorized(req);
  if(!cronAuthorized&&!dashboardAuthorized) return res.status(401).json({error:'Unauthorized'});

  const key=process.env.ALPACA_API_KEY;
  const secret=process.env.ALPACA_SECRET_KEY;
  const gemini=process.env.GEMINI_API_KEY;
  const base=process.env.ALPACA_BASE_URL||'https://paper-api.alpaca.markets';

  if(!key||!secret) return res.status(500).json({error:'Missing Alpaca credentials'});
  if(!gemini) return res.status(503).json({error:'GEMINI_API_KEY is not configured'});
  if(!base.includes('paper-api.alpaca.markets')) return res.status(403).json({error:'Paper-only build'});

  const h=headers(key,secret);

  try{
    const historyUrl=new URL(`${base}/v2/account/portfolio/history`);
    historyUrl.searchParams.set('period','1M');
    historyUrl.searchParams.set('timeframe','1D');

    const [accountPack,positionsPack,openPack,recentPack,historyPack,clockPack]=await Promise.all([
      jf(`${base}/v2/account`,{headers:h}),
      jf(`${base}/v2/positions`,{headers:h}),
      jf(`${base}/v2/orders?status=open&limit=100&nested=true`,{headers:h}),
      jf(`${base}/v2/orders?status=all&limit=500&direction=desc&nested=true`,{headers:h}),
      jf(historyUrl,{headers:h}),
      fetchMarketClock(base,h)
    ]);

    if(!accountPack.r.ok||!positionsPack.r.ok||!openPack.r.ok||!recentPack.r.ok){
      return res.status(502).json({error:'Could not load account context for shadow router'});
    }

    const account=accountPack.d;
    const positions=Array.isArray(positionsPack.d)?positionsPack.d:[];
    const openOrders=Array.isArray(openPack.d)?openPack.d:[];
    const recentOrders=Array.isArray(recentPack.d)?recentPack.d:[];

    const portfolioRisk=getPortfolioRisk(account,positions);
    const accountRisk=buildAccountRisk({
      account,
      positions,
      openOrders,
      recentOrders,
      portfolioHistory:historyPack.r.ok?historyPack.d:{}
    });

    const hardLocks=[];
    if(account.trading_blocked||account.account_blocked)hardLocks.push('Account trading blocked');
    if(portfolioRisk.daily_loss_lock)hardLocks.push('Daily loss lock');
    if(portfolioRisk.exposure_lock)hardLocks.push('Portfolio exposure lock');
    if(portfolioRisk.position_lock)hardLocks.push('Position-count lock');
    if(!accountRisk.approved)hardLocks.push(...(accountRisk.locks||[]));

    const laneErrors={};
    let longScan=null,shortScan=null,cryptoScan=null;

    const first=await Promise.allSettled([
      fetchMarketScan(key,secret),
      fetchCryptoScan(key,secret)
    ]);
    if(first[0].status==='fulfilled') longScan=first[0].value;
    else laneErrors.LONG_EQUITY=String(first[0].reason?.message||first[0].reason||'long scan failed').slice(0,220);

    if(first[1].status==='fulfilled') cryptoScan=first[1].value;
    else laneErrors.CRYPTO_LONG=String(first[1].reason?.message||first[1].reason||'crypto scan failed').slice(0,220);

    try{shortScan=await fetchShortScan(key,secret)}
    catch(error){laneErrors.SHORT_EQUITY=String(error?.message||error||'short scan failed').slice(0,220)}

    const longCandidate=(longScan?.candidates||[]).find(x=>Number(x.score||0)>=70)||longScan?.candidates?.[0]||null;
    const shortCandidate=(shortScan?.candidates||[]).find(x=>
      x.paper_short_eligible===true &&
      x.squeeze_risk!=='HIGH' &&
      Number(x.score||0)>=70
    )||null;
    const cryptoCandidate=(cryptoScan?.candidates||[]).find(x=>
      x.pump_dump_risk!=='HIGH' &&
      Number(x.score||0)>=70
    )||null;

    let callOptionCandidate=null;
    let putOptionCandidate=null;

    const optionJobs=[];
    if(longCandidate?.symbol&&Number(longCandidate.price)>0){
      optionJobs.push(
        fetchOptionsForUnderlying(longCandidate.symbol,'BULLISH',key,secret,Number(longCandidate.price))
          .then(chain=>({kind:'call',chain}))
          .catch(error=>({kind:'call',error}))
      );
    }
    if(shortCandidate?.symbol&&Number(shortCandidate.price)>0){
      optionJobs.push(
        fetchOptionsForUnderlying(shortCandidate.symbol,'BEARISH',key,secret,Number(shortCandidate.price))
          .then(chain=>({kind:'put',chain}))
          .catch(error=>({kind:'put',error}))
      );
    }

    for(const result of await Promise.all(optionJobs)){
      if(result.error){
        laneErrors[result.kind==='call'?'LONG_CALL':'LONG_PUT']=String(result.error?.message||result.error).slice(0,220);
        continue;
      }
      const selected=eligibleOption(result.chain);
      if(result.kind==='call'&&selected){
        callOptionCandidate={...selected,underlying:longCandidate.symbol,direction:'BULLISH'};
      }
      if(result.kind==='put'&&selected){
        putOptionCandidate={...selected,underlying:shortCandidate.symbol,direction:'BEARISH'};
      }
    }

    const availableCount=[
      longCandidate,shortCandidate,cryptoCandidate,callOptionCandidate,putOptionCandidate
    ].filter(Boolean).length;

    if(!availableCount){
      const decision={
        action:'SKIP',
        symbol:'',
        contract:'',
        confidence:100,
        rationale:'No healthy multi-asset lane produced a qualified shadow candidate.',
        model:'system'
      };
      const memory=await saveMultiAssetDecision({
        origin:'shadow_router',
        shadow:true,
        execution:false,
        decision,
        hard_risk_clear:hardLocks.length===0,
        hard_locks:hardLocks,
        lanes:{},
        account_risk:accountRisk,
        portfolio_risk:portfolioRisk,
        meta:{
          lane_errors:laneErrors,
          market_open:Boolean(clockPack.data?.is_open),
          clock_source:clockPack.source||null
        }
      });
      const challengerResearch=await updateChallengerResearch(memory,decision,{});
      return res.status(200).json({
        ok:true,shadow:true,decision,memory,
        challenger_research:challengerResearch,
        lane_errors:laneErrors
      });
    }

    const lanes={
      LONG_EQUITY:compactLane(longCandidate),
      SHORT_EQUITY:compactLane(shortCandidate),
      CRYPTO_LONG:compactLane(cryptoCandidate),
      LONG_CALL:compactLane(callOptionCandidate),
      LONG_PUT:compactLane(putOptionCandidate)
    };

    let adaptiveDataset={configured:false,router:[]};
    try{
      adaptiveDataset=await getAdaptiveResearchDataset(1000);
    }catch{}

    const priorContext=buildHistoricalRegimePriors(
      longScan?.regime||{},
      adaptiveDataset?.router||[]
    );

    const decision=await getMultiAssetAiDecision({
      apiKey:gemini,
      account,
      positions,
      longCandidate,
      shortCandidate,
      cryptoCandidate,
      callOptionCandidate,
      putOptionCandidate,
      regimeContext:priorContext.current,
      historicalPriors:priorContext.lanes
    });

    const regimeEnsemble=buildRegimeEnsemble({
      regime:longScan?.regime||{},
      lanes,
      aiDecision:decision,
      historicalRows:adaptiveDataset?.router||[]
    });

    const memory=await saveMultiAssetDecision({
      origin:'shadow_router',
      mode:'PAPER',
      shadow:true,
      execution:false,
      decision,
      regime_ensemble:regimeEnsemble,
      regime_experiment:regimeExperiment,
      hard_risk_clear:hardLocks.length===0,
      hard_locks:hardLocks,
      lanes,
      account_risk:accountRisk,
      portfolio_risk:portfolioRisk,
      meta:{
        lane_errors:laneErrors,
        market_open:Boolean(clockPack.data?.is_open),
        clock_source:clockPack.source||null,
        long_regime:longScan?.regime||null,
        regime_ensemble:regimeEnsemble,
        scan_cache:{
          long:Boolean(longScan?.cache_hit),
          short:Boolean(shortScan?.cache_hit),
          crypto:Boolean(cryptoScan?.cache_hit)
        }
      }
    });

    let regimeExperiment=null;
    if(memory?.saved&&memory?.decision_id){
      try{
        regimeExperiment=await ensureSystemResearchChallenger({
          experiment_id:'regime-ensemble-v1',
          title:'Regime Ensemble v1 vs Gemini Router',
          parameter_type:'REGIME_ENSEMBLE_V1',
          config:{version:1},
          minimum_1d:20,
          minimum_5d:10,
          meta:{
            description:'Prospective paired comparison of Gemini baseline versus deterministic regime-aware ensemble.',
            auto_apply:false
          }
        });
        await recordDirectChallengerObservation({
          experiment_id:'regime-ensemble-v1',
          decision_id:memory.decision_id,
          baseline_decision:decision,
          challenger_decision:regimeEnsemble.decision,
          context:{
            regime:regimeEnsemble.regime,
            lane_scores:regimeEnsemble.lane_scores,
            prior_source:regimeEnsemble.prior_source,
            matching_historical_decisions:regimeEnsemble.matching_historical_decisions,
            disagrees_with_ai:regimeEnsemble.disagrees_with_ai
          }
        });
      }catch(error){
        regimeExperiment={error:String(error?.message||'Regime ensemble challenger write failed').slice(0,220)};
      }
    }

    const challengerResearch=await updateChallengerResearch(memory,decision,lanes);

    return res.status(200).json({
      ok:true,
      mode:'PAPER_SHADOW',
      shadow:true,
      execution:false,
      market:{
        is_open:Boolean(clockPack.data?.is_open),
        clock_source:clockPack.source||null
      },
      decision,
      hard_risk_clear:hardLocks.length===0,
      hard_locks:hardLocks,
      lanes,
      lane_errors:laneErrors,
      memory,
      challenger_research:challengerResearch
    });
  }catch(error){
    return res.status(500).json({error:error?.message||'Shadow multi-asset router failed'});
  }
}
