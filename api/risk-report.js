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

    const [account,positionsRaw,ordersRaw,recentOrdersRaw,historyRaw]=await Promise.all([
      accountRes.json().catch(()=>({})),
      positionsRes.json().catch(()=>([])),
      ordersRes.json().catch(()=>([])),
      recentOrdersRes.json().catch(()=>([])),
      historyRes.json().catch(()=>({}))
    ]);

    const checks=[
      {name:'account',response:accountRes,body:account},
      {name:'positions',response:positionsRes,body:positionsRaw},
      {name:'open_orders',response:ordersRes,body:ordersRaw},
      {name:'recent_orders',response:recentOrdersRes,body:recentOrdersRaw}
    ].map(x=>({
      name:x.name,
      ok:x.response.ok,
      status:x.response.status,
      message:x.response.ok?null:String(x.body?.message||x.body?.error||x.response.statusText||'request failed').slice(0,180)
    }));
    const failed=checks.filter(x=>!x.ok);
    if(failed.length){
      return res.status(502).json({
        error:'Alpaca risk-report check failed — '+failed.map(x=>`${x.name} HTTP ${x.status}${x.message?': '+x.message:''}`).join(' · '),
        checks
      });
    }

    const historyAvailable=historyRes.ok;
    const historyWarning=historyAvailable?null:`portfolio_history HTTP ${historyRes.status}: ${String(historyRaw?.message||historyRaw?.error||historyRes.statusText||'request failed').slice(0,180)}`;
    const portfolioHistory=historyAvailable?historyRaw:{};

    const report=buildAccountRisk({
      account,
      positions:Array.isArray(positionsRaw)?positionsRaw:[],
      openOrders:Array.isArray(ordersRaw)?ordersRaw:[],
      recentOrders:Array.isArray(recentOrdersRaw)?recentOrdersRaw:[],
      portfolioHistory
    });
    report.history_available=historyAvailable;
    report.data_warnings=historyWarning?[historyWarning]:[];

    return res.status(200).json(report);
  }catch(error){
    return res.status(500).json({error:error?.message||'Account risk report failed'});
  }
}
