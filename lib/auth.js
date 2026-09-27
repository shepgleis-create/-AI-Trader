import crypto from 'node:crypto';

const COOKIE = 'ai_trader_session';
const MAX_AGE_SECONDS = 7 * 24 * 60 * 60;

// One-way verifier for the original dashboard secret.
// The actual secret is NOT stored in the repository.
const ORIGINAL_SECRET_SHA256 = 'ae72dd30b45107253065c76035dfad20c871b8c0200004d90a69039bc1ecc072';

function safeEqual(a,b){
  const aa=Buffer.from(String(a||''));
  const bb=Buffer.from(String(b||''));
  if(aa.length!==bb.length) return false;
  return crypto.timingSafeEqual(aa,bb);
}

function sha256(value){
  return crypto.createHash('sha256').update(String(value||'')).digest('hex');
}

function sessionSigningKey(){
  // Prefer the Vercel secret. If that environment variable is unavailable,
  // use the non-reversible verifier as the cookie signing key.
  return String(process.env.CRON_SECRET || ORIGINAL_SECRET_SHA256).trim();
}

function sign(payload,secret){
  return crypto.createHmac('sha256',secret).update(payload).digest('hex');
}

export function createSession(){
  const ts=String(Math.floor(Date.now()/1000));
  const key=sessionSigningKey();
  return `${ts}.${sign(ts,key)}`;
}

export function validateSession(token){
  if(!token) return false;
  const [ts,sig]=String(token).split('.');
  if(!ts||!sig) return false;
  const age=Math.floor(Date.now()/1000)-Number(ts);
  if(!Number.isFinite(age)||age<0||age>MAX_AGE_SECONDS) return false;
  return safeEqual(sig,sign(ts,sessionSigningKey()));
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
  return validateSession(readCookie(req,COOKIE));
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
  const submitted=String(input||'').trim();
  if(!submitted) return false;

  const envSecret=String(process.env.CRON_SECRET||'').trim();
  const envMatch=Boolean(envSecret)&&safeEqual(submitted,envSecret);

  const originalMatch=safeEqual(sha256(submitted),ORIGINAL_SECRET_SHA256);
  return envMatch||originalMatch;
}
