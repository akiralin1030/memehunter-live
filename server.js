const http = require("http");

const PORT = process.env.PORT || 10000;

const page = `<!doctype html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>MemeHunter Live</title>
<style>
body{margin:0;background:#080b0e;color:#eee;font-family:Arial,sans-serif}
.wrap{max-width:1400px;margin:auto;padding:18px}
.top{display:flex;gap:12px;align-items:center;flex-wrap:wrap}
h1{font-size:22px}.tag{color:#35e78a;border:1px solid #17623c;padding:5px 9px;border-radius:20px;font-size:12px}
button{background:#172028;color:white;border:1px solid #33404a;padding:8px 13px;border-radius:8px;cursor:pointer}
.green{color:#35e78a}.red{color:#ff6776}
.grid{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-top:15px}
.card{background:#10161c;border:1px solid #26313a;border-radius:10px;padding:14px}
.label{font-size:11px;color:#8da0af}.value{font-size:23px;font-weight:bold;margin-top:5px}
table{width:100%;border-collapse:collapse;font-size:12px}
th,td{padding:8px;border-bottom:1px solid #202831;text-align:left}
th{color:#8da0af}
.panel{margin-top:14px;background:#10161c;border:1px solid #26313a;border-radius:10px;padding:14px}
.err{display:none;background:#2a1116;border:1px solid #69303a;color:#ff9ca5;padding:10px;border-radius:8px;margin-top:12px}
.good{color:#35e78a}.bad{color:#ff6776}.watch{color:#f4bd58}
@media(max-width:800px){.grid{grid-template-columns:repeat(2,1fr)}}
</style>
</head>
<body>
<div class="wrap">
<div class="top">
<h1>MemeHunter Live</h1>
<span class="tag">LIVE DATA • PAPER MONEY</span>
<span id="status" class="green">● RUNNING</span>
<button onclick="scan()">Scan Now</button>
<button onclick="reset()">Reset 10,000U</button>
</div>

<div id="err" class="err"></div>

<div class="grid">
<div class="card"><div class="label">EQUITY</div><div id="equity" class="value">10,000.00 U</div></div>
<div class="card"><div class="label">CASH</div><div id="cash" class="value">10,000.00 U</div></div>
<div class="card"><div class="label">TOTAL PNL</div><div id="pnl" class="value">0.00 U</div></div>
<div class="card"><div class="label">OPEN POSITIONS</div><div id="open" class="value">0</div></div>
</div>

<div class="panel">
<h3>Live Hunter Feed</h3>
<div style="overflow:auto">
<table>
<thead>
<tr>
<th>Token</th><th>Age</th><th>Price</th><th>Liquidity</th>
<th>Vol 5m</th><th>Vol 1h</th><th>B/S</th><th>5m%</th><th>Score</th><th>Decision</th>
</tr>
</thead>
<tbody id="feed"></tbody>
</table>
</div>
</div>

<div class="panel">
<h3>目前持倉</h3>
<table>
<thead><tr><th>Token</th><th>Entry</th><th>Now</th><th>Value</th><th>PnL</th></tr></thead>
<tbody id="positions"></tbody>
</table>
</div>

<div class="panel">
<h3>交易紀錄</h3>
<table>
<thead><tr><th>Time</th><th>Token</th><th>Action</th><th>Amount</th><th>PnL</th><th>Reason</th></tr></thead>
<tbody id="trades"></tbody>
</table>
</div>
</div>

<script>
const KEY="memehunter_render_v1";
let state=JSON.parse(localStorage.getItem(KEY)||"null")||{
 cash:10000,
 positions:{},
 trades:[]
};

let universe=[];

function save(){localStorage.setItem(KEY,JSON.stringify(state))}
function n(v){return Number(v||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}

function age(t){
 const m=(Date.now()-t)/60000;
 if(m<60)return Math.max(0,Math.floor(m))+"m";
 if(m<1440)return (m/60).toFixed(1)+"h";
 return (m/1440).toFixed(1)+"d";
}

async function api(path){
 const r=await fetch("/api?path="+encodeURIComponent(path));
 if(!r.ok)throw new Error("HTTP "+r.status);
 return r.json();
}

function normalize(doc){
 const meta=new Map();
 for(const x of (doc.included||[])){
  meta.set(x.id,x.attributes||{});
 }

 return (doc.data||[]).map(x=>{
  const a=x.attributes||{};
  const rel=x.relationships||{};
  const b=meta.get(rel.base_token?.data?.id)||{};
  const tx=a.transactions||{};
  const v=a.volume_usd||{};
  const pc=a.price_change_percentage||{};

  return {
   pool:a.address,
   symbol:b.symbol||a.name?.split("/")[0]||"?",
   address:b.address||"",
   price:+a.base_token_price_usd||0,
   liq:+a.reserve_in_usd||0,
   v5:+v.m5||0,
   v1:+v.h1||0,
   buys:+tx.m5?.buys||0,
   sells:+tx.m5?.sells||0,
   pc5:+pc.m5||0,
   pc1:+pc.h1||0,
   created:a.pool_created_at?new Date(a.pool_created_at).getTime():Date.now()
  }
 });
}

function score(p){
 let s=0;
 s+=Math.min(25,p.liq/4000);
 s+=Math.min(20,p.v1/5000);
 s+=Math.min(20,p.v5/1200);
 s+=Math.min(15,(p.buys/Math.max(1,p.sells))*7);
 if(p.pc5>0&&p.pc5<35)s+=10;
 if(p.pc1>0&&p.pc1<120)s+=10;
 return Math.round(Math.min(100,s));
}

function decision(p){
 const sc=score(p);
 const mins=(Date.now()-p.created)/60000;

 if(p.liq<30000)return ["REJECT",sc];
 if(p.v1<8000)return ["REJECT",sc];
 if(p.buys+p.sells<10)return ["REJECT",sc];
 if(mins<3)return ["REJECT",sc];
 if(p.pc5>40||p.pc1>150)return ["WATCH",sc];
 if(sc>=62 && p.buys/Math.max(1,p.sells)>=1.1 && p.liq>=50000)return ["BUY",sc];
 return ["WATCH",sc];
}

function equity(){
 let value=0;
 for(const p of Object.values(state.positions)){
  const market=universe.find(x=>x.address===p.address);
  const px=market?.price||p.last||p.entry;
  value+=p.qty*px;
 }
 return state.cash+value;
}

function manage(){
 for(const [addr,pos] of Object.entries({...state.positions})){
  const p=universe.find(x=>x.address===addr);
  if(!p)continue;

  pos.last=p.price;
  pos.high=Math.max(pos.high||pos.entry,p.price);
  const ret=p.price/pos.entry-1;

  let reason=null;

  if(ret<=-0.10)reason="Stop -10%";
  else if(ret>=0.30)reason="TP +30%";
  else if(Date.now()-pos.time>120*60*1000)reason="Time stop";

  if(reason){
   const gross=pos.qty*p.price;
   const fee=gross*0.005;
   const pnl=gross-fee-(pos.qty*pos.entry);
   state.cash+=gross-fee;
   state.trades.unshift({
    time:Date.now(),symbol:pos.symbol,action:"SELL",
    amount:gross,pnl,reason
   });
   delete state.positions[addr];
  }
 }
}

function entries(){
 const eq=equity();

 if(Object.keys(state.positions).length>=4)return;

 const picks=universe
 .map(p=>({p,d:decision(p)}))
 .filter(x=>x.d[0]==="BUY")
 .sort((a,b)=>b.d[1]-a.d[1]);

 for(const x of picks){
  if(Object.keys(state.positions).length>=4)break;

  const p=x.p;
  if(state.positions[p.address])continue;

  const size=Math.min(eq*0.05,600);
  if(state.cash<size*1.005)continue;

  const fee=size*0.005;
  state.cash-=size+fee;

  state.positions[p.address]={
   address:p.address,
   symbol:p.symbol,
   entry:p.price,
   last:p.price,
   high:p.price,
   qty:size/p.price,
   time:Date.now()
  };

  state.trades.unshift({
   time:Date.now(),symbol:p.symbol,action:"BUY",
   amount:size,pnl:-fee,reason:"Score "+x.d[1]
  });
 }
}

async function scan(){
 document.getElementById("err").style.display="none";

 try{
  const [a,b]=await Promise.all([
   api("/networks/solana/new_pools?include=base_token,quote_token&page=1"),
   api("/networks/solana/trending_pools?include=base_token,quote_token&page=1")
  ]);

  const all=[...normalize(a),...normalize(b)];
  const map=new Map();

  for(const p of all){
   if(!p.address)continue;
   const old=map.get(p.address);
   if(!old||p.liq>old.liq)map.set(p.address,p);
  }

  universe=[...map.values()];
  manage();
  entries();
  save();
  render();

 }catch(e){
  const box=document.getElementById("err");
  box.style.display="block";
  box.textContent="行情抓取失敗："+e.message;
 }
}

function render(){
 const eq=equity();
 document.getElementById("equity").textContent=n(eq)+" U";
 document.getElementById("cash").textContent=n(state.cash)+" U";
 document.getElementById("pnl").textContent=(eq-10000>=0?"+":"")+n(eq-10000)+" U";
 document.getElementById("open").textContent=Object.keys(state.positions).length;

 const rows=universe
  .map(p=>({p,d:decision(p)}))
  .sort((a,b)=>b.d[1]-a.d[1])
  .slice(0,40);

 document.getElementById("feed").innerHTML=rows.map(x=>{
  const p=x.p,d=x.d;
  return \`<tr>
  <td>\${p.symbol}</td>
  <td>\${age(p.created)}</td>
  <td>$\${p.price.toPrecision(4)}</td>
  <td>$\${Math.round(p.liq/1000)}k</td>
  <td>$\${(p.v5/1000).toFixed(1)}k</td>
  <td>$\${(p.v1/1000).toFixed(1)}k</td>
  <td>\${p.buys}/\${p.sells}</td>
  <td>\${p.pc5.toFixed(1)}%</td>
  <td>\${d[1]}</td>
  <td class="\${d[0]==="BUY"?"good":d[0]==="REJECT"?"bad":"watch"}">\${d[0]}</td>
  </tr>\`;
 }).join("");

 document.getElementById("positions").innerHTML=
 Object.values(state.positions).map(p=>{
  const market=universe.find(x=>x.address===p.address);
  const px=market?.price||p.last||p.entry;
  const value=p.qty*px;
  const pnl=value-p.qty*p.entry;

  return \`<tr>
  <td>\${p.symbol}</td>
  <td>$\${p.entry.toPrecision(4)}</td>
  <td>$\${px.toPrecision(4)}</td>
  <td>\${n(value)} U</td>
  <td class="\${pnl>=0?"good":"bad"}">\${pnl>=0?"+":""}\${n(pnl)} U</td>
  </tr>\`;
 }).join("") || "<tr><td colspan='5'>目前沒有持倉</td></tr>";

 document.getElementById("trades").innerHTML=
 state.trades.slice(0,100).map(t=>\`<tr>
 <td>\${new Date(t.time).toLocaleString()}</td>
 <td>\${t.symbol}</td>
 <td>\${t.action}</td>
 <td>\${n(t.amount)} U</td>
 <td class="\${t.pnl>=0?"good":"bad"}">\${t.pnl>=0?"+":""}\${n(t.pnl)} U</td>
 <td>\${t.reason}</td>
 </tr>\`).join("") || "<tr><td colspan='6'>尚無交易</td></tr>";
}

function reset(){
 if(confirm("確定重新從 10,000U 開始？")){
  state={cash:10000,positions:{},trades:[]};
  save();
  render();
 }
}

render();
scan();
setInterval(scan,90000);
</script>
</body></html>`;

http.createServer(async (req,res)=>{
 try{
  const url=new URL(req.url,"http://localhost");

  if(url.pathname==="/api"){
   const path=url.searchParams.get("path")||"";

   if(!path.startsWith("/")){
    res.writeHead(400,{"content-type":"application/json"});
    return res.end("{}");
   }

   const r=await fetch("https://api.geckoterminal.com/api/v2"+path,{
    headers:{"accept":"application/json"}
   });

   const body=await r.text();

   res.writeHead(r.status,{
    "content-type":r.headers.get("content-type")||"application/json",
    "cache-control":"no-store"
   });

   return res.end(body);
  }

  res.writeHead(200,{
   "content-type":"text/html; charset=utf-8",
   "cache-control":"no-store"
  });

  res.end(page);

 }catch(e){
  res.writeHead(500,{"content-type":"text/plain"});
  res.end(String(e));
 }
}).listen(PORT,"0.0.0.0",()=>{
 console.log("MemeHunter running on",PORT);
});
