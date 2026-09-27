import { requireDashboardAuth } from '../lib/auth.js';
import { buildAccountRisk } from '../lib/account-risk.js';

export default async function handler(req,res){
  if(!requireDashboardAuth(req,res)) return;
  if(req.method!=='GET') return res.status(405).json({error:'Method not allowed'});

  const key=process.env.ALPACA_API_KEY;
  const secret=process.env.ALPACA_SECRET_KEY;
  const baseUrl=process.env.ALPACA_BASE_URL||'https://paper-api.alpaca.markets';

  if(!key||!secret) return res.status(500).json({error:'Missing Alpaca credentials'});
  if(!baseUrl.includes('paper-api.alpaca.markets')){
    return res.status(403).json({error:'Paper-only build'});
  }

  const headers={
    'APCA-API-KEY-ID':key,
    'APCA-API-SECRET-KEY':secret
  };

  try{
    const historyUrl=new URL(`${baseUrl}/v2/account/portfolio/history`);
    historyUrl.searchParams.set('period','1M');
    historyUrl.searchParams.set('timeframe','1D');

    const [accountRes,positionsRes,ordersRes,recentOrdersRes,historyRes]=await Promise.all([
      fetch(`${baseUrl}/v2/account`,{headers}),
      fetch(`${baseUrl}/v2/positions`,{headers}),
      fetch(`${baseUrl}/v2/orders?status=open&limit=100&nested=true`,{headers}),
      fetch(`${baseUrl}/v2/orders?status=all&limit=500&direction=desc&nested=true`,{headers}),
      fetch(historyUrl,{headers})
    ]);

    const [account,positionsRaw,ordersRaw,recentOrdersRaw,portfolioHistory]=await Promise.all([
      accountRes.json(),positionsRes.json(),ordersRes.json(),recentOrdersRes.json(),historyRes.json()
    ]);

    if(!accountRes.ok||!positionsRes.ok||!ordersRes.ok||!recentOrdersRes.ok||!historyRes.ok){
      return res.status(502).json({error:'Could not build account risk report'});
    }

    const report=buildAccountRisk({
      account,
      positions:Array.isArray(positionsRaw)?positionsRaw:[],
      openOrders:Array.isArray(ordersRaw)?ordersRaw:[],
      recentOrders:Array.isArray(recentOrdersRaw)?recentOrdersRaw:[],
      portfolioHistory
    });

    return res.status(200).json(report);
  }catch(error){
    return res.status(500).json({error:error?.message||'Account risk report failed'});
  }
}
