import { requireDashboardAuth } from '../lib/auth.js';
import { fetchBarsForSymbols, marketRiskMetrics, SECTOR_ETFS } from '../lib/strategy.js';

export default async function handler(req,res){
  if(!requireDashboardAuth(req,res)) return;
  if(req.method!=='GET') return res.status(405).json({error:'Method not allowed'});

  const key=process.env.ALPACA_API_KEY;
  const secret=process.env.ALPACA_SECRET_KEY;
  const baseUrl=process.env.ALPACA_BASE_URL||'https://paper-api.alpaca.markets';

  if(!key||!secret) return res.status(500).json({error:'Missing Alpaca credentials'});
  if(!baseUrl.includes('paper-api.alpaca.markets')) {
    return res.status(403).json({error:'Paper-only build'});
  }

  const headers={
    'APCA-API-KEY-ID':key,
    'APCA-API-SECRET-KEY':secret
  };

  try{
    const r=await fetch(`${baseUrl}/v2/positions`,{headers});
    const positions=await r.json();
    if(!r.ok) return res.status(r.status).json({error:positions?.message||'Could not load positions'});

    const rows=Array.isArray(positions)?positions:[];
    if(!rows.length){
      return res.status(200).json({
        positions:[],
        sectors:[],
        weighted_beta:null,
        note:'No open paper positions.'
      });
    }

    const symbols=[...new Set([...rows.map(p=>p.symbol),'SPY',...SECTOR_ETFS])];
    const bars=await fetchBarsForSymbols(symbols,key,secret,100);

    const details=rows.map(p=>{
      const metrics=marketRiskMetrics(bars[p.symbol]||[],bars);
      return{
        symbol:p.symbol,
        market_value:Number(p.market_value||0),
        unrealized_plpc:Number(p.unrealized_plpc||0),
        beta_60d:metrics.beta_60d,
        sector_proxy:metrics.sector_proxy,
        sector_correlation:metrics.sector_correlation
      };
    });

    const gross=details.reduce((s,p)=>s+Math.abs(p.market_value),0);
    const sectorMap={};
    for(const p of details){
      const key=p.sector_proxy||'UNKNOWN';
      sectorMap[key]=(sectorMap[key]||0)+Math.abs(p.market_value);
    }

    const sectors=Object.entries(sectorMap)
      .map(([sector,value])=>({
        sector_proxy:sector,
        market_value:value,
        exposure_pct:gross>0?value/gross:0
      }))
      .sort((a,b)=>b.market_value-a.market_value);

    const betaRows=details.filter(p=>Number.isFinite(Number(p.beta_60d)));
    const betaWeight=betaRows.reduce((s,p)=>s+Math.abs(p.market_value),0);
    const weightedBeta=betaWeight>0
      ? betaRows.reduce((s,p)=>s+Number(p.beta_60d)*Math.abs(p.market_value),0)/betaWeight
      : null;

    return res.status(200).json({
      positions:details,
      sectors,
      weighted_beta:weightedBeta,
      gross_position_value:gross
    });
  }catch(error){
    return res.status(500).json({error:error?.message||'Exposure map failed'});
  }
}
