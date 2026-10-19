// Reserve a portion of deep research for liquid early movers. Discovery is
// broad; autonomous execution still applies entry, spread, regime and account risk.
export function selectDeepResearchUniverse(rows=[],limit=300){
  const cap=Math.max(20,Math.min(600,Math.floor(Number(limit)||300)));
  const liquid=[...(Array.isArray(rows)?rows:[])].filter(x=>
    x&&typeof x.symbol==='string'&&Number(x.price)>=3&&
    Number(x.dollarVolume)>=1_000_000
  ).sort((a,b)=>{
    const aScore=Math.log10(Math.max(1,Number(a.dollarVolume)))+
      Math.min(.5,Math.abs(Number(a.dayChange||0))*5);
    const bScore=Math.log10(Math.max(1,Number(b.dollarVolume)))+
      Math.min(.5,Math.abs(Number(b.dayChange||0))*5);
    return bScore-aScore;
  });
  const basic=Math.floor(cap*.78);
  const seen=new Set(),selected=[];
  function add(x){if(x&&!seen.has(x.symbol)){seen.add(x.symbol);selected.push(x)}}
  liquid.slice(0,basic).forEach(add);
  const early=liquid.filter(x=>
    Number(x.dayChange)>=.025&&Number(x.dayChange)<=.30&&
    Number(x.moveFromOpenPct)>=.005&&
    Number(x.dollarVolume)>=1_000_000&&
    Number(x.spreadPct)>=0&&Number(x.spreadPct)<=.006&&
    Number(x.data_age_seconds)>=0&&Number(x.data_age_seconds)<=300
  ).sort((a,b)=>
    Number(b.moveFromOpenPct)-Number(a.moveFromOpenPct)||
    Number(b.dollarVolume)-Number(a.dollarVolume)
  );
  early.forEach(x=>{if(selected.length<cap)add(x)});
  for(const x of liquid){if(selected.length>=cap)break;add(x)}
  return selected;
}
