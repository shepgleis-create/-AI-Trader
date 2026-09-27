import { createSession, setSessionCookie, verifySecret } from '../lib/auth.js';

export default async function handler(req,res){
  if(req.method!=='POST') return res.status(405).json({error:'Method not allowed'});
  const secret=String(req.body?.secret||'');
  if(!verifySecret(secret)) return res.status(401).json({error:'Invalid dashboard secret'});
  setSessionCookie(res,createSession(process.env.CRON_SECRET));
  return res.status(200).json({ok:true});
}
