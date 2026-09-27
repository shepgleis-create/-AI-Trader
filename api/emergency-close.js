import { requireDashboardAuth } from '../lib/auth.js';

export default async function handler(req,res){
  if(!requireDashboardAuth(req,res)) return;
  if(req.method!=='POST') return res.status(405).json({error:'Method not allowed'});

  const key=process.env.ALPACA_API_KEY;
  const secret=process.env.ALPACA_SECRET_KEY;
  const baseUrl=process.env.ALPACA_BASE_URL||'https://paper-api.alpaca.markets';

  if(!key||!secret) return res.status(500).json({error:'Missing Alpaca credentials'});
  if(!baseUrl.includes('paper-api.alpaca.markets')){
    return res.status(403).json({error:'Emergency close is hard-locked to paper trading.'});
  }

  const phrase=String(req.body?.confirm||'');
  if(phrase!=='CLOSE PAPER POSITIONS'){
    return res.status(400).json({error:'Confirmation phrase did not match.'});
  }

  const headers={
    'APCA-API-KEY-ID':key,
    'APCA-API-SECRET-KEY':secret,
    'Content-Type':'application/json'
  };

  try{
    const cancelRes=await fetch(`${baseUrl}/v2/orders`,{method:'DELETE',headers});
    const cancelBody=await cancelRes.json().catch(()=>[]);

    const closeRes=await fetch(`${baseUrl}/v2/positions`,{
      method:'DELETE',
      headers
    });
    const closeBody=await closeRes.json().catch(()=>[]);

    return res.status(200).json({
      ok:true,
      mode:'PAPER',
      orders_cancelled:cancelRes.ok,
      positions_close_requested:closeRes.ok,
      cancel_results:Array.isArray(cancelBody)?cancelBody.length:null,
      close_results:Array.isArray(closeBody)?closeBody.length:null,
      note:'This closes/cancels paper positions and orders only. AUTO_TRADING_ENABLED must remain false to prevent new automated entries.'
    });
  }catch(error){
    return res.status(500).json({error:error?.message||'Emergency paper close failed'});
  }
}
