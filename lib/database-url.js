// Use the first valid configured PostgreSQL URL. Some Vercel Neon integrations
// introduce DATABASE_URL_UNPOOLED while an older DATABASE_URL remains invalid.
// Never log connection URLs or passwords.
const KEYS=['DATABASE_URL','POSTGRES_URL','POSTGRES_PRISMA_URL','NEON_DATABASE_URL','DATABASE_URL_UNPOOLED'];
const INVALID_HOSTS=new Set(['base','localhost','example.com','host','neon','database','placeholder']);

export function selectDatabaseUrl(env=process.env){
  const present=[];
  for(const key of KEYS){
    const raw=String(env[key]||'').trim();
    if(!raw)continue;
    present.push(key);
    try{
      const u=new URL(raw);
      const host=u.hostname.toLowerCase();
      if(!['postgres:','postgresql:'].includes(u.protocol))continue;
      if(!host||INVALID_HOSTS.has(host)||!u.username||!u.password||!u.pathname.slice(1))continue;
      return {value:raw,key,valid:true,configured:true,error:null};
    }catch{}
  }
  return {value:'',key:null,valid:false,configured:present.length>0,
    error:present.length
      ? 'No valid PostgreSQL connection URL found. Check DATABASE_URL and DATABASE_URL_UNPOOLED in Vercel Production.'
      : 'PostgreSQL environment variable not configured.'};
}

export function getDatabaseUrl(env=process.env){
  return selectDatabaseUrl(env).value;
}
