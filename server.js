const http = require("http");

const PORT = process.env.PORT || 10000;

const CACHE_MS = 60000;

// 模擬成本假設
const DEX_FEE_RATE = 0.003;     // 0.30% swap / DEX fee
const GAS_FEE_USD = 0.02;      // 每次 swap 模擬 gas + priority fee
const MIN_SLIPPAGE = 0.0025;   // 0.25%
const MAX_SLIPPAGE = 0.02;     // 2.00%

let discoveryCache = {
  time: 0,
  tokens: []
};

// ============================================================
// HELPERS
// ============================================================

function clamp(value, min, max) {
  return Math.max(
    min,
    Math.min(max, value)
  );
}

function estimateSlippageRate(
  tradeUsd,
  liquidityUsd
) {
  const liquidity =
    Math.max(
      Number(liquidityUsd || 0),
      1
    );

  const size =
    Math.max(
      Number(tradeUsd || 0),
      0
    );

  // 流動性越差 / 單越大，滑價越高
  const impact =
    (size / liquidity) * 0.35;

  return clamp(
    MIN_SLIPPAGE + impact,
    MIN_SLIPPAGE,
    MAX_SLIPPAGE
  );
}

async function fetchJson(url) {
  const response =
    await fetch(
      url,
      {
        headers: {
          Accept:
            "application/json",

          "User-Agent":
            "MemeHunter-Paper-Trader/3.0"
        }
      }
    );

  if (!response.ok) {
    throw new Error(
      "DEX Screener HTTP " +
      response.status
    );
  }

  return response.json();
}

// ============================================================
// DEX SCREENER DATA
// ============================================================

async function fetchPairsByAddresses(
  addresses
) {
  const unique = [
    ...new Set(
      (addresses || [])
        .filter(Boolean)
    )
  ];

  let rawPairs = [];

  for (
    let i = 0;
    i < unique.length;
    i += 30
  ) {
    const batch =
      unique.slice(
        i,
        i + 30
      );

    if (!batch.length) {
      continue;
    }

    try {
      const data =
        await fetchJson(
          "https://api.dexscreener.com/tokens/v1/solana/" +
          batch.join(",")
        );

      if (Array.isArray(data)) {
        rawPairs.push(...data);
      }

    } catch (error) {
      console.log(
        "Token batch error:",
        error.message
      );
    }
  }

  const bestPairs =
    new Map();

  for (const pair of rawPairs) {
    if (!pair) continue;

    if (
      pair.chainId !==
      "solana"
    ) {
      continue;
    }

    if (
      !pair.baseToken ||
      !pair.baseToken.address ||
      !pair.priceUsd
    ) {
      continue;
    }

    const address =
      pair.baseToken.address;

    const liquidity =
      Number(
        pair.liquidity?.usd ||
        0
      );

    const old =
      bestPairs.get(
        address
      );

    const oldLiquidity =
      old
        ? Number(
            old.liquidity?.usd ||
            0
          )
        : 0;

    if (
      !old ||
      liquidity >
      oldLiquidity
    ) {
      bestPairs.set(
        address,
        pair
      );
    }
  }

  return [
    ...bestPairs.values()
  ];
}

function normalizePair(pair) {
  return {
    address:
      pair.baseToken?.address ||
      "",

    pairAddress:
      pair.pairAddress ||
      "",

    symbol:
      pair.baseToken?.symbol ||
      "?",

    name:
      pair.baseToken?.name ||
      pair.baseToken?.symbol ||
      "?",

    price:
      Number(
        pair.priceUsd ||
        0
      ),

    liquidity:
      Number(
        pair.liquidity?.usd ||
        0
      ),

    volume5m:
      Number(
        pair.volume?.m5 ||
        0
      ),

    volume1h:
      Number(
        pair.volume?.h1 ||
        0
      ),

    buys5m:
      Number(
        pair.txns?.m5?.buys ||
        0
      ),

    sells5m:
      Number(
        pair.txns?.m5?.sells ||
        0
      ),

    price5m:
      Number(
        pair.priceChange?.m5 ||
        0
      ),

    price1h:
      Number(
        pair.priceChange?.h1 ||
        0
      ),

    createdAt:
      Number(
        pair.pairCreatedAt ||
        Date.now()
      ),

    url:
      pair.url ||
      (
        "https://dexscreener.com/solana/" +
        pair.pairAddress
      )
  };
}

async function discoverTokens() {
  if (
    discoveryCache.tokens.length &&
    Date.now() -
    discoveryCache.time <
    CACHE_MS
  ) {
    return {
      tokens:
        discoveryCache.tokens,

      stale:
        false
    };
  }

  try {
    const results =
      await Promise.allSettled([
        fetchJson(
          "https://api.dexscreener.com/token-profiles/latest/v1"
        ),

        fetchJson(
          "https://api.dexscreener.com/token-boosts/latest/v1"
        ),

        fetchJson(
          "https://api.dexscreener.com/token-boosts/top/v1"
        )
      ]);

    let discovery = [];

    for (const result of results) {
      if (
        result.status ===
        "fulfilled" &&
        Array.isArray(
          result.value
        )
      ) {
        discovery.push(
          ...result.value
        );
      }
    }

    const addresses = [
      ...new Set(
        discovery
          .filter(
            function (item) {
              return (
                item &&
                item.chainId ===
                  "solana" &&
                item.tokenAddress
              );
            }
          )
          .map(
            function (item) {
              return (
                item.tokenAddress
              );
            }
          )
      )
    ].slice(0, 90);

    if (!addresses.length) {
      throw new Error(
        "No Solana tokens discovered"
      );
    }

    const pairs =
      await fetchPairsByAddresses(
        addresses
      );

    const tokens =
      pairs.map(
        normalizePair
      );

    if (!tokens.length) {
      throw new Error(
        "No Solana market pairs returned"
      );
    }

    discoveryCache = {
      time:
        Date.now(),

      tokens:
        tokens
    };

    return {
      tokens:
        tokens,

      stale:
        false
    };

  } catch (error) {
    console.log(
      "Discovery error:",
      error.message
    );

    if (
      discoveryCache.tokens.length
    ) {
      return {
        tokens:
          discoveryCache.tokens,

        stale:
          true
      };
    }

    throw error;
  }
}

async function getMarketData(
  positionAddresses
) {
  let discovery;

  try {
    discovery =
      await discoverTokens();

  } catch (error) {
    discovery = {
      tokens: [],
      stale: true
    };

    console.log(
      "Discovery unavailable:",
      error.message
    );
  }

  let positionTokens = [];

  if (
    positionAddresses &&
    positionAddresses.length
  ) {
    try {
      const positionPairs =
        await fetchPairsByAddresses(
          positionAddresses
        );

      positionTokens =
        positionPairs.map(
          normalizePair
        );

    } catch (error) {
      console.log(
        "Position refresh error:",
        error.message
      );
    }
  }

  const combined =
    new Map();

  for (
    const token
    of discovery.tokens
  ) {
    combined.set(
      token.address,
      token
    );
  }

  // 持倉幣最新行情優先
  for (
    const token
    of positionTokens
  ) {
    combined.set(
      token.address,
      token
    );
  }

  if (
    !combined.size
  ) {
    throw new Error(
      "No market data available"
    );
  }

  return {
    tokens:
      [...combined.values()],

    stale:
      discovery.stale,

    updatedAt:
      Date.now()
  };
}

// ============================================================
// HTML
// ============================================================

const PAGE = `
<!doctype html>
<html lang="zh-Hant">

<head>

<meta charset="utf-8">

<meta
  name="viewport"
  content="width=device-width,initial-scale=1"
>

<title>
MemeHunter Live
</title>

<style>

*{
  box-sizing:border-box;
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
    sans-serif;
}

.wrap{
  max-width:1500px;
  margin:auto;
  padding:18px;
}

.top{
  display:flex;
  gap:12px;
  align-items:center;
  flex-wrap:wrap;
}

h1{
  margin:0;
  font-size:23px;
}

.spacer{
  flex:1;
}

.badge{
  color:#31e986;
  border:1px solid #17643d;
  background:#0b2518;
  padding:5px 9px;
  border-radius:999px;
  font-size:11px;
}

.status{
  color:#31e986;
}

button{
  padding:9px 14px;
  border-radius:8px;
  border:1px solid #33404a;
  background:#162029;
  color:#fff;
  cursor:pointer;
}

button:disabled{
  opacity:.6;
}

.note,
.warning{
  margin-top:14px;
  padding:11px 13px;
  border-radius:9px;
  font-size:12px;
}

.note{
  background:#0f151b;
  border:1px solid #27323b;
  color:#9cabb7;
}

.warning{
  display:none;
  background:#2b2411;
  border:1px solid #6d581c;
  color:#f6ce72;
}

.error{
  display:none;
  margin-top:12px;
  background:#2b1116;
  border:1px solid #6d3038;
  color:#ff98a3;
  padding:11px;
  border-radius:8px;
}

.grid{
  display:grid;
  gap:12px;
}

.kpis{
  grid-template-columns:
    repeat(
      8,
      minmax(120px,1fr)
    );

  margin-top:14px;
}

.card,
.panel{
  background:#10161c;
  border:1px solid #26313a;
  border-radius:10px;
}

.card{
  padding:14px;
}

.panel{
  margin-top:14px;
  padding:14px;
}

.label{
  color:#8ca0af;
  font-size:11px;
}

.value{
  margin-top:5px;
  font-size:21px;
  font-weight:800;
}

.green{
  color:#31e986;
}

.red{
  color:#ff6877;
}

.yellow{
  color:#f2bc59;
}

.panel-title{
  display:flex;
  justify-content:space-between;
  align-items:center;
  gap:10px;
  margin-bottom:10px;
}

.panel-title h2{
  margin:0;
  font-size:16px;
}

.small{
  font-size:11px;
  color:#8999a6;
}

.two{
  grid-template-columns:
    1.3fr .7fr;
}

.stats{
  display:grid;
  grid-template-columns:
    1fr 1fr;
  gap:8px;
}

.stat{
  padding:10px;
  background:#141c23;
  border-radius:7px;
}

.stat b{
  float:right;
}

.cost-grid{
  display:grid;
  grid-template-columns:
    repeat(4,1fr);
  gap:8px;
  margin-top:10px;
}

.cost-item{
  padding:9px;
  background:#141c23;
  border-radius:7px;
}

.cost-item span{
  display:block;
  font-size:10px;
  color:#8999a6;
}

.cost-item b{
  display:block;
  margin-top:4px;
}

.scroll{
  overflow:auto;
  max-height:470px;
}

table{
  width:100%;
  border-collapse:collapse;
  font-size:12px;
}

th,
td{
  text-align:left;
  padding:9px;
  border-bottom:
    1px solid #202a32;
  white-space:nowrap;
}

th{
  color:#8ca0af;
}

a{
  color:#8fcaff;
  text-decoration:none;
}

canvas{
  width:100%;
  height:170px;
  background:#0a0f13;
  border-radius:7px;
}

.strategy-grid{
  display:grid;
  grid-template-columns:
    repeat(3,1fr);
  gap:7px;
  margin-top:10px;
}

.strategy-item{
  background:#141c23;
  padding:9px;
  border-radius:7px;
}

.strategy-item span{
  color:#8999a6;
  font-size:10px;
}

.strategy-item b{
  display:block;
  margin-top:3px;
}

.evolution{
  margin-top:10px;
  padding:10px;
  background:#0d1318;
  border:1px solid #27323b;
  border-radius:8px;
}

.evolution-entry{
  padding:8px 0;
  border-bottom:
    1px solid #1e272e;
  font-size:11px;
  line-height:1.6;
}

@media(max-width:1100px){

  .kpis{
    grid-template-columns:
      repeat(4,1fr);
  }

  .two{
    grid-template-columns:1fr;
  }

  .cost-grid{
    grid-template-columns:
      repeat(2,1fr);
  }

}

@media(max-width:650px){

  .kpis{
    grid-template-columns:
      repeat(2,1fr);
  }

  .strategy-grid{
    grid-template-columns:
      1fr 1fr;
  }

}

</style>

</head>

<body>

<div class="wrap">

<div class="top">

<h1>
MemeHunter Live
</h1>

<span class="badge">
LIVE DATA • PAPER MONEY
</span>

<span class="small">
DEX Screener
</span>

<div class="spacer"></div>

<span
  id="status"
  class="status"
>
● RUNNING
</span>

<button
  id="scanBtn"
  type="button"
>
Scan Now
</button>

<button
  id="resetBtn"
  type="button"
>
Reset 10,000U
</button>

</div>

<div class="note">

真實 Solana meme 行情 +
真實成本模擬。

成本包含：
DEX fee、動態滑價、
Solana gas / priority fee。

+50% 後切換保本模式，
+100% 後保留 Runner 尋找金狗。

</div>

<div
  id="warning"
  class="warning"
></div>

<div
  id="error"
  class="error"
></div>

<div class="grid kpis">

<div class="card">

<div class="label">
EQUITY
</div>

<div
  id="equity"
  class="value"
>
10,000.00 U
</div>

</div>

<div class="card">

<div class="label">
CASH
</div>

<div
  id="cash"
  class="value"
>
10,000.00 U
</div>

</div>

<div class="card">

<div class="label">
TOTAL PNL
</div>

<div
  id="totalPnl"
  class="value"
>
0.00 U
</div>

</div>

<div class="card">

<div class="label">
REALIZED
</div>

<div
  id="realized"
  class="value"
>
0.00 U
</div>

</div>

<div class="card">

<div class="label">
UNREALIZED
</div>

<div
  id="unrealized"
  class="value"
>
0.00 U
</div>

</div>

<div class="card">

<div class="label">
WIN RATE
</div>

<div
  id="winRate"
  class="value"
>
—
</div>

</div>

<div class="card">

<div class="label">
MAX DRAWDOWN
</div>

<div
  id="maxDd"
  class="value"
>
0.0%
</div>

</div>

<div class="card">

<div class="label">
OPEN POSITIONS
</div>

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
<b id="bestScore">
—
</b>
</div>

<div class="stat">
符合進場
<b id="candidateCount">
0
</b>
</div>

<div class="stat">
交易紀錄
<b id="tradeCount">
0
</b>
</div>

<div class="stat">
總成本
<b id="totalCosts">
0 U
</b>
</div>

<div class="stat">
曝險
<b id="exposure">
0%
</b>
</div>

<div class="stat">
下次掃描
<b id="nextScan">
—
</b>
</div>

</div>

<div class="cost-grid">

<div class="cost-item">
<span>
DEX FEES
</span>
<b id="dexFees">
0 U
</b>
</div>

<div class="cost-item">
<span>
SLIPPAGE
</span>
<b id="slippageCosts">
0 U
</b>
</div>

<div class="cost-item">
<span>
GAS / PRIORITY
</span>
<b id="gasCosts">
0 U
</b>
</div>

<div class="cost-item">
<span>
TOTAL
</span>
<b id="allCosts">
0 U
</b>
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
Runner / BE 會顯示
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
<th>High</th>
<th>Stop</th>
<th>Mode</th>

</tr>

</thead>

<tbody id="positions"></tbody>

</table>

</div>

</div>

<div class="panel">

<div class="panel-title">

<h2>
金狗出場模式
</h2>

<span class="small">
保本 + Runner
</span>

</div>

<div class="strategy-grid">

<div class="strategy-item">
<span>
Initial SL
</span>
<b id="strategySl">
-12%
</b>
</div>

<div class="strategy-item">
<span>
+35%
</span>
<b>
出 20%
</b>
</div>

<div class="strategy-item">
<span>
+50%
</span>
<b>
出 20% + BE
</b>
</div>

<div class="strategy-item">
<span>
+100%
</span>
<b>
出 20%
</b>
</div>

<div class="strategy-item">
<span>
Runner
</span>
<b id="strategyTrail">
28% Trail
</b>
</div>

<div class="strategy-item">
<span>
剩餘 Runner
</span>
<b>
40%
</b>
</div>

</div>

<div class="evolution">

<div class="small">
Strategy Evolution
</div>

<div id="evolutionLog"></div>

</div>

</div>

</div>

<div class="panel">

<div class="panel-title">

<h2>
交易紀錄
</h2>

<span class="small">
PnL 已扣實際模擬成本
</span>

</div>

<div class="scroll">

<table>

<thead>

<tr>

<th>Time</th>
<th>Token</th>
<th>Action</th>
<th>Market</th>
<th>Execution</th>
<th>Amount</th>
<th>PnL</th>
<th>Costs</th>
<th>Reason</th>

</tr>

</thead>

<tbody id="trades"></tbody>

</table>

</div>

</div>

</div>

<script>

(function(){

"use strict";

// 沿用舊版本 storage，避免自動歸零
var KEY =
  "memehunter_live_v2";

var START_BALANCE =
  10000;

var SCAN_MS =
  65000;

var EVOLUTION_MS =
  12 * 60 * 60 * 1000;

var DEX_FEE_RATE =
  0.003;

var GAS_FEE_USD =
  0.02;

var MIN_SLIPPAGE =
  0.0025;

var MAX_SLIPPAGE =
  0.02;

var universe =
  [];

var scanning =
  false;

var nextScanAt =
  Date.now() +
  2000;

function byId(id){
  return document.getElementById(id);
}

function clamp(
  value,
  min,
  max
){
  return Math.max(
    min,
    Math.min(
      max,
      value
    )
  );
}

function defaultStrategy(){
  return {
    scoreMin:68,
    ratioMin:1.15,

    positionPct:0.05,

    maxPositions:4,
    maxExposure:0.20,

    stopLoss:0.12,

    firstTp:0.35,
    beTrigger:0.50,
    runnerTrigger:1.00,

    runnerTrail:0.28,

    timeStopMinutes:180
  };
}

function freshState(){
  return {
    cash:10000,

    realized:0,

    positions:{},

    trades:[],

    cooldowns:{},

    costs:{
      dex:0,
      slippage:0,
      gas:0
    },

    equityHistory:[
      {
        time:Date.now(),
        equity:10000
      }
    ],

    strategy:
      defaultStrategy(),

    evolution:{
      lastTime:0,
      lastClosedCount:0,
      history:[]
    }
  };
}

var state;

try{
  state =
    JSON.parse(
      localStorage.getItem(KEY)
    ) ||
    freshState();

}catch(error){
  state =
    freshState();
}

// ============================================================
// MIGRATION
// ============================================================

if(
  typeof state.cash !==
  "number"
){
  state.cash =
    10000;
}

if(
  typeof state.realized !==
  "number"
){
  state.realized =
    0;
}

if(
  !state.positions
){
  state.positions =
    {};
}

if(
  !state.trades
){
  state.trades =
    [];
}

if(
  !state.cooldowns
){
  state.cooldowns =
    {};
}

if(
  !state.equityHistory
){
  state.equityHistory = [
    {
      time:Date.now(),
      equity:10000
    }
  ];
}

if(
  !state.strategy
){
  state.strategy =
    defaultStrategy();
}

state.strategy =
  Object.assign(
    defaultStrategy(),
    state.strategy
  );

if(
  !state.evolution
){
  state.evolution = {
    lastTime:0,
    lastClosedCount:0,
    history:[]
  };
}

if(
  !state.costs
){
  state.costs = {
    // 把舊版 fees 當成 legacy DEX cost
    dex:
      Number(
        state.fees || 0
      ),

    slippage:0,
    gas:0
  };
}

// 舊版 position migration
Object.keys(
  state.positions
).forEach(
  function(address){

    var p =
      state.positions[
        address
      ];

    if(
      !p.initialQty
    ){
      p.initialQty =
        Number(
          p.qty || 0
        );
    }

    if(
      !p.marketEntry
    ){
      p.marketEntry =
        Number(
          p.entry || 0
        );
    }

    if(
      !p.totalCost
    ){
      p.totalCost =
        Number(
          p.qty || 0
        ) *
        Number(
          p.entry || 0
        );
    }

    if(
      typeof p.realizedNetProceeds !==
      "number"
    ){
      p.realizedNetProceeds =
        0;
    }

    if(
      typeof p.firstTpDone !==
      "boolean"
    ){
      p.firstTpDone =
        false;
    }

    if(
      typeof p.beActive !==
      "boolean"
    ){
      p.beActive =
        false;
    }

    if(
      typeof p.runnerActive !==
      "boolean"
    ){
      p.runnerActive =
        false;
    }

    if(
      !p.high
    ){
      p.high =
        p.entry;
    }

    if(
      typeof p.sellPressureCount !==
      "number"
    ){
      p.sellPressureCount =
        0;
    }

  }
);

function save(){
  localStorage.setItem(
    KEY,
    JSON.stringify(
      state
    )
  );
}

function money(value){
  return Number(
    value || 0
  ).toLocaleString(
    undefined,
    {
      minimumFractionDigits:2,
      maximumFractionDigits:2
    }
  );
}

function formatPrice(value){
  var number =
    Number(
      value || 0
    );

  if(!number){
    return "—";
  }

  if(number >= 1){
    return "$" +
      number.toFixed(4);
  }

  return "$" +
    number.toPrecision(6);
}

function color(value){
  if(value > 0){
    return "green";
  }

  if(value < 0){
    return "red";
  }

  return "";
}

function estimateSlippageRate(
  tradeUsd,
  liquidity
){
  var liq =
    Math.max(
      Number(
        liquidity || 0
      ),
      1
    );

  var trade =
    Math.max(
      Number(
        tradeUsd || 0
      ),
      0
    );

  return clamp(
    MIN_SLIPPAGE +
      (
        trade /
        liq
      ) *
      0.35,

    MIN_SLIPPAGE,

    MAX_SLIPPAGE
  );
}

// ============================================================
// STRATEGY SCORE
// ============================================================

function tokenScore(p){
  var score =
    0;

  score +=
    Math.min(
      25,
      p.liquidity /
      6000
    );

  score +=
    Math.min(
      20,
      p.volume1h /
      8000
    );

  score +=
    Math.min(
      15,
      (
        p.buys5m +
        p.sells5m
      ) /
      5
    );

  var ratio =
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

  var hours =
    (
      Date.now() -
      p.createdAt
    ) /
    3600000;

  if(
    hours >= 0.25 &&
    hours <= 24
  ){
    score += 10;

  }else if(
    hours <= 72
  ){
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
  var s =
    state.strategy;

  var score =
    tokenScore(p);

  var reasons =
    [];

  var ageMinutes =
    (
      Date.now() -
      p.createdAt
    ) /
    60000;

  if(
    p.liquidity <
    50000
  ){
    reasons.push(
      "Liquidity"
    );
  }

  if(
    p.volume1h <
    15000
  ){
    reasons.push(
      "Volume"
    );
  }

  if(
    p.buys5m +
    p.sells5m <
    15
  ){
    reasons.push(
      "Activity"
    );
  }

  if(
    ageMinutes <
    5
  ){
    reasons.push(
      "TooNew"
    );
  }

  if(
    p.price5m >
      40 ||
    p.price1h >
      150
  ){
    reasons.push(
      "FOMO"
    );
  }

  if(
    score <
    s.scoreMin
  ){
    reasons.push(
      "Score"
    );
  }

  var ratio =
    p.buys5m /
    Math.max(
      1,
      p.sells5m
    );

  if(
    ratio <
    s.ratioMin
  ){
    reasons.push(
      "BuySell"
    );
  }

  if(
    !reasons.length
  ){
    return {
      score:score,
      decision:"BUY"
    };
  }

  var hard =
    reasons.indexOf(
      "Liquidity"
    ) !== -1 ||
    reasons.indexOf(
      "Volume"
    ) !== -1 ||
    reasons.indexOf(
      "Activity"
    ) !== -1;

  return {
    score:score,
    decision:
      hard
        ? "REJECT"
        : "WATCH"
  };
}

// ============================================================
// MARKET HELPERS
// ============================================================

function findToken(address){
  for(
    var i = 0;
    i < universe.length;
    i++
  ){
    if(
      universe[i].address ===
      address
    ){
      return universe[i];
    }
  }

  return null;
}

function currentPrice(address){
  var token =
    findToken(
      address
    );

  return token
    ? token.price
    : 0;
}

function getEquity(){
  var positionValue =
    0;

  var rawCostRemaining =
    0;

  var keys =
    Object.keys(
      state.positions
    );

  for(
    var i = 0;
    i < keys.length;
    i++
  ){
    var p =
      state.positions[
        keys[i]
      ];

    var px =
      currentPrice(
        p.address
      ) ||
      p.last ||
      p.entry;

    positionValue +=
      p.qty *
      px;

    var ratio =
      p.initialQty
        ? p.qty /
          p.initialQty
        : 1;

    rawCostRemaining +=
      p.totalCost *
      ratio;
  }

  return {
    equity:
      state.cash +
      positionValue,

    positionValue:
      positionValue,

    unrealized:
      positionValue -
      rawCostRemaining
  };
}

function totalCosts(){
  return (
    Number(
      state.costs.dex || 0
    ) +
    Number(
      state.costs.slippage || 0
    ) +
    Number(
      state.costs.gas || 0
    )
  );
}

// ============================================================
// EXECUTION MODEL
// ============================================================

function simulateBuy(
  marketPrice,
  notional,
  liquidity
){
  var slippageRate =
    estimateSlippageRate(
      notional,
      liquidity
    );

  var executionPrice =
    marketPrice *
    (
      1 +
      slippageRate
    );

  var dexFee =
    notional *
    DEX_FEE_RATE;

  var gas =
    GAS_FEE_USD;

  var slippageCost =
    notional *
    slippageRate;

  var qty =
    notional /
    executionPrice;

  return {
    executionPrice:
      executionPrice,

    qty:
      qty,

    dexFee:
      dexFee,

    gas:
      gas,

    slippageRate:
      slippageRate,

    slippageCost:
      slippageCost,

    cashCost:
      notional +
      dexFee +
      gas
  };
}

function simulateSell(
  qty,
  marketPrice,
  liquidity
){
  var marketGross =
    qty *
    marketPrice;

  var slippageRate =
    estimateSlippageRate(
      marketGross,
      liquidity
    );

  var executionPrice =
    marketPrice *
    (
      1 -
      slippageRate
    );

  var executedGross =
    qty *
    executionPrice;

  var dexFee =
    executedGross *
    DEX_FEE_RATE;

  var gas =
    GAS_FEE_USD;

  var net =
    executedGross -
    dexFee -
    gas;

  var slippageCost =
    marketGross -
    executedGross;

  return {
    marketGross:
      marketGross,

    executionPrice:
      executionPrice,

    executedGross:
      executedGross,

    dexFee:
      dexFee,

    gas:
      gas,

    net:
      net,

    slippageRate:
      slippageRate,

    slippageCost:
      slippageCost
  };
}

// ============================================================
// TRADE LOG
// ============================================================

function addTrade(
  action,
  position,
  marketPrice,
  executionPrice,
  amount,
  pnl,
  costs,
  reason
){
  state.trades.unshift({
    time:
      Date.now(),

    symbol:
      position.symbol,

    action:
      action,

    marketPrice:
      marketPrice,

    executionPrice:
      executionPrice,

    amount:
      amount,

    pnl:
      pnl,

    costs:
      costs,

    reason:
      reason,

    maxReturn:
      position.high &&
      position.entry
        ? (
            position.high /
            position.entry -
            1
          )
        : 0
  });

  state.trades =
    state.trades.slice(
      0,
      500
    );
}

// ============================================================
// TRUE BREAK EVEN
// ============================================================

function calculateBreakEvenPrice(
  position,
  market
){
  if(
    !position.qty ||
    position.qty <= 0
  ){
    return (
      position.entry
    );
  }

  var requiredNet =
    position.totalCost -
    position.realizedNetProceeds;

  if(
    requiredNet <= 0
  ){
    return (
      position.entry *
      1.002
    );
  }

  var guess =
    position.entry;

  for(
    var i = 0;
    i < 4;
    i++
  ){
    var gross =
      position.qty *
      guess;

    var slip =
      estimateSlippageRate(
        gross,
        market.liquidity
      );

    var multiplier =
      (
        1 -
        slip
      ) *
      (
        1 -
        DEX_FEE_RATE
      );

    var grossNeeded =
      (
        requiredNet +
        GAS_FEE_USD
      ) /
      Math.max(
        multiplier,
        0.90
      );

    guess =
      grossNeeded /
      position.qty;
  }

  // 至少拉到接近進場價以上
  return Math.max(
    guess,
    position.entry *
    1.003
  );
}

// ============================================================
// CLOSE FIXED % OF ORIGINAL POSITION
// ============================================================

function closeOriginalPortion(
  position,
  originalFraction,
  market,
  reason
){
  var targetQty =
    position.initialQty *
    originalFraction;

  var qty =
    Math.min(
      position.qty,
      targetQty
    );

  return closeExactQty(
    position,
    qty,
    market,
    reason
  );
}

function closeAll(
  position,
  market,
  reason
){
  return closeExactQty(
    position,
    position.qty,
    market,
    reason
  );
}

function closeExactQty(
  position,
  qty,
  market,
  reason
){
  qty =
    Math.min(
      qty,
      position.qty
    );

  if(
    !qty ||
    qty <= 0
  ){
    return;
  }

  var execution =
    simulateSell(
      qty,
      market.price,
      market.liquidity
    );

  var fractionOfOriginal =
    position.initialQty
      ? qty /
        position.initialQty
      : 1;

  var allocatedCost =
    position.totalCost *
    fractionOfOriginal;

  var pnl =
    execution.net -
    allocatedCost;

  state.cash +=
    execution.net;

  state.realized +=
    pnl;

  state.costs.dex +=
    execution.dexFee;

  state.costs.gas +=
    execution.gas;

  state.costs.slippage +=
    execution.slippageCost;

  position.qty -=
    qty;

  position.realizedNetProceeds +=
    execution.net;

  addTrade(
    "SELL",

    position,

    market.price,

    execution.executionPrice,

    execution.executedGross,

    pnl,

    execution.dexFee +
      execution.gas +
      execution.slippageCost,

    reason
  );

  if(
    position.qty <
    0.000000000001
  ){
    delete state.positions[
      position.address
    ];

    state.cooldowns[
      position.address
    ] =
      Date.now() +
      6 *
      3600000;
  }
}

// ============================================================
// MANAGE POSITIONS
// ============================================================

function managePositions(){
  var strategy =
    state.strategy;

  var keys =
    Object.keys(
      state.positions
    );

  for(
    var i = 0;
    i < keys.length;
    i++
  ){
    var position =
      state.positions[
        keys[i]
      ];

    var market =
      findToken(
        position.address
      );

    if(
      !market
    ){
      continue;
    }

    var px =
      market.price;

    position.last =
      px;

    position.high =
      Math.max(
        position.high ||
        position.entry,

        px
      );

    var ret =
      px /
      position.entry -
      1;

    // --------------------------------
    // SELL PRESSURE
    // --------------------------------

    if(
      market.sells5m >=
      market.buys5m *
      2 &&
      market.sells5m >
      20
    ){
      position.sellPressureCount +=
        1;

    }else{
      position.sellPressureCount =
        0;
    }

    if(
      position.sellPressureCount >=
      2
    ){
      closeAll(
        position,
        market,
        "Extreme sell pressure"
      );

      continue;
    }

    // --------------------------------
    // LIQUIDITY COLLAPSE
    // --------------------------------

    if(
      market.liquidity <
      position.entryLiquidity *
      0.60
    ){
      closeAll(
        position,
        market,
        "Liquidity drop >40%"
      );

      continue;
    }

    // --------------------------------
    // BEFORE +50%
    // --------------------------------

    if(
      !position.beActive
    ){
      if(
        ret <=
        -strategy.stopLoss
      ){
        closeAll(
          position,
          market,
          "Initial stop"
        );

        continue;
      }
    }

    // --------------------------------
    // +35% → TAKE 20%
    // --------------------------------

    if(
      !position.firstTpDone &&
      ret >=
      strategy.firstTp
    ){
      closeOriginalPortion(
        position,
        0.20,
        market,
        "+35% take 20%"
      );

      position.firstTpDone =
        true;

      continue;
    }

    // --------------------------------
    // +50% → TAKE 20% + TRUE BE
    // --------------------------------

    if(
      !position.beActive &&
      ret >=
      strategy.beTrigger
    ){
      closeOriginalPortion(
        position,
        0.20,
        market,
        "+50% take 20% / BE activated"
      );

      position.beActive =
        true;

      position.bePrice =
        calculateBreakEvenPrice(
          position,
          market
        );

      continue;
    }

    // --------------------------------
    // +100% → TAKE 20% + RUNNER
    // --------------------------------

    if(
      !position.runnerActive &&
      ret >=
      strategy.runnerTrigger
    ){
      closeOriginalPortion(
        position,
        0.20,
        market,
        "+100% take 20% / Runner activated"
      );

      position.runnerActive =
        true;

      continue;
    }

    // --------------------------------
    // AFTER +50% → BE FLOOR
    // --------------------------------

    if(
      position.beActive
    ){
      position.bePrice =
        calculateBreakEvenPrice(
          position,
          market
        );

      // +50% ~ +100%
      if(
        !position.runnerActive &&
        px <=
        position.bePrice
      ){
        closeAll(
          position,
          market,
          "Break-even stop"
        );

        continue;
      }
    }

    // --------------------------------
    // RUNNER MODE
    // --------------------------------

    if(
      position.runnerActive
    ){
      var trailingStop =
        position.high *
        (
          1 -
          strategy.runnerTrail
        );

      var runnerStop =
        Math.max(
          trailingStop,
          position.bePrice ||
          position.entry
        );

      if(
        px <=
        runnerStop
      ){
        closeAll(
          position,
          market,
          "Golden dog runner trail"
        );

        continue;
      }
    }

    // --------------------------------
    // TIME STOP
    // --------------------------------

    if(
      !position.firstTpDone &&
      Date.now() -
      position.opened >
      strategy.timeStopMinutes *
      60000
    ){
      closeAll(
        position,
        market,
        "Time stop"
      );

      continue;
    }
  }
}

// ============================================================
// ENTRY
// ============================================================

function enterPositions(){
  var strategy =
    state.strategy;

  var equity =
    getEquity();

  var slots =
    strategy.maxPositions -
    Object.keys(
      state.positions
    ).length;

  var room =
    Math.max(
      0,

      equity.equity *
      strategy.maxExposure -
      equity.positionValue
    );

  var candidates =
    [];

  for(
    var i = 0;
    i < universe.length;
    i++
  ){
    var token =
      universe[i];

    var evaluation =
      evaluate(
        token
      );

    if(
      evaluation.decision ===
      "BUY"
    ){
      candidates.push({
        token:
          token,

        evaluation:
          evaluation
      });
    }
  }

  candidates.sort(
    function(a,b){
      return (
        b.evaluation.score -
        a.evaluation.score
      );
    }
  );

  for(
    var c = 0;
    c < candidates.length;
    c++
  ){
    if(
      slots <= 0 ||
      room < 50
    ){
      break;
    }

    var item =
      candidates[c];

    var p =
      item.token;

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

    var notional =
      Math.min(
        equity.equity *
        strategy.positionPct,

        600,

        room,

        state.cash -
        1
      );

    if(
      notional <
      50
    ){
      continue;
    }

    var execution =
      simulateBuy(
        p.price,
        notional,
        p.liquidity
      );

    if(
      state.cash <
      execution.cashCost
    ){
      continue;
    }

    state.cash -=
      execution.cashCost;

    state.costs.dex +=
      execution.dexFee;

    state.costs.gas +=
      execution.gas;

    state.costs.slippage +=
      execution.slippageCost;

    var position = {
      address:
        p.address,

      symbol:
        p.symbol,

      marketEntry:
        p.price,

      entry:
        execution.executionPrice,

      qty:
        execution.qty,

      initialQty:
        execution.qty,

      totalCost:
        execution.cashCost,

      realizedNetProceeds:
        0,

      opened:
        Date.now(),

      entryLiquidity:
        p.liquidity,

      high:
        execution.executionPrice,

      last:
        p.price,

      firstTpDone:
        false,

      beActive:
        false,

      runnerActive:
        false,

      bePrice:
        0,

      sellPressureCount:
        0,

      score:
        item.evaluation.score
    };

    state.positions[
      p.address
    ] =
      position;

    addTrade(
      "BUY",

      position,

      p.price,

      execution.executionPrice,

      notional,

      -(
        execution.dexFee +
        execution.gas +
        execution.slippageCost
      ),

      execution.dexFee +
        execution.gas +
        execution.slippageCost,

      "Entry Score " +
      item.evaluation.score
    );

    slots -=
      1;

    room -=
      notional;
  }
}

// ============================================================
// STRATEGY EVOLUTION
// ============================================================

function maybeEvolveStrategy(){
  var sells =
    state.trades.filter(
      function(trade){
        return (
          trade.action ===
          "SELL"
        );
      }
    );

  if(
    sells.length <
    8
  ){
    return;
  }

  if(
    Date.now() -
    state.evolution.lastTime <
    EVOLUTION_MS
  ){
    return;
  }

  var newClosed =
    sells.length -
    state.evolution.lastClosedCount;

  if(
    state.evolution.lastTime &&
    newClosed <
    3
  ){
    return;
  }

  var sample =
    sells.slice(
      0,
      20
    );

  var wins =
    sample.filter(
      function(trade){
        return (
          trade.pnl > 0
        );
      }
    );

  var total =
    sample.reduce(
      function(sum,trade){
        return (
          sum +
          Number(
            trade.pnl || 0
          )
        );
      },
      0
    );

  var winRate =
    wins.length /
    sample.length;

  var avgPnl =
    total /
    sample.length;

  var before =
    JSON.parse(
      JSON.stringify(
        state.strategy
      )
    );

  var strategy =
    state.strategy;

  var reason =
    "";

  if(
    winRate <
      0.40 ||
    avgPnl <
      -3
  ){
    // DEFENSIVE
    strategy.scoreMin =
      clamp(
        strategy.scoreMin + 2,
        65,
        82
      );

    strategy.ratioMin =
      clamp(
        strategy.ratioMin + 0.05,
        1.10,
        1.45
      );

    strategy.positionPct =
      clamp(
        strategy.positionPct - 0.005,
        0.03,
        0.06
      );

    strategy.stopLoss =
      clamp(
        strategy.stopLoss - 0.01,
        0.08,
        0.14
      );

    strategy.runnerTrail =
      clamp(
        strategy.runnerTrail - 0.02,
        0.22,
        0.32
      );

    reason =
      "Defensive";

  }else if(
    winRate >=
      0.60 &&
    avgPnl >
      3 &&
    maxDrawdown() <
      8
  ){
    // EXPANSION
    strategy.scoreMin =
      clamp(
        strategy.scoreMin - 1,
        65,
        82
      );

    strategy.ratioMin =
      clamp(
        strategy.ratioMin - 0.02,
        1.10,
        1.45
      );

    strategy.positionPct =
      clamp(
        strategy.positionPct + 0.005,
        0.03,
        0.06
      );

    strategy.runnerTrail =
      clamp(
        strategy.runnerTrail + 0.01,
        0.22,
        0.32
      );

    reason =
      "Expansion";

  }else{
    if(
      winRate <
      0.50
    ){
      strategy.scoreMin =
        clamp(
          strategy.scoreMin + 1,
          65,
          82
        );

      reason =
        "Quality filter";

    }else{
      strategy.ratioMin =
        clamp(
          strategy.ratioMin - 0.01,
          1.10,
          1.45
        );

      reason =
        "Fine tune";
    }
  }

  state.evolution.lastTime =
    Date.now();

  state.evolution.lastClosedCount =
    sells.length;

  state.evolution.history.unshift({
    time:
      Date.now(),

    sample:
      sample.length,

    winRate:
      winRate,

    avgPnl:
      avgPnl,

    reason:
      reason,

    before:
      before,

    after:
      JSON.parse(
        JSON.stringify(
          strategy
        )
      )
  });

  state.evolution.history =
    state.evolution.history.slice(
      0,
      30
    );

  save();
}

// ============================================================
// EQUITY / DD
// ============================================================

function recordEquity(){
  var value =
    getEquity()
      .equity;

  var history =
    state.equityHistory;

  var last =
    history[
      history.length - 1
    ];

  if(
    !last ||
    Math.abs(
      last.equity -
      value
    ) >
    0.01 ||
    Date.now() -
    last.time >
    300000
  ){
    history.push({
      time:
        Date.now(),

      equity:
        value
    });
  }

  if(
    history.length >
    2000
  ){
    state.equityHistory =
      history.slice(
        -2000
      );
  }
}

function maxDrawdown(){
  var peak =
    0;

  var maximum =
    0;

  for(
    var i = 0;
    i <
    state.equityHistory.length;
    i++
  ){
    var value =
      state.equityHistory[
        i
      ].equity;

    peak =
      Math.max(
        peak,
        value
      );

    if(peak){
      maximum =
        Math.max(
          maximum,

          (
            peak -
            value
          ) /
          peak
        );
    }
  }

  return (
    maximum *
    100
  );
}

// ============================================================
// SCAN
// ============================================================

async function scan(){
  if(scanning){
    return;
  }

  scanning =
    true;

  byId(
    "scanBtn"
  ).disabled =
    true;

  byId(
    "scanBtn"
  ).textContent =
    "Scanning...";

  var errorBox =
    byId(
      "error"
    );

  var warningBox =
    byId(
      "warning"
    );

  errorBox.style.display =
    "none";

  warningBox.style.display =
    "none";

  try{
    var positionAddresses =
      Object.keys(
        state.positions
      );

    var request =
      "/api/market";

    if(
      positionAddresses.length
    ){
      request +=
        "?positions=" +
        encodeURIComponent(
          positionAddresses.join(
            ","
          )
        );
    }

    request +=
      (
        request.indexOf("?") === -1
          ? "?"
          : "&"
      ) +
      "t=" +
      Date.now();

    var response =
      await fetch(
        request,
        {
          cache:
            "no-store"
        }
      );

    if(
      !response.ok
    ){
      var text =
        await response.text();

      throw new Error(
        "HTTP " +
        response.status +
        " " +
        text
      );
    }

    var result =
      await response.json();

    if(
      !result ||
      !Array.isArray(
        result.tokens
      )
    ){
      throw new Error(
        "Invalid market response"
      );
    }

    universe =
      result.tokens;

    if(
      result.stale
    ){
      warningBox.textContent =
        "Discovery 暫時失敗，目前沿用上一批市場資料；持倉價格仍會獨立更新。";

      warningBox.style.display =
        "block";
    }

    managePositions();

    enterPositions();

    recordEquity();

    maybeEvolveStrategy();

    save();

    render();

    byId(
      "lastScan"
    ).textContent =
      "Last scan " +
      new Date()
        .toLocaleTimeString();

  }catch(error){
    console.error(
      error
    );

    errorBox.textContent =
      "行情抓取失敗：" +
      error.message;

    errorBox.style.display =
      "block";

  }finally{
    scanning =
      false;

    nextScanAt =
      Date.now() +
      SCAN_MS;

    byId(
      "scanBtn"
    ).disabled =
      false;

    byId(
      "scanBtn"
    ).textContent =
      "Scan Now";
  }
}

// ============================================================
// RENDER
// ============================================================

function render(){
  var equity =
    getEquity();

  var totalPnl =
    equity.equity -
    START_BALANCE;

  byId(
    "equity"
  ).textContent =
    money(
      equity.equity
    ) +
    " U";

  byId(
    "cash"
  ).textContent =
    money(
      state.cash
    ) +
    " U";

  var total =
    byId(
      "totalPnl"
    );

  total.textContent =
    (
      totalPnl >= 0
        ? "+"
        : ""
    ) +
    money(
      totalPnl
    ) +
    " U";

  total.className =
    "value " +
    color(
      totalPnl
    );

  var realized =
    byId(
      "realized"
    );

  realized.textContent =
    (
      state.realized >= 0
        ? "+"
        : ""
    ) +
    money(
      state.realized
    ) +
    " U";

  realized.className =
    "value " +
    color(
      state.realized
    );

  var unrealized =
    byId(
      "unrealized"
    );

  unrealized.textContent =
    (
      equity.unrealized >= 0
        ? "+"
        : ""
    ) +
    money(
      equity.unrealized
    ) +
    " U";

  unrealized.className =
    "value " +
    color(
      equity.unrealized
    );

  var sellTrades =
    state.trades.filter(
      function(trade){
        return (
          trade.action ===
          "SELL"
        );
      }
    );

  var wins =
    sellTrades.filter(
      function(trade){
        return (
          trade.pnl > 0
        );
      }
    ).length;

  byId(
    "winRate"
  ).textContent =
    sellTrades.length
      ? (
          wins /
          sellTrades.length *
          100
        ).toFixed(1) +
        "%"
      : "—";

  byId(
    "maxDd"
  ).textContent =
    maxDrawdown()
      .toFixed(1) +
    "%";

  byId(
    "openCount"
  ).textContent =
    Object.keys(
      state.positions
    ).length;

  // ---------------------------------
  // COSTS
  // ---------------------------------

  var costs =
    totalCosts();

  byId(
    "dexFees"
  ).textContent =
    money(
      state.costs.dex
    ) +
    " U";

  byId(
    "slippageCosts"
  ).textContent =
    money(
      state.costs.slippage
    ) +
    " U";

  byId(
    "gasCosts"
  ).textContent =
    money(
      state.costs.gas
    ) +
    " U";

  byId(
    "allCosts"
  ).textContent =
    money(
      costs
    ) +
    " U";

  byId(
    "totalCosts"
  ).textContent =
    money(
      costs
    ) +
    " U";

  byId(
    "exposure"
  ).textContent =
    (
      equity.positionValue /
      Math.max(
        equity.equity,
        1
      ) *
      100
    ).toFixed(1) +
    "%";

  var evaluations =
    universe.map(
      function(token){
        return {
          token:
            token,

          evaluation:
            evaluate(
              token
            )
        };
      }
    );

  byId(
    "tokenCount"
  ).textContent =
    universe.length +
    " tokens";

  var candidates =
    evaluations.filter(
      function(item){
        return (
          item.evaluation
            .decision ===
          "BUY"
        );
      }
    );

  byId(
    "candidateCount"
  ).textContent =
    candidates.length;

  var best =
    0;

  for(
    var i = 0;
    i <
    evaluations.length;
    i++
  ){
    best =
      Math.max(
        best,

        evaluations[i]
          .evaluation
          .score
      );
  }

  byId(
    "bestScore"
  ).textContent =
    evaluations.length
      ? best
      : "—";

  byId(
    "tradeCount"
  ).textContent =
    state.trades.length;

  byId(
    "strategySl"
  ).textContent =
    "-" +
    (
      state.strategy.stopLoss *
      100
    ).toFixed(0) +
    "%";

  byId(
    "strategyTrail"
  ).textContent =
    (
      state.strategy.runnerTrail *
      100
    ).toFixed(0) +
    "% Trail";

  // ---------------------------------
  // FEED
  // ---------------------------------

  evaluations.sort(
    function(a,b){
      return (
        b.evaluation.score -
        a.evaluation.score
      );
    }
  );

  var feedRows =
    [];

  for(
    var f = 0;
    f <
    Math.min(
      evaluations.length,
      50
    );
    f++
  ){
    var item =
      evaluations[f];

    var p =
      item.token;

    var e =
      item.evaluation;

    var decisionClass =
      e.decision ===
      "BUY"
        ? "green"
        : (
            e.decision ===
            "REJECT"
              ? "red"
              : "yellow"
          );

    var ratio =
      p.buys5m /
      Math.max(
        1,
        p.sells5m
      );

    feedRows.push(
      "<tr>" +

      "<td>" +
      '<a target="_blank" href="' +
      p.url +
      '">' +
      "<b>" +
      p.symbol +
      "</b>" +
      "</a>" +
      "</td>" +

      "<td>" +
      ageFromTimestamp(
        p.createdAt
      ) +
      "</td>" +

      "<td>" +
      formatPrice(
        p.price
      ) +
      "</td>" +

      "<td>$" +
      money(
        p.liquidity /
        1000
      ) +
      "k</td>" +

      "<td>$" +
      money(
        p.volume5m /
        1000
      ) +
      "k</td>" +

      "<td>$" +
      money(
        p.volume1h /
        1000
      ) +
      "k</td>" +

      "<td>" +
      ratio.toFixed(2) +
      "</td>" +

      '<td class="' +
      color(
        p.price5m
      ) +
      '">' +
      p.price5m.toFixed(1) +
      "%</td>" +

      '<td class="' +
      color(
        p.price1h
      ) +
      '">' +
      p.price1h.toFixed(1) +
      "%</td>" +

      "<td><b>" +
      e.score +
      "</b></td>" +

      '<td class="' +
      decisionClass +
      '">' +
      e.decision +
      "</td>" +

      "</tr>"
    );
  }

  byId(
    "feed"
  ).innerHTML =
    feedRows.join("") ||
    (
      "<tr>" +
      '<td colspan="11">' +
      "尚未取得行情" +
      "</td>" +
      "</tr>"
    );

  // ---------------------------------
  // POSITIONS
  // ---------------------------------

  var positionRows =
    [];

  var positionKeys =
    Object.keys(
      state.positions
    );

  for(
    var x = 0;
    x <
    positionKeys.length;
    x++
  ){
    var position =
      state.positions[
        positionKeys[x]
      ];

    var market =
      findToken(
        position.address
      );

    var px =
      market
        ? market.price
        : (
            position.last ||
            position.entry
          );

    var rawValue =
      position.qty *
      px;

    var remainingRatio =
      position.initialQty
        ? position.qty /
          position.initialQty
        : 1;

    var remainingCost =
      position.totalCost *
      remainingRatio;

    var pnl =
      rawValue -
      remainingCost;

    var highReturn =
      position.entry
        ? (
            position.high /
            position.entry -
            1
          ) *
          100
        : 0;

    var stopText =
      "-";

    var mode =
      "NORMAL";

    if(
      position.runnerActive
    ){
      mode =
        "RUNNER";

      var runnerStop =
        Math.max(
          position.bePrice ||
          position.entry,

          position.high *
          (
            1 -
            state.strategy.runnerTrail
          )
        );

      stopText =
        formatPrice(
          runnerStop
        );

    }else if(
      position.beActive
    ){
      mode =
        "BE";

      stopText =
        formatPrice(
          position.bePrice
        );

    }else{
      stopText =
        formatPrice(
          position.entry *
          (
            1 -
            state.strategy.stopLoss
          )
        );
    }

    positionRows.push(
      "<tr>" +

      "<td><b>" +
      position.symbol +
      "</b></td>" +

      "<td>" +
      formatPrice(
        position.entry
      ) +
      "</td>" +

      "<td>" +
      formatPrice(
        px
      ) +
      "</td>" +

      "<td>" +
      money(
        rawValue
      ) +
      " U</td>" +

      '<td class="' +
      color(
        pnl
      ) +
      '">' +
      (
        pnl >= 0
          ? "+"
          : ""
      ) +
      money(
        pnl
      ) +
      " U</td>" +

      "<td>+" +
      highReturn.toFixed(1) +
      "%</td>" +

      "<td>" +
      stopText +
      "</td>" +

      "<td>" +
      mode +
      "</td>" +

      "</tr>"
    );
  }

  byId(
    "positions"
  ).innerHTML =
    positionRows.join("") ||
    (
      "<tr>" +
      '<td colspan="8">' +
      "目前沒有持倉" +
      "</td>" +
      "</tr>"
    );

  // ---------------------------------
  // TRADES
  // ---------------------------------

  var tradeRows =
    [];

  for(
    var t = 0;
    t <
    Math.min(
      state.trades.length,
      100
    );
    t++
  ){
    var trade =
      state.trades[t];

    // migration for old log
    var marketPrice =
      trade.marketPrice ||
      trade.price ||
      0;

    var executionPrice =
      trade.executionPrice ||
      trade.price ||
      0;

    tradeRows.push(
      "<tr>" +

      "<td>" +
      new Date(
        trade.time
      ).toLocaleString() +
      "</td>" +

      "<td><b>" +
      trade.symbol +
      "</b></td>" +

      "<td>" +
      trade.action +
      "</td>" +

      "<td>" +
      formatPrice(
        marketPrice
      ) +
      "</td>" +

      "<td>" +
      formatPrice(
        executionPrice
      ) +
      "</td>" +

      "<td>" +
      money(
        trade.amount
      ) +
      " U</td>" +

      '<td class="' +
      color(
        trade.pnl
      ) +
      '">' +
      (
        trade.pnl >= 0
          ? "+"
          : ""
      ) +
      money(
        trade.pnl
      ) +
      " U</td>" +

      "<td>" +
      money(
        trade.costs ||
        0
      ) +
      " U</td>" +

      "<td>" +
      trade.reason +
      "</td>" +

      "</tr>"
    );
  }

  byId(
    "trades"
  ).innerHTML =
    tradeRows.join("") ||
    (
      "<tr>" +
      '<td colspan="9">' +
      "尚無交易" +
      "</td>" +
      "</tr>"
    );

  renderEvolution();

  drawChart();
}

function ageFromTimestamp(timestamp){
  var seconds =
    Math.max(
      0,

      (
        Date.now() -
        timestamp
      ) /
      1000
    );

  if(
    seconds <
    3600
  ){
    return (
      Math.floor(
        seconds /
        60
      ) +
      "m"
    );
  }

  if(
    seconds <
    86400
  ){
    return (
      (
        seconds /
        3600
      ).toFixed(1) +
      "h"
    );
  }

  return (
    (
      seconds /
      86400
    ).toFixed(1) +
    "d"
  );
}

// ============================================================
// EVOLUTION DISPLAY
// ============================================================

function renderEvolution(){
  var history =
    state.evolution.history;

  if(
    !history.length
  ){
    byId(
      "evolutionLog"
    ).innerHTML =
      '<div class="evolution-entry">' +
      "等待至少 8 筆 SELL 紀錄後開始自動調參。" +
      "</div>";

    return;
  }

  var rows =
    [];

  for(
    var i = 0;
    i <
    Math.min(
      history.length,
      5
    );
    i++
  ){
    var e =
      history[i];

    rows.push(
      '<div class="evolution-entry">' +

      "<b>" +
      new Date(
        e.time
      ).toLocaleString() +
      "</b><br>" +

      e.reason +

      "｜Win " +
      (
        e.winRate *
        100
      ).toFixed(1) +
      "%" +

      "｜Avg " +
      money(
        e.avgPnl
      ) +
      "U" +

      "<br>Score " +
      e.before.scoreMin +
      " → " +
      e.after.scoreMin +

      "｜B/S " +
      e.before.ratioMin
        .toFixed(2) +
      " → " +
      e.after.ratioMin
        .toFixed(2) +

      "｜Size " +
      (
        e.before.positionPct *
        100
      ).toFixed(1) +
      "% → " +
      (
        e.after.positionPct *
        100
      ).toFixed(1) +
      "%" +

      "</div>"
    );
  }

  byId(
    "evolutionLog"
  ).innerHTML =
    rows.join("");
}

// ============================================================
// CHART
// ============================================================

function drawChart(){
  var canvas =
    byId(
      "equityChart"
    );

  var context =
    canvas.getContext(
      "2d"
    );

  var width =
    canvas.width;

  var height =
    canvas.height;

  context.clearRect(
    0,
    0,
    width,
    height
  );

  var data =
    state.equityHistory;

  if(
    !data.length
  ){
    return;
  }

  var values =
    data.map(
      function(item){
        return (
          item.equity
        );
      }
    );

  var minimum =
    Math.min.apply(
      null,
      values
    );

  var maximum =
    Math.max.apply(
      null,
      values
    );

  if(
    maximum -
    minimum <
    1
  ){
    minimum -= 10;
    maximum += 10;
  }

  context.strokeStyle =
    "#31e986";

  context.lineWidth =
    2;

  context.beginPath();

  for(
    var i = 0;
    i < data.length;
    i++
  ){
    var x =
      10 +
      (
        width -
        20
      ) *
      (
        i /
        Math.max(
          1,
          data.length - 1
        )
      );

    var y =
      height -
      10 -
      (
        height -
        20
      ) *
      (
        (
          data[i].equity -
          minimum
        ) /
        (
          maximum -
          minimum
        )
      );

    if(
      i === 0
    ){
      context.moveTo(
        x,
        y
      );

    }else{
      context.lineTo(
        x,
        y
      );
    }
  }

  context.stroke();
}

// ============================================================
// RESET
// ============================================================

function resetAccount(){
  if(
    !confirm(
      "確定清除所有模擬交易與策略資料，重新從 10,000U 開始？"
    )
  ){
    return;
  }

  state =
    freshState();

  save();

  render();
}

// ============================================================
// EVENTS
// ============================================================

byId(
  "scanBtn"
).addEventListener(
  "click",
  scan
);

byId(
  "resetBtn"
).addEventListener(
  "click",
  resetAccount
);

setInterval(
  function(){

    var remaining =
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

    byId(
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

save();

render();

setTimeout(
  scan,
  500
);

})();

</script>

</body>
</html>
`;

// ============================================================
// SERVER
// ============================================================

const server =
  http.createServer(
    async function(
      req,
      res
    ){
      try{
        const url =
          new URL(
            req.url,
            "http://localhost"
          );

        if(
          url.pathname ===
          "/health"
        ){
          res.writeHead(
            200,
            {
              "content-type":
                "application/json"
            }
          );

          return res.end(
            JSON.stringify({
              ok:true
            })
          );
        }

        if(
          url.pathname ===
          "/api/market"
        ){
          try{
            const raw =
              url.searchParams.get(
                "positions"
              ) || "";

            const positions =
              raw
                .split(",")
                .map(
                  function(item){
                    return (
                      item.trim()
                    );
                  }
                )
                .filter(Boolean)
                .slice(
                  0,
                  20
                );

            const data =
              await getMarketData(
                positions
              );

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

          }catch(error){
            console.error(
              "Market API error:",
              error
            );

            res.writeHead(
              502,
              {
                "content-type":
                  "application/json; charset=utf-8",

                "cache-control":
                  "no-store"
              }
            );

            return res.end(
              JSON.stringify({
                error:
                  error.message ||
                  String(error)
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

      }catch(error){
        console.error(
          error
        );

        res.writeHead(
          500,
          {
            "content-type":
              "text/plain; charset=utf-8"
          }
        );

        return res.end(
          String(error)
        );
      }
    }
  );

server.listen(
  PORT,
  "0.0.0.0",
  function(){
    console.log(
      "MemeHunter Golden Dog running on port",
      PORT
    );
  }
);
