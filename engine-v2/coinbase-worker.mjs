import http from 'node:http';
import {pathToFileURL} from 'node:url';
import {RollingCoinRadar,normalizeCoinbaseTicker} from './stream-core.mjs';

// Read-only public Coinbase Exchange market-data connection.
// No private keys are read. NO orders can be submitted by this process.
const MARKET_URL='wss://ws-feed.exchange.coinbase.com';
const PRODUCTS_URL='https://api.exchange.coinbase.com/products';
const defaultPairs=['BTC-USD','ETH-USD','SOL-USD','DOGE-USD','PEPE-USD','SHIB-USD'];
const n=(input,fallback,min,max)=>{
 const value=Number(input);return Number.isFinite(value)?Math.max(min,Math.min(max,Math.floor(value))):fallback;
};
export function eligibleUsdProducts(products=[],maximum=150){
 const list=(Array.isArray(products)?products:[]).filter(p=>
  p?.quote_currency==='USD'&&!p.trading_disabled&&
  !p.cancel_only&&!p.limit_only&&p.status==='online'&&
  /^[A-Z0-9]{1,20}-USD$/.test(String(p.id||''))
 ).map(p=>p.id);
 const preferred=defaultPairs.filter(p=>list.includes(p));
 return [...new Set([...preferred,...list.sort()])].slice(0,maximum);
}
export function createSubscription(pairs=[]){
 return {type:'subscribe',product_ids:pairs,channels:['ticker_batch']};
}
export async function getResearchPairs({fetchImpl=fetch,env=process.env}={}){
 const explicit=String(env.WATCH_PAIRS||'').split(',')
  .map(p=>p.trim().toUpperCase()).filter(p=>/^[A-Z0-9]{1,20}-USD$/.test(p));
 if(explicit.length)return [...new Set(explicit)].slice(0,n(env.MAX_PAIRS,150,2,500));
 const response=await fetchImpl(PRODUCTS_URL,{
  headers:{'Accept':'application/json','User-Agent':'AI-Trader-V2-Research'},
  signal:AbortSignal.timeout(10000)
 });
 if(!response.ok)throw Error('Coinbase public products HTTP '+response.status);
 const products=await response.json();
 const pairs=eligibleUsdProducts(products,n(env.MAX_PAIRS,150,2,500));
 if(!pairs.length)throw Error('No valid USD Coinbase Exchange pairs found');
 return pairs;
}
export async function startResearchWorker({
 env=process.env,WebSocketImpl=globalThis.WebSocket,fetchImpl=fetch,
 log=entry=>console.log(JSON.stringify(entry))
}={}){
 if(typeof WebSocketImpl!=='function')throw Error('This research worker requires Node.js 22+ WebSocket support');
 if(env.TRADING_MODE&&env.TRADING_MODE!=='RESEARCH_ONLY')
  throw Error('V2 streaming worker is deliberately RESEARCH_ONLY');
 const radar=new RollingCoinRadar({
  minMovePct:Number(env.MIN_WATCH_MOVE_PCT||1.5),
  minDollarTurnover:Number(env.MIN_OBSERVED_TURNOVER_USD||300)
 });
 let connected=false,stopping=false,socket=null,lastMessageAt=null,
   lastConnectedAt=null,reconnectCount=0,reconnectTimer=null;
 const recentSignals=[],maxSignals=100;
 const host=env.HEALTH_HOST||'127.0.0.1';
 const port=n(env.HEALTH_PORT,8787,1024,65535);
 const healthServer=http.createServer((req,res)=>{
  res.setHeader('Cache-Control','no-store');
  res.setHeader('Content-Type','application/json');
  const pathname=String(req.url||'').split('?')[0];
  if(req.method!=='GET'||!['/health','/signals'].includes(pathname)){
   res.statusCode=404;res.end(JSON.stringify({error:'Not found'}));return;
  }
  if(pathname==='/signals'){
   res.end(JSON.stringify({mode:'RESEARCH_ONLY',
     signals:recentSignals.slice(-40).reverse()}));return;
  }
  // /health is deliberately not a remote management or execution endpoint.
  res.end(JSON.stringify({service:'ai-trader-v2-coinbase-research',
   mode:'RESEARCH_ONLY',provider:'COINBASE_EXCHANGE_PUBLIC',connected,
   pairs:currentPairs.length,last_message_at:lastMessageAt,
   connected_at:lastConnectedAt,reconnections:reconnectCount,
   ...radar.snapshot()}));
 });
 const currentPairs=await getResearchPairs({fetchImpl,env});
 const ready=await new Promise((resolve,reject)=>{
  healthServer.once('error',reject);
  healthServer.listen(port,host,()=>resolve({host,port}));
 });
 log({event:'worker_started',mode:'RESEARCH_ONLY',
  provider:'COINBASE_EXCHANGE_PUBLIC',endpoint:ready,pairs:currentPairs.length});
 function scheduleReconnect(){
  if(stopping||reconnectTimer)return;
  reconnectCount++;
  const delay=Math.min(45000,1500*Math.pow(1.6,Math.min(reconnectCount,7)));
  reconnectTimer=setTimeout(()=>{reconnectTimer=null;connect()},delay);
 }
 function connect(){
  if(stopping)return;
  try{socket=new WebSocketImpl(MARKET_URL)}
  catch(e){log({event:'socket_construct_failed',reason:String(e?.message||e).slice(0,150)});scheduleReconnect();return}
  socket.addEventListener('open',()=>{
   connected=true;lastConnectedAt=new Date().toISOString();
   reconnectCount=0;
   socket.send(JSON.stringify(createSubscription(currentPairs)));
   log({event:'feed_connected',pairs:currentPairs.length,
     note:'Read-only venue feed, NOT consolidated crypto market'});
  });
  socket.addEventListener('message',e=>{
   lastMessageAt=new Date().toISOString();
   let msg;try{msg=JSON.parse(String(e.data))}catch{return}
   const tick=normalizeCoinbaseTicker(msg);
   if(!tick)return;
   const result=radar.ingest(tick);
   if(result.signal){
    recentSignals.push(result.signal);
    while(recentSignals.length>maxSignals)recentSignals.shift();
    log({event:'watch_alert',...result.signal});
   }
  });
  socket.addEventListener('error',e=>log({event:'socket_error',
   detail:'WebSocket error (no credentials or orders in this worker)'}));
  socket.addEventListener('close',()=>{
   connected=false;socket=null;
   log({event:'feed_disconnected'});
   scheduleReconnect();
  });
 }
 connect();
 const watchdog=setInterval(()=>{
  if(stopping)return;
  const heartbeat=lastMessageAt||lastConnectedAt;
  if(connected&&heartbeat&&Date.now()-Date.parse(heartbeat)>120000){
   log({event:'feed_stale',seconds_since_message:Math.round((Date.now()-Date.parse(heartbeat))/1000)});
   try{socket?.close()}catch{}
  }
 },20000);
 const shutdown=async()=>{
  if(stopping)return;
  stopping=true;clearInterval(watchdog);clearTimeout(reconnectTimer);
  try{socket?.close()}catch{}
  await new Promise(resolve=>healthServer.close(resolve));
  log({event:'worker_stopped'});
 };
 return {shutdown,radar,getState:()=>({connected,pairs:currentPairs.length})};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 startResearchWorker().catch(e=>{
  console.error(JSON.stringify({event:'fatal',reason:String(e?.message||e)}));
  process.exitCode=1;
 });
}
