import { createSession, setSessionCookie, verifySecret } from '../lib/auth.js';

export default async function handler(req,res){
  if(req.method!=='POST') return res.status(405).json({error:'Method not allowed'});

  const headerSecret=String(req.headers?.['x-dashboard-secret']||'').trim();
  const bodySecret=String(req.body?.secret||'').trim();
  const submitted=headerSecret||bodySecret;

  if(!submitted){
    return res.status(400).json({error:'No dashboard secret was received by the server'});
  }
  if(!verifySecret(submitted)){
    return res.status(401).json({error:'Dashboard secret did not match'});
  }

  const session=createSession();
  setSessionCookie(res,session);

  return res.status(200).json({
    ok:true,
    session,
    message:'Dashboard unlocked'
  });
}
