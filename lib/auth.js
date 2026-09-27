import crypto from 'crypto';

const COOKIE = 'ai_trader_session';
const MAX_AGE_SECONDS = 7 * 24 * 60 * 60;

function safeEqual(a,b){
  const aa=Buffer.from(String(a||''));
  const bb=Buffer.from(String(b||''));
  if(aa.length!==bb.length) return false;
  return crypto.timingSafeEqual(aa,bb);
}

function sign(payload,secret){
  return crypto.createHmac('sha256',secret).update(payload).digest('hex');
}

export function createSession(secret){
  const ts=String(Math.floor(Date.now()/1000));
  return `${ts}.${sign(ts,secret)}`;
}

export function validateSession(token,secret){
  if(!token||!secret) return false;
  const [ts,sig]=String(token).split('.');
  if(!ts||!sig) return false;
  const age=Math.floor(Date.now()/1000)-Number(ts);
  if(!Number.isFinite(age)||age<0||age>MAX_AGE_SECONDS) return false;
  return safeEqual(sig,sign(ts,secret));
}

export function readCookie(req,name){
  const raw=String(req.headers?.cookie||'');
  for(const part of raw.split(';')){
    const [k,...rest]=part.trim().split('=');
    if(k===name) return decodeURIComponent(rest.join('='));
  }
  return null;
}

export function isDashboardAuthorized(req){
  const secret=process.env.CRON_SECRET;
  if(!secret) return false;
  return validateSession(readCookie(req,COOKIE),secret);
}

export function requireDashboardAuth(req,res){
  if(isDashboardAuthorized(req)) return true;
  res.status(401).json({error:'Dashboard login required'});
  return false;
}

export function setSessionCookie(res,token){
  res.setHeader('Set-Cookie',`${COOKIE}=${encodeURIComponent(token)}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${MAX_AGE_SECONDS}`);
}

export function clearSessionCookie(res){
  res.setHeader('Set-Cookie',`${COOKIE}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`);
}

export function verifySecret(input){
  const secret=process.env.CRON_SECRET;
  return Boolean(secret)&&safeEqual(input,secret);
}
