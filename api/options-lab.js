import { requireDashboardAuth } from '../lib/auth.js';
import { fetchOptionsForUnderlying } from '../lib/multi-asset.js';

export default async function handler(req,res){
  if(!requireDashboardAuth(req,res))return;
  if(req.method!=='GET')return res.status(405).json({error:'Method not allowed'});
  const key=process.env.ALPACA_API_KEY;
  const secret=process.env.ALPACA_SECRET_KEY;
  const base=process.env.ALPACA_BASE_URL||'https://paper-api.alpaca.markets';
  if(!key||!secret)return res.status(500).json({error:'Missing Alpaca credentials'});
  if(!base.includes('paper-api.alpaca.markets'))return res.status(403).json({error:'Paper-only build'});

  const symbol=String(req.query?.symbol||'').trim().toUpperCase();
  const direction=String(req.query?.direction||'BULLISH').toUpperCase()==='BEARISH'?'BEARISH':'BULLISH';
  const price=Number(req.query?.price||0);
  if(!/^[A-Z.]{1,12}$/.test(symbol))return res.status(400).json({error:'Valid underlying symbol required'});
  if(!(price>0))return res.status(400).json({error:'Current underlying price required'});

  try{
    const chain=await fetchOptionsForUnderlying(symbol,direction,key,secret,price);
    return res.status(200).json({
      underlying:symbol,
      underlying_price:price,
      direction,
      option_type:direction==='BEARISH'?'put':'call',
      execution_enabled:false,
      research_only:true,
      ...chain
    });
  }catch(error){
    return res.status(500).json({error:error?.message||'Options Lab failed'});
  }
}
