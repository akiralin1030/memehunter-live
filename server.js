const http = require("http");

const PORT = process.env.PORT || 10000;

let marketCache = {
  time: 0,
  data: null
};

const CACHE_MS = 60 * 1000;

// ==============================
// DEX SCREENER MARKET DATA
// ==============================

async function fetchJson(url) {
  const r = await fetch(url, {
    headers: {
      Accept: "application/json",
      "User-Agent": "MemeHunter-Paper-Trader/1.0"
    }
  });

  if (!r.ok) {
    throw new Error(`DEX Screener HTTP ${r.status}`);
  }

  return r.json();
}

async function getMarketData() {
  if (
    marketCache.data &&
    Date.now() - marketCache.time < CACHE_MS
  ) {
    return marketCache.data;
  }

  const [profiles, boosts] = await Promise.all([
    fetchJson(
      "https://api.dexscreener.com/token-profiles/latest/v1"
    ),
    fetchJson(
      "https://api.dexscreener.com/token-boosts/top/v1"
    )
  ]);

  const addresses = [
    ...new Set(
      [...(profiles || []), ...(boosts || [])]
        .filter(x => x.chainId === "solana")
        .map(x => x.tokenAddress)
        .filter(Boolean)
    )
  ].slice(0, 60);

  let rawPairs = [];

  for (let i = 0; i < addresses.length; i += 30) {
    const batch = addresses.slice(i, i + 30);

    try {
      const data = await fetchJson(
        "https://api.dexscreener.com/tokens/v1/solana/" +
        batch.join(",")
      );

      if (Array.isArray(data)) {
        rawPairs.push(...data);
      }
    } catch (e) {
      console.log("DEX batch error:", e.message);
    }
  }

  // 每個 token 只留流動性最大的交易池
  const best = new Map();

  for (const p of rawPairs) {
    if (
      p.chainId !== "solana" ||
      !p.baseToken?.address ||
      !p.priceUsd
    ) {
      continue;
    }

    const address = p.baseToken.address;
    const old = best.get(address);

    if (
      !old ||
      Number(p.liquidity?.usd || 0) >
      Number(old.liquidity?.usd || 0)
    ) {
      best.set(address, p);
    }
  }

  const rows = [...best.values()].map(p => ({
    address: p.baseToken.address,
    pairAddress: p.pairAddress,

    symbol:
      p.baseToken?.symbol || "?",

    name:
      p.baseToken?.name ||
      p.baseToken?.symbol ||
      "?",

    price:
      Number(p.priceUsd || 0),

    liquidity:
      Number(p.liquidity?.usd || 0),

    volume5m:
      Number(p.volume?.m5 || 0),

    volume1h:
      Number(p.volume?.h1 || 0),

    buys5m:
      Number(p.txns?.m5?.buys || 0),

    sells5m:
      Number(p.txns?.m5?.sells || 0),

    price5m:
      Number(p.priceChange?.m5 || 0),

    price1h:
      Number(p.priceChange?.h1 || 0),

    createdAt:
      Number(p.pairCreatedAt || Date.now()),

    url:
      p.url ||
      `https://dexscreener.com/solana/${p.pairAddress}`
  }));

  marketCache = {
    time: Date.now(),
    data: rows
  };

  return rows;
}

// ==============================
// FRONTEND
// ==============================

const PAGE = String.raw`
<!doctype html>
<html lang="zh-Hant">

<head>
<meta charset="utf-8">
<meta
  name="viewport"
  content="width=device-width,initial-scale=1"
>

<title>MemeHunter Live</title>

<style>

*{
  box-sizing:border-box
}

body{
  margin:0;
  background:#080b0e;
  color:#edf3f7;
  font-family:
    system-ui,
    -apple-system,
    "Segoe UI",
    "Noto Sans TC",
    sans-serif
}

.wrap{
  max-width:1450px;
  margin:auto;
  padding:18px
}

.top{
  display:flex;
  gap:12px;
  align-items:center;
  flex-wrap:wrap
}

h1{
  margin:0;
  font-size:23px
}

.badge{
  color:#31e986;
  border:1px solid #17643d;
  background:#0b2518;
  padding:5px 9px;
  border-radius:99px;
  font-size:11px
}

.status{
  color:#31e986
}

button{
  padding:9px 14px;
  border-radius:8px;
  border:1px solid #33404a;
  background:#162029;
  color:#fff;
  cursor:pointer
}

button:hover{
  border-color:#60717e
}

.note{
  margin-top:14px;
  background:#0f151b;
  border:1px solid #27323b;
  border-radius:9px;
  padding:11px 13px;
  color:#9cabb7;
  font-size:12px
}

.error{
  display:none;
  margin-top:12px;
  background:#2b1116;
  border:1px solid #6d3038;
  color:#ff98a3;
  padding:11px;
  border-radius:8px
}

.grid{
  display:grid;
  gap:12px
}

.kpis{
  grid-template-columns:
    repeat(8,minmax(120px,1fr));
  margin-top:14px
}

.card{
  background:#10161c;
  border:1px solid #26313a;
  border-radius:10px;
  padding:14px
}

.label{
  color:#8ca0af;
  font-size:11px
}

.value{
  margin-top:5px;
  font-size:21px;
  font-weight:800
}

.green{
  color:#31e986
}

.red{
  color:#ff6877
}

.yellow{
  color:#f2bc59
}

.panel{
  margin-top:14px;
  background:#10161c;
  border:1px solid #26313a;
  border-radius:10px;
  padding:14px
}

.panel-title{
  display:flex;
  justify-content:space-between;
  align-items:center;
  gap:10px
}

.panel-title h2{
  margin:0;
  font-size:16px
}

.small{
  font-size:11px;
  color:#8999a6
}

table{
  width:100%;
  border-collapse:collapse;
  font-size:12px
}

th,
td{
  text-align:left;
  padding:9px;
  border-bottom:1px solid #202a32;
  white-space:nowrap
}

th{
  color:#8ca0af
}

.scroll{
  overflow:auto;
  max-height:470px
}

a{
  color:#8fcaff;
  text-decoration:none
}

.two{
  grid-template-columns:1.3fr .7fr
}

.stats{
  display:grid;
  grid-template-columns:1fr 1fr;
  gap:8px
}

.stat{
  padding:10px;
  background:#141c23;
  border-radius:7px
}

.stat b{
  float:right
}

canvas{
  width:100%;
  height:170px;
  background:#0a0f13;
  border-radius:7px
}

@media(max-width:1100px){

  .kpis{
    grid-template-columns:repeat(4,1fr)
  }

  .two{
    grid-template-columns:1fr
  }

}

@media(max-width:650px){

  .kpis{
    grid-template-columns:repeat(2,1fr)
  }

}

</style>
</head>

<body>

<div class="wrap">

<div class="top">

<h1>MemeHunter Live</h1>

<span class="badge">
LIVE DATA • PAPER MONEY
</span>

<span class="small">
DEX Screener
</span>

<div style="flex:1"></div>

<span
  id="status"
  class="status"
>
● RUNNING
</span>

<button onclick="scan()">
Scan Now
</button>

<button onclick="resetAccount()">
Reset 10,000U
</button>

</div>

<div class="note">
10,000U 模擬資金，
使用真實 Solana DEX 行情進行 paper trading。
不連接錢包、不使用真錢。
資料由 Render 後端抓取，
所以不會有本機 HTML 的 CORS 問題。
</div>

<div
  id="error"
  class="error"
></div>

<div class="grid kpis">

<div class="card">
<div class="label">EQUITY</div>
<div
  id="equity"
  class="value"
>
10,000.00 U
</div>
</div>

<div class="card">
<div class="label">CASH</div>
<div
  id="cash"
  class="value"
>
10,000.00 U
</div>
</div>

<div class="card">
<div class="label">TOTAL PNL</div>
<div
  id="totalPnl"
  class="value"
>
0.00 U
</div>
</div>

<div class="card">
<div class="label">REALIZED</div>
<div
  id="realized"
  class="value"
>
0.00 U
</div>
</div>

<div class="card">
<div class="label">UNREALIZED</div>
<div
  id="unrealized"
  class="value"
>
0.00 U
</div>
</div>

<div class="card">
<div class="label">WIN RATE</div>
<div
  id="winRate"
  class="value"
>
—
</div>
</div>

<div class="card">
<div class="label">MAX DRAWDOWN</div>
<div
  id="maxDd"
  class="value"
>
0.0%
</div>
</div>

<div class="card">
<div class="label">OPEN POSITIONS</div>
<div
  id="openCount"
  class="value"
>
0
</div>
</div>

</div>

<div class="grid two">

<div class="panel">

<div class="panel-title">

<h2>
模擬資金曲線
</h2>

<span
  id="lastScan"
  class="small"
>
尚未掃描
</span>

</div>

<canvas
  id="equityChart"
  width="1000"
  height="170"
></canvas>

</div>

<div class="panel">

<div class="panel-title">

<h2>
Market Monitor
</h2>

<span
  id="tokenCount"
  class="small"
>
0 tokens
</span>

</div>

<div class="stats">

<div class="stat">
最佳分數
<b id="bestScore">—</b>
</div>

<div class="stat">
符合進場
<b id="candidateCount">0</b>
</div>

<div class="stat">
交易紀錄
<b id="tradeCount">0</b>
</div>

<div class="stat">
模擬成本
<b id="fees">0 U</b>
</div>

<div class="stat">
曝險
<b id="exposure">0%</b>
</div>

<div class="stat">
下次掃描
<b id="nextScan">—</b>
</div>

</div>

</div>

</div>

<div class="panel">

<div class="panel-title">

<h2>
Live Hunter Feed
</h2>

<span class="small">
真實 Solana tokens
</span>

</div>

<div class="scroll">

<table>

<thead>

<tr>

<th>Token</th>

<th>Age</th>

<th>Price</th>

<th>Liquidity</th>

<th>Vol 5m</th>

<th>Vol 1h</th>

<th>5m B/S</th>

<th>5m %</th>

<th>1h %</th>

<th>Score</th>

<th>Decision</th>

</tr>

</thead>

<tbody id="feed"></tbody>

</table>

</div>

</div>

<div class="grid two">

<div class="panel">

<div class="panel-title">

<h2>
目前持倉
</h2>

<span class="small">
真實價格 • 模擬資金
</span>

</div>

<div class="scroll">

<table>

<thead>

<tr>

<th>Token</th>

<th>Entry</th>

<th>Now</th>

<th>Value</th>

<th>PnL</th>

<th>Age</th>

</tr>

</thead>

<tbody id="positions"></tbody>

</table>

</div>

</div>

<div class="panel">

<div class="panel-title">

<h2>
策略
</h2>

<span class="small">
Balanced v1
</span>

</div>

<div
  class="small"
  style="line-height:1.8"
>

起始 10,000U<br>

單筆 5% Equity，
最高 600U<br>

最多同時 4 倉<br>

總曝險上限 20%<br>

流動性至少 50k<br>

1h Volume 至少 15k<br>

Score ≥ 68<br>

5m 買賣比 ≥ 1.15<br>

防追高：
5m > 40% 或 1h > 150% 不買<br>

硬停損 -10%<br>

TP1 +15% 出 40%<br>

TP2 +30% 出剩餘部位 50%<br>

TP1 後使用 10% trailing stop<br>

120 分鐘 time stop<br>

模擬交易成本：
進出各 0.5%

</div>

</div>

</div>

<div class="panel">

<div class="panel-title">

<h2>
交易紀錄
</h2>

<span class="small">
沒有預塞假交易
</span>

</div>

<div class="scroll">

<table>

<thead>

<tr>

<th>Time</th>

<th>Token</th>

<th>Action</th>

<th>Price</th>

<th>Amount</th>

<th>PnL</th>

<th>Reason</th>

</tr>

</thead>

<tbody id="trades"></tbody>

</table>

</div>

</div>

</div>

<script>

const KEY =
  "memehunter_live_dex_v1";

const START_BALANCE =
  10000;

const SCAN_MS =
  65000;

let universe = [];

let nextScanAt =
  Date.now() + 2000;

let scanning =
  false;

function freshState(){

  return {
    cash:10000,

    realized:0,

    fees:0,

    positions:{},

    trades:[],

    cooldowns:{},

    equityHistory:[
      {
        time:Date.now(),
        equity:10000
      }
    ]
  };

}

let state;

try{

  state =
    JSON.parse(
      localStorage.getItem(KEY)
    ) || freshState();

}catch{

  state =
    freshState();

}

function save(){

  localStorage.setItem(
    KEY,
    JSON.stringify(state)
  );

}

function money(v){

  return Number(v || 0)
    .toLocaleString(
      undefined,
      {
        minimumFractionDigits:2,
        maximumFractionDigits:2
      }
    );

}

function price(v){

  v = Number(v || 0);

  if(!v){
    return "—";
  }

  if(v >= 1){
    return "$" +
      v.toFixed(4);
  }

  return "$" +
    v.toPrecision(5);

}

function color(v){

  if(v > 0){
    return "green";
  }

  if(v < 0){
    return "red";
  }

  return "";

}

function age(t){

  const seconds =
    Math.max(
      0,
      (Date.now() - t) / 1000
    );

  if(seconds < 3600){

    return Math.floor(
      seconds / 60
    ) + "m";

  }

  if(seconds < 86400){

    return (
      seconds / 3600
    ).toFixed(1) + "h";

  }

  return (
    seconds / 86400
  ).toFixed(1) + "d";

}

function tokenScore(p){

  let score = 0;

  // Liquidity 25
  score +=
    Math.min(
      25,
      p.liquidity / 6000
    );

  // 1h volume 20
  score +=
    Math.min(
      20,
      p.volume1h / 8000
    );

  // recent activity 15
  score +=
    Math.min(
      15,
      (p.buys5m + p.sells5m) / 5
    );

  // buy pressure 15
  const ratio =
    p.buys5m /
    Math.max(
      1,
      p.sells5m
    );

  score +=
    Math.min(
      15,
      ratio * 7
    );

  // momentum 15
  if(
    p.price5m > 0 &&
    p.price5m < 40
  ){
    score += 8;
  }

  if(
    p.price1h > 0 &&
    p.price1h < 150
  ){
    score += 7;
  }

  // age 10
  const h =
    (
      Date.now() -
      p.createdAt
    ) /
    3600000;

  if(
    h >= 0.25 &&
    h <= 24
  ){
    score += 10;
  }else if(h <= 72){
    score += 6;
  }

  return Math.round(
    Math.min(
      100,
      score
    )
  );

}

function evaluate(p){

  const score =
    tokenScore(p);

  const reasons = [];

  const pairMinutes =
    (
      Date.now() -
      p.createdAt
    ) /
    60000;

  if(
    p.liquidity < 50000
  ){
    reasons.push(
      "Liquidity < 50k"
    );
  }

  if(
    p.volume1h < 15000
  ){
    reasons.push(
      "1h volume < 15k"
    );
  }

  if(
    p.buys5m +
    p.sells5m <
    15
  ){
    reasons.push(
      "Low 5m activity"
    );
  }

  if(pairMinutes < 5){

    reasons.push(
      "Too new"
    );

  }

  if(
    p.price5m > 40 ||
    p.price1h > 150
  ){

    reasons.push(
      "Anti-FOMO"
    );

  }

  if(score < 68){

    reasons.push(
      "Score < 68"
    );

  }

  const ratio =
    p.buys5m /
    Math.max(
      1,
      p.sells5m
    );

  if(ratio < 1.15){

    reasons.push(
      "B/S < 1.15"
    );

  }

  if(!reasons.length){

    return {
      score,
      decision:"BUY"
    };

  }

  const hard =
    reasons.some(
      x =>
        x.includes("Liquidity") ||
        x.includes("volume") ||
        x.includes("activity")
    );

  return {
    score,
    decision:
      hard
        ? "REJECT"
        : "WATCH"
  };

}

function currentPrice(address){

  const token =
    universe.find(
      x =>
        x.address ===
        address
    );

  return token?.price || 0;

}

function getEquity(){

  let positionValue =
    0;

  let cost =
    0;

  for(
    const p
    of Object.values(
      state.positions
    )
  ){

    const px =
      currentPrice(
        p.address
      ) ||
      p.last ||
      p.entry;

    positionValue +=
      p.qty * px;

    cost +=
      p.qty *
      p.entry;

  }

  return {

    equity:
      state.cash +
      positionValue,

    positionValue,

    unrealized:
      positionValue -
      cost

  };

}

function addTrade(
  action,
  p,
  px,
  amount,
  pnl,
  reason
){

  state.trades.unshift({

    time:Date.now(),

    symbol:p.symbol,

    action,

    price:px,

    amount,

    pnl,

    reason

  });

  state.trades =
    state.trades.slice(
      0,
      500
    );

}

function closePosition(
  pos,
  fraction,
  px,
  reason
){

  const qty =
    Math.min(
      pos.qty,
      pos.qty * fraction
    );

  const gross =
    qty * px;

  const fee =
    gross * 0.005;

  const proceeds =
    gross - fee;

  const basis =
    qty * pos.entry;

  const pnl =
    proceeds -
    basis;

  state.cash +=
    proceeds;

  state.fees +=
    fee;

  state.realized +=
    pnl;

  pos.qty -=
    qty;

  addTrade(
    "SELL",
    pos,
    px,
    gross,
    pnl,
    reason
  );

  if(
    pos.qty <
    0.000000000001
  ){

    delete state.positions[
      pos.address
    ];

    state.cooldowns[
      pos.address
    ] =
      Date.now() +
      6 * 3600000;

  }

}

function managePositions(){

  for(
    const pos
    of Object.values({
      ...state.positions
    })
  ){

    const market =
      universe.find(
        x =>
          x.address ===
          pos.address
      );

    if(!market){
      continue;
    }

    const px =
      market.price;

    pos.last =
      px;

    pos.high =
      Math.max(
        pos.high ||
        pos.entry,
        px
      );

    const ret =
      px /
      pos.entry -
      1;

    if(
      ret <= -0.10
    ){

      closePosition(
        pos,
        1,
        px,
        "Hard stop -10%"
      );

      continue;

    }

    if(
      market.liquidity <
      pos.entryLiquidity *
      0.65
    ){

      closePosition(
        pos,
        1,
        px,
        "Liquidity drop >35%"
      );

      continue;

    }

    if(
      !pos.tp1 &&
      ret >= 0.15
    ){

      closePosition(
        pos,
        0.40,
        px,
        "TP1 +15%"
      );

      pos.tp1 =
        true;

      continue;

    }

    if(
      pos.tp1 &&
      !pos.tp2 &&
      ret >= 0.30
    ){

      closePosition(
        pos,
        0.50,
        px,
        "TP2 +30%"
      );

      pos.tp2 =
        true;

      continue;

    }

    if(
      pos.tp1 &&
      px <=
      pos.high *
      0.90
    ){

      closePosition(
        pos,
        1,
        px,
        "Trailing stop"
      );

      continue;

    }

    if(
      !pos.tp1 &&
      Date.now() -
      pos.opened >
      120 * 60000
    ){

      closePosition(
        pos,
        1,
        px,
        "120m time stop"
      );

    }

  }

}

function enterPositions(){

  const eq =
    getEquity();

  let slots =
    4 -
    Object.keys(
      state.positions
    ).length;

  let room =
    Math.max(
      0,
      eq.equity *
      0.20 -
      eq.positionValue
    );

  const picks =
    universe
      .map(
        p => ({
          p,
          e:evaluate(p)
        })
      )
      .filter(
        x =>
          x.e.decision ===
          "BUY"
      )
      .sort(
        (a,b) =>
          b.e.score -
          a.e.score
      );

  for(
    const item
    of picks
  ){

    if(
      slots <= 0 ||
      room < 50
    ){
      break;
    }

    const p =
      item.p;

    if(
      state.positions[
        p.address
      ]
    ){
      continue;
    }

    if(
      Date.now() <
      (
        state.cooldowns[
          p.address
        ] || 0
      )
    ){
      continue;
    }

    const size =
      Math.min(
        eq.equity *
        0.05,
        600,
        room,
        state.cash /
        1.005
      );

    if(size < 50){
      continue;
    }

    const fee =
      size *
      0.005;

    state.cash -=
      size +
      fee;

    state.fees +=
      fee;

    const qty =
      size /
      p.price;

    state.positions[
      p.address
    ] = {

      address:
        p.address,

      symbol:
        p.symbol,

      entry:
        p.price,

      last:
        p.price,

      high:
        p.price,

      qty,

      opened:
        Date.now(),

      entryLiquidity:
        p.liquidity,

      tp1:false,

      tp2:false,

      score:
        item.e.score

    };

    addTrade(
      "BUY",
      state.positions[
        p.address
      ],
      p.price,
      size,
      -fee,
      "Score " +
      item.e.score
    );

    slots--;

    room -=
      size;

  }

}

function recordEquity(){

  const e =
    getEquity()
      .equity;

  const last =
    state.equityHistory[
      state.equityHistory.length -
      1
    ];

  if(
    !last ||
    Math.abs(
      last.equity - e
    ) > 0.01 ||
    Date.now() -
    last.time >
    300000
  ){

    state.equityHistory.push({

      time:Date.now(),

      equity:e

    });

  }

  state.equityHistory =
    state.equityHistory.slice(
      -2000
    );

}

function maxDrawdown(){

  let peak =
    0;

  let max =
    0;

  for(
    const p
    of state.equityHistory
  ){

    peak =
      Math.max(
        peak,
        p.equity
      );

    if(peak){

      max =
        Math.max(
          max,
          (
            peak -
            p.equity
          ) /
          peak
        );

    }

  }

  return max * 100;

}

async function scan(){

  if(scanning){
    return;
  }

  scanning =
    true;

  const error =
    document.getElementById(
      "error"
    );

  error.style.display =
    "none";

  try{

    const r =
      await fetch(
        "/api/market",
        {
          cache:"no-store"
        }
      );

    if(!r.ok){

      throw new Error(
        "HTTP " +
        r.status
      );

    }

    const data =
      await r.json();

    if(
      !Array.isArray(data)
    ){

      throw new Error(
        "Invalid market data"
      );

    }

    universe =
      data;

    managePositions();

    enterPositions();

    recordEquity();

    save();

    render();

    document.getElementById(
      "lastScan"
    ).textContent =
      "Last scan " +
      new Date()
        .toLocaleTimeString();

  }catch(e){

    error.textContent =
      "行情抓取失敗：" +
      e.message;

    error.style.display =
      "block";

  }finally{

    scanning =
      false;

    nextScanAt =
      Date.now() +
      SCAN_MS;

  }

}

function render(){

  const eq =
    getEquity();

  const total =
    eq.equity -
    START_BALANCE;

  const sells =
    state.trades.filter(
      x =>
        x.action ===
        "SELL"
    );

  const wins =
    sells.filter(
      x =>
        x.pnl > 0
    ).length;

  document.getElementById(
    "equity"
  ).textContent =
    money(
      eq.equity
    ) +
    " U";

  document.getElementById(
    "cash"
  ).textContent =
    money(
      state.cash
    ) +
    " U";

  const pnlEl =
    document.getElementById(
      "totalPnl"
    );

  pnlEl.textContent =
    (
      total >= 0
        ? "+"
        : ""
    ) +
    money(total) +
    " U";

  pnlEl.className =
    "value " +
    color(total);

  const real =
    document.getElementById(
      "realized"
    );

  real.textContent =
    (
      state.realized >= 0
        ? "+"
        : ""
    ) +
    money(
      state.realized
    ) +
    " U";

  real.className =
    "value " +
    color(
      state.realized
    );

  const un =
    document.getElementById(
      "unrealized"
    );

  un.textContent =
    (
      eq.unrealized >= 0
        ? "+"
        : ""
    ) +
    money(
      eq.unrealized
    ) +
    " U";

  un.className =
    "value " +
    color(
      eq.unrealized
    );

  document.getElementById(
    "winRate"
  ).textContent =
    sells.length
      ? (
          wins /
          sells.length *
          100
        ).toFixed(1) +
        "%"
      : "—";

  document.getElementById(
    "maxDd"
  ).textContent =
    maxDrawdown()
      .toFixed(1) +
    "%";

  document.getElementById(
    "openCount"
  ).textContent =
    Object.keys(
      state.positions
    ).length;

  const evaluations =
    universe.map(
      p => ({
        p,
        e:evaluate(p)
      })
    );

  document.getElementById(
    "tokenCount"
  ).textContent =
    universe.length +
    " tokens";

  document.getElementById(
    "candidateCount"
  ).textContent =
    evaluations.filter(
      x =>
        x.e.decision ===
        "BUY"
    ).length;

  document.getElementById(
    "bestScore"
  ).textContent =
    evaluations.length
      ? Math.max(
          ...evaluations.map(
            x =>
              x.e.score
          )
        )
      : "—";

  document.getElementById(
    "tradeCount"
  ).textContent =
    state.trades.length;

  document.getElementById(
    "fees"
  ).textContent =
    money(
      state.fees
    ) +
    " U";

  document.getElementById(
    "exposure"
  ).textContent =
    (
      eq.positionValue /
      Math.max(
        1,
        eq.equity
      ) *
      100
    ).toFixed(1) +
    "%";

  const sorted =
    evaluations
      .sort(
        (a,b) =>
          b.e.score -
          a.e.score
      )
      .slice(
        0,
        50
      );

  document.getElementById(
    "feed"
  ).innerHTML =
    sorted.map(x => {

      const p =
        x.p;

      const e =
        x.e;

      return \`

      <tr>

      <td>

      <a
        href="\${p.url}"
        target="_blank"
      >

      <b>
      \${p.symbol}
      </b>

      </a>

      </td>

      <td>
      \${age(
        p.createdAt
      )}
      </td>

      <td>
      \${price(
        p.price
      )}
      </td>

      <td>
      $\${money(
        p.liquidity /
        1000
      )}k
      </td>

      <td>
      $\${money(
        p.volume5m /
        1000
      )}k
      </td>

      <td>
      $\${money(
        p.volume1h /
        1000
      )}k
      </td>

      <td>
      \${p.buys5m}/\${p.sells5m}
      </td>

      <td class="\${color(
        p.price5m
      )}">
      \${p.price5m.toFixed(1)}%
      </td>

      <td class="\${color(
        p.price1h
      )}">
      \${p.price1h.toFixed(1)}%
      </td>

      <td>
      <b>
      \${e.score}
      </b>
      </td>

      <td class="\${
        e.decision ===
        "BUY"
          ? "green"
          : e.decision ===
            "REJECT"
          ? "red"
          : "yellow"
      }">

      \${e.decision}

      </td>

      </tr>

      \`;

    }).join("");

  document.getElementById(
    "positions"
  ).innerHTML =
    Object.values(
      state.positions
    )
    .map(p => {

      const px =
        currentPrice(
          p.address
        ) ||
        p.last ||
        p.entry;

      const value =
        p.qty *
        px;

      const pnl =
        value -
        p.qty *
        p.entry;

      return \`

      <tr>

      <td>
      <b>\${p.symbol}</b>
      </td>

      <td>
      \${price(p.entry)}
      </td>

      <td>
      \${price(px)}
      </td>

      <td>
      \${money(value)} U
      </td>

      <td class="\${color(pnl)}">
      \${pnl >= 0 ? "+" : ""}
      \${money(pnl)} U
      </td>

      <td>
      \${age(p.opened)}
      </td>

      </tr>

      \`;

    }).join("")
    ||
    \`
    <tr>
    <td colspan="6">
    目前沒有持倉
    </td>
    </tr>
    \`;

  document.getElementById(
    "trades"
  ).innerHTML =
    state.trades
      .slice(
        0,
        100
      )
      .map(t => \`

      <tr>

      <td>
      \${new Date(
        t.time
      ).toLocaleString()}
      </td>

      <td>
      <b>
      \${t.symbol}
      </b>
      </td>

      <td>
      \${t.action}
      </td>

      <td>
      \${price(
        t.price
      )}
      </td>

      <td>
      \${money(
        t.amount
      )} U
      </td>

      <td class="\${color(
        t.pnl
      )}">
      \${t.pnl >= 0 ? "+" : ""}
      \${money(
        t.pnl
      )} U
      </td>

      <td>
      \${t.reason}
      </td>

      </tr>

      \`)
      .join("")
    ||
    \`
    <tr>
    <td colspan="7">
    尚無交易
    </td>
    </tr>
    \`;

  drawChart();

}

function drawChart(){

  const canvas =
    document.getElementById(
      "equityChart"
    );

  const ctx =
    canvas.getContext("2d");

  const w =
    canvas.width;

  const h =
    canvas.height;

  ctx.clearRect(
    0,
    0,
    w,
    h
  );

  const data =
    state.equityHistory;

  if(!data.length){
    return;
  }

  const values =
    data.map(
      x =>
        x.equity
    );

  let min =
    Math.min(
      ...values
    );

  let max =
    Math.max(
      ...values
    );

  if(
    max -
    min <
    1
  ){
    min -= 10;
    max += 10;
  }

  ctx.strokeStyle =
    "#31e986";

  ctx.lineWidth =
    2;

  ctx.beginPath();

  data.forEach(
    (p,i) => {

      const x =
        10 +
        (
          w -
          20
        ) *
        (
          i /
          Math.max(
            1,
            data.length -
            1
          )
        );

      const y =
        h -
        10 -
        (
          h -
          20
        ) *
        (
          (
            p.equity -
            min
          ) /
          (
            max -
            min
          )
        );

      if(i === 0){

        ctx.moveTo(
          x,
          y
        );

      }else{

        ctx.lineTo(
          x,
          y
        );

      }

    }
  );

  ctx.stroke();

}

function resetAccount(){

  if(
    !confirm(
      "確定重新從 10,000U 開始？"
    )
  ){
    return;
  }

  state =
    freshState();

  save();

  render();

}

setInterval(
  () => {

    const remaining =
      Math.max(
        0,
        Math.ceil(
          (
            nextScanAt -
            Date.now()
          ) /
          1000
        )
      );

    document.getElementById(
      "nextScan"
    ).textContent =
      remaining +
      "s";

    if(
      !scanning &&
      Date.now() >=
      nextScanAt
    ){

      scan();

    }

  },
  1000
);

render();

scan();

</script>

</body>

</html>
`;

// ==============================
// SERVER
// ==============================

const server =
  http.createServer(
    async (
      req,
      res
    ) => {

      try{

        const url =
          new URL(
            req.url,
            "http://localhost"
          );

        if(
          url.pathname ===
          "/api/market"
        ){

          try{

            const data =
              await getMarketData();

            res.writeHead(
              200,
              {
                "content-type":
                  "application/json; charset=utf-8",

                "cache-control":
                  "no-store",

                "access-control-allow-origin":
                  "*"
              }
            );

            return res.end(
              JSON.stringify(
                data
              )
            );

          }catch(e){

            console.error(
              "Market error:",
              e
            );

            res.writeHead(
              502,
              {
                "content-type":
                  "application/json; charset=utf-8"
              }
            );

            return res.end(
              JSON.stringify({
                error:
                  String(
                    e.message ||
                    e
                  )
              })
            );

          }

        }

        res.writeHead(
          200,
          {
            "content-type":
              "text/html; charset=utf-8",

            "cache-control":
              "no-store"
          }
        );

        return res.end(
          PAGE
        );

      }catch(e){

        res.writeHead(
          500,
          {
            "content-type":
              "text/plain; charset=utf-8"
          }
        );

        res.end(
          String(e)
        );

      }

    }
  );

server.listen(
  PORT,
  "0.0.0.0",
  () => {

    console.log(
      "MemeHunter running on",
      PORT
    );

  }
);
