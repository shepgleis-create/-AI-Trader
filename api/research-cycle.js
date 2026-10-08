import { withCronTelemetry,cronDatabaseConfig } from '../lib/cron-telemetry.js';
import { isDashboardAuthorized } from '../lib/auth.js';
import { fetchMarketScan } from '../lib/strategy.js';
import { fetchCryptoScan } from '../lib/multi-asset.js';
import { fetchNewsContext } from '../lib/context.js';
import { newDecisionCycleId,saveDecisionMemory } from '../lib/decision-memory.js';
import { assessResearchCandidate } from '../lib/research-lenses.js';

function preview(candidate){
  if(!candidate)return null;
  return {
    symbol:candidate.symbol,
    score:Number(candidate.score||0),
    price:Number(candidate.price||0),
    setup:candidate.setup||candidate.setup_type||null,
    momentum_20d:candidate.momentum_20d??null,
    momentum_7d:candidate.momentum_7d??null,
    pump_dump_risk:candidate.pump_dump_risk||null
  };
}
async function handler(req,res){
  if(req.method!=='GET')return res.status(405).json({error:'Method not allowed'});
  const cronSecret=String(process.env.CRON_SECRET||'');
  const fromCron=Boolean(cronSecret)&&req.headers?.authorization==='Bearer '+cronSecret;
  if(!fromCron&&!isDashboardAuthorized(req))return res.status(401).json({error:'Unauthorized'});
  const key=process.env.ALPACA_API_KEY,secret=process.env.ALPACA_SECRET_KEY;
  const base=process.env.ALPACA_BASE_URL||'https://paper-api.alpaca.markets';
  if(!key||!secret)return res.status(503).json({error:'Alpaca credentials not configured'});
  if(new URL(base).hostname!=='paper-api.alpaca.markets')return res.status(403).json({error:'Paper-only endpoint required'});
  const generated_at=new Date().toISOString();
  const [stocks,crypto]=await Promise.allSettled([
    fetchMarketScan(key,secret),fetchCryptoScan(key,secret)
  ]);
  const topStocks=stocks.status==='fulfilled'?(stocks.value?.candidates||[]).slice(0,8):[];
  const topCrypto=crypto.status==='fulfilled'?(crypto.value?.candidates||[]).slice(0,8):[];
  let articles={},newsError=null;
  if(topStocks.length){
    try{articles=await fetchNewsContext(topStocks.map(x=>x.symbol),key,secret)}
    catch(error){newsError=String(error?.message||'News feed failed').slice(0,180)}
  }
  const headlineCount=Object.values(articles).reduce((n,arr)=>n+(arr?.length||0),0);
  const researchLenses=topStocks.map(c=>assessResearchCandidate(c,articles[c.symbol]||[]));
  const errors={
    ...(stocks.status==='rejected'?{stocks:String(stocks.reason?.message||'Stock scan failed').slice(0,180)}:{}),
    ...(crypto.status==='rejected'?{crypto:String(crypto.reason?.message||'Crypto scan failed').slice(0,180)}:{}),
    ...(newsError?{news:newsError}:{})
  };
  const db=cronDatabaseConfig();
  let memory={configured:db.configured,saved:false,reason:db.error||null};
  if(db.valid&&stocks.status==='fulfilled'){
    try{
      memory=await saveDecisionMemory({
        cycle_id:newDecisionCycleId('research'),
        origin:'research_cycle',
        mode:'PAPER_RESEARCH',
        execution_enabled:false,
        source:'SYSTEM',
        model:'quant-research',
        decision:{action:'SKIP',symbol:'',confidence:100,
          rationale:'Continuous research scan only. No orders submitted.'},
        stage:'RESEARCH_OBSERVATION',
        regime:stocks.value?.regime||null,
        candidates:topStocks,
        meta:{crypto_candidates:topCrypto.map(preview),
          news:articles,research_lenses:researchLenses,headlines_seen:headlineCount,generated_at,
          scan_errors:errors}
      });
    }catch(e){memory={configured:true,saved:false,reason:'Neon research write failed'}}
  }
  console.info('market_research_cycle',JSON.stringify({
    generated_at,stocks_scanned:Number(stocks.value?.deeply_analyzed||0),
    crypto_scanned:Number(crypto.value?.deeply_analyzed||0),
    headlines_seen:headlineCount,
    top_stocks:topStocks.slice(0,3).map(x=>x.symbol),
    top_crypto:topCrypto.slice(0,3).map(x=>x.symbol),
    memory_saved:Boolean(memory?.saved),error_categories:Object.keys(errors)
  }));
  res.setHeader('Cache-Control','no-store');
  return res.status(Object.keys(errors).length>=2?502:200).json({
    ok:stocks.status==='fulfilled'||crypto.status==='fulfilled',
    mode:'PAPER_RESEARCH',
    automatic_orders_submitted:0,
    generated_at,
    stocks:{ok:stocks.status==='fulfilled',deeply_analyzed:stocks.value?.deeply_analyzed??null,
      regime:stocks.value?.regime?.label||null,
      candidates:topStocks.map(preview)},
    crypto:{ok:crypto.status==='fulfilled',deeply_analyzed:crypto.value?.deeply_analyzed??null,
      candidates:topCrypto.map(preview)},
    headlines_seen:headlineCount,headlines:articles,research_lenses:researchLenses,
    memory_saved:Boolean(memory?.saved),storage_issue:memory?.reason||db.error||null,
    errors
  });
}
export default withCronTelemetry('research-cycle',handler);
