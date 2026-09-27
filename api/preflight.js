import { requireDashboardAuth } from '../lib/auth.js';

export default async function handler(req,res){
  if(!requireDashboardAuth(req,res)) return;
  if(req.method!=='GET') return res.status(405).json({error:'Method not allowed'});

  const key=process.env.ALPACA_API_KEY;
  const secret=process.env.ALPACA_SECRET_KEY;
  const gemini=process.env.GEMINI_API_KEY;
  const cron=process.env.CRON_SECRET;
  const baseUrl=process.env.ALPACA_BASE_URL||'https://paper-api.alpaca.markets';
  const auto=String(process.env.AUTO_TRADING_ENABLED||'').toLowerCase()==='true';

  const checks={
    alpaca_key:Boolean(key),
    alpaca_secret:Boolean(secret),
    gemini_key:Boolean(gemini),
    cron_secret:Boolean(cron),
    paper_endpoint:baseUrl.includes('paper-api.alpaca.markets'),
    auto_trading_enabled:auto
  };

  let alpaca={ok:false,error:null,status:null,market_open:null};
  if(key&&secret&&checks.paper_endpoint){
    const headers={'APCA-API-KEY-ID':key,'APCA-API-SECRET-KEY':secret};
    try{
      const [ar,cr]=await Promise.all([
        fetch(`${baseUrl}/v2/account`,{headers}),
        fetch(`${baseUrl}/v2/clock`,{headers})
      ]);
      const [a,c]=await Promise.all([ar.json(),cr.json()]);
      alpaca={
        ok:ar.ok&&cr.ok,
        error:ar.ok&&cr.ok?null:(a?.message||c?.message||'Alpaca check failed'),
        status:a?.status||null,
        market_open:Boolean(c?.is_open)
      };
    }catch(e){
      alpaca={ok:false,error:e?.message||'Alpaca unreachable',status:null,market_open:null};
    }
  }

  return res.status(200).json({
    ok:Object.entries(checks).filter(([k])=>k!=='auto_trading_enabled').every(([,v])=>Boolean(v))&&alpaca.ok,
    environment:process.env.VERCEL_ENV||null,
    commit:process.env.VERCEL_GIT_COMMIT_SHA||null,
    checks,
    alpaca,
    note:auto
      ? 'Automatic paper execution is ON.'
      : 'Automatic paper execution is OFF; decisions remain dry-run/manual.'
  });
}
