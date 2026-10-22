const http = require("http");

const PORT = process.env.PORT || 10000;

const CACHE_MS = 60000;

let discoveryCache = {
  time: 0,
  tokens: []
};

// ============================================================
// DEX SCREENER
// ============================================================

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
      "User-Agent": "MemeHunter-Paper-Trader/2.0"
    }
  });

  if (!response.ok) {
    throw new Error(
      "DEX Screener HTTP " + response.status
    );
  }

  return response.json();
}

async function fetchPairsByAddresses(addresses) {
  const unique = [
    ...new Set(
      addresses.filter(Boolean)
    )
  ];

  let rawPairs = [];

  for (let i = 0; i < unique.length; i += 30) {
    const batch =
      unique.slice(i, i + 30);

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
    if (pair.chainId !== "solana") continue;
    if (!pair.baseToken) continue;
    if (!pair.baseToken.address) continue;
    if (!pair.priceUsd) continue;

    const address =
      pair.baseToken.address;

    const liquidity =
      Number(
        pair.liquidity?.usd || 0
      );

    const old =
      bestPairs.get(address);

    const oldLiquidity =
      old
        ? Number(
            old.liquidity?.usd || 0
          )
        : 0;

    if (
      !old ||
      liquidity > oldLiquidity
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
      pair.baseToken?.address || "",

    pairAddress:
      pair.pairAddress || "",

    symbol:
      pair.baseToken?.symbol || "?",

    name:
      pair.baseToken?.name ||
      pair.baseToken?.symbol ||
      "?",

    price:
      Number(
        pair.priceUsd || 0
      ),

    liquidity:
      Number(
        pair.liquidity?.usd || 0
      ),

    volume5m:
      Number(
        pair.volume?.m5 || 0
      ),

    volume1h:
      Number(
        pair.volume?.h1 || 0
      ),

    buys5m:
      Number(
        pair.txns?.m5?.buys || 0
      ),

    sells5m:
      Number(
        pair.txns?.m5?.sells || 0
      ),

    price5m:
      Number(
        pair.priceChange?.m5 || 0
      ),

    price1h:
      Number(
        pair.priceChange?.h1 || 0
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
            item =>
              item &&
              item.chainId ===
                "solana" &&
              item.tokenAddress
          )
          .map(
            item =>
              item.tokenAddress
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
      pairs.map(normalizePair);

    if (!tokens.length) {
      throw new Error(
        "No Solana market pairs returned"
      );
    }

    discoveryCache = {
      time:
        Date.now(),

      tokens
    };

    return {
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
  const discovery =
    await discoverTokens();

  let positionTokens = [];

  if (
    positionAddresses.length
  ) {
    const positionPairs =
      await fetchPairsByAddresses(
        positionAddresses
      );

    positionTokens =
      positionPairs.map(
        normalizePair
      );
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

  // 持倉資料優先使用最新刷新結果
  for (
    const token
    of positionTokens
  ) {
    combined.set(
      token.address,
      token
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
// FRONTEND
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

<title>MemeHunter Live</title>

<style>

* {
  box-sizing:border-box;
}

body {
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

.wrap {
  max-width:1500px;
  margin:auto;
  padding:18px;
}

.top {
  display:flex;
  gap:12px;
  align-items:center;
  flex-wrap:wrap;
}

h1 {
  margin:0;
  font-size:23px;
}

.spacer {
  flex:1;
}

.badge {
  color:#31e986;
  border:1px solid #17643d;
  background:#0b2518;
  padding:5px 9px;
  border-radius:999px;
  font-size:11px;
}

.status {
  color:#31e986;
}

button {
  padding:9px 14px;
  border-radius:8px;
  border:1px solid #33404a;
  background:#162029;
  color:#fff;
  cursor:pointer;
}

button:hover {
  border-color:#60717e;
}

button:disabled {
  opacity:.6;
  cursor:default;
}

.note,
.warning {
  margin-top:14px;
  border-radius:9px;
  padding:11px 13px;
  font-size:12px;
}

.note {
  background:#0f151b;
  border:1px solid #27323b;
  color:#9cabb7;
}

.warning {
  display:none;
  background:#2a2110;
  border:1px solid #68531b;
  color:#f4c96e;
}

.error {
  display:none;
  margin-top:12px;
  background:#2b1116;
  border:1px solid #6d3038;
  color:#ff98a3;
  padding:11px;
  border-radius:8px;
}

.grid {
  display:grid;
  gap:12px;
}

.kpis {
  grid-template-columns:
    repeat(
      8,
      minmax(120px,1fr)
    );

  margin-top:14px;
}

.card,
.panel {
  background:#10161c;
  border:1px solid #26313a;
  border-radius:10px;
}

.card {
  padding:14px;
}

.panel {
  margin-top:14px;
  padding:14px;
}

.label {
  color:#8ca0af;
  font-size:11px;
}

.value {
  margin-top:5px;
  font-size:21px;
  font-weight:800;
}

.green {
  color:#31e986;
}

.red {
  color:#ff6877;
}

.yellow {
  color:#f2bc59;
}

.panel-title {
  display:flex;
  justify-content:
    space-between;

  align-items:center;
  gap:10px;
  margin-bottom:10px;
}

.panel-title h2 {
  margin:0;
  font-size:16px;
}

.small {
  font-size:11px;
  color:#8999a6;
}

.two {
  grid-template-columns:
    1.3fr .7fr;
}

.stats {
  display:grid;
  grid-template-columns:
    1fr 1fr;
  gap:8px;
}

.stat {
  padding:10px;
  background:#141c23;
  border-radius:7px;
}

.stat b {
  float:right;
}

.scroll {
  overflow:auto;
  max-height:470px;
}

table {
  width:100%;
  border-collapse:collapse;
  font-size:12px;
}

th,
td {
  text-align:left;
  padding:9px;
  border-bottom:
    1px solid #202a32;
  white-space:nowrap;
}

th {
  color:#8ca0af;
}

a {
  color:#8fcaff;
  text-decoration:none;
}

canvas {
  width:100%;
  height:170px;
  background:#0a0f13;
  border-radius:7px;
}

.strategy-grid {
  display:grid;
  grid-template-columns:
    repeat(3,1fr);
  gap:7px;
  margin-top:10px;
}

.strategy-item {
  background:#141c23;
  padding:9px;
  border-radius:7px;
}

.strategy-item span {
  color:#8999a6;
  font-size:10px;
}

.strategy-item b {
  display:block;
  margin-top:3px;
}

.evolution {
  margin-top:10px;
  padding:10px;
  border:1px solid #27323b;
  border-radius:8px;
  background:#0d1318;
}

.evolution-entry {
  padding:8px 0;
  border-bottom:
    1px solid #1e272e;
  font-size:11px;
  line-height:1.6;
}

.evolution-entry:last-child {
  border-bottom:0;
}

@media(max-width:1100px) {

  .kpis {
    grid-template-columns:
      repeat(4,1fr);
  }

  .two {
    grid-template-columns:1fr;
  }

  .strategy-grid {
    grid-template-columns:
      repeat(2,1fr);
  }
}

@media(max-width:650px) {

  .kpis {
    grid-template-columns:
      repeat(2,1fr);
  }

  .strategy-grid {
    grid-template-columns:1fr;
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
真實 Solana DEX 行情 + 10,000U 模擬資金。
網站開著時自動掃描、管理持倉與 Strategy Evolution。
不連接錢包、不使用真錢。
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
模擬成本
<b id="fees">
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
Strategy Evolution
</h2>

<span class="small">
自動調參 • 有風控上限
</span>

</div>

<div class="strategy-grid">

<div class="strategy-item">
<span>
Score 門檻
</span>
<b id="strategyScore">
68
</b>
</div>

<div class="strategy-item">
<span>
Buy / Sell
</span>
<b id="strategyRatio">
1.15
</b>
</div>

<div class="strategy-item">
<span>
單筆倉位
</span>
<b id="strategySize">
5.0%
</b>
</div>

<div class="strategy-item">
<span>
Stop Loss
</span>
<b id="strategySl">
-10%
</b>
</div>

<div class="strategy-item">
<span>
TP1
</span>
<b id="strategyTp1">
+15%
</b>
</div>

<div class="strategy-item">
<span>
TP2
</span>
<b id="strategyTp2">
+30%
</b>
</div>

</div>

<div class="evolution">

<div class="small">
最近策略調整
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

(function () {

"use strict";

var KEY =
  "memehunter_live_evolution_v1";

var START_BALANCE =
  10000;

var SCAN_MS =
  65000;

var EVOLUTION_MS =
  12 * 60 * 60 * 1000;

var universe =
  [];

var scanning =
  false;

var nextScanAt =
  Date.now() + 2000;

function byId(id) {
  return document.getElementById(id);
}

function defaultStrategy() {
  return {
    scoreMin:68,
    ratioMin:1.15,
    positionPct:0.05,
    stopLoss:0.10,
    tp1:0.15,
    tp2:0.30,
    maxPositions:4,
    maxExposure:0.20
  };
}

function freshState() {
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

try {
  state =
    JSON.parse(
      localStorage.getItem(KEY)
    ) ||
    freshState();
} catch (error) {
  state =
    freshState();
}

// 舊資料缺欄位時補齊
if (!state.strategy) {
  state.strategy =
    defaultStrategy();
}

if (!state.evolution) {
  state.evolution = {
    lastTime:0,
    lastClosedCount:0,
    history:[]
  };
}

function save() {
  localStorage.setItem(
    KEY,
    JSON.stringify(state)
  );
}

function money(value) {
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

function formatPrice(value) {
  var number =
    Number(value || 0);

  if (!number) {
    return "—";
  }

  if (number >= 1) {
    return "$" +
      number.toFixed(4);
  }

  return "$" +
    number.toPrecision(5);
}

function color(value) {
  if (value > 0) {
    return "green";
  }

  if (value < 0) {
    return "red";
  }

  return "";
}

function age(timestamp) {
  var seconds =
    Math.max(
      0,
      (
        Date.now() -
        timestamp
      ) /
      1000
    );

  if (seconds < 3600) {
    return (
      Math.floor(
        seconds /
        60
      ) +
      "m"
    );
  }

  if (seconds < 86400) {
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

function clamp(
  value,
  minimum,
  maximum
) {
  return Math.max(
    minimum,
    Math.min(
      maximum,
      value
    )
  );
}

function tokenScore(p) {
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

  if (
    p.price5m > 0 &&
    p.price5m < 40
  ) {
    score += 8;
  }

  if (
    p.price1h > 0 &&
    p.price1h < 150
  ) {
    score += 7;
  }

  var hours =
    (
      Date.now() -
      p.createdAt
    ) /
    3600000;

  if (
    hours >= 0.25 &&
    hours <= 24
  ) {
    score += 10;
  } else if (
    hours <= 72
  ) {
    score += 6;
  }

  return Math.round(
    Math.min(
      100,
      score
    )
  );
}

function evaluate(p) {
  var strategy =
    state.strategy;

  var score =
    tokenScore(p);

  var reasons =
    [];

  var pairMinutes =
    (
      Date.now() -
      p.createdAt
    ) /
    60000;

  if (
    p.liquidity <
    50000
  ) {
    reasons.push(
      "Liquidity"
    );
  }

  if (
    p.volume1h <
    15000
  ) {
    reasons.push(
      "Volume"
    );
  }

  if (
    (
      p.buys5m +
      p.sells5m
    ) <
    15
  ) {
    reasons.push(
      "Activity"
    );
  }

  if (
    pairMinutes <
    5
  ) {
    reasons.push(
      "TooNew"
    );
  }

  if (
    p.price5m >
    40 ||
    p.price1h >
    150
  ) {
    reasons.push(
      "FOMO"
    );
  }

  if (
    score <
    strategy.scoreMin
  ) {
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

  if (
    ratio <
    strategy.ratioMin
  ) {
    reasons.push(
      "BuySell"
    );
  }

  if (!reasons.length) {
    return {
      score,
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
    score,
    decision:
      hard
        ? "REJECT"
        : "WATCH"
  };
}

function findToken(address) {
  for (
    var i = 0;
    i < universe.length;
    i++
  ) {
    if (
      universe[i].address ===
      address
    ) {
      return universe[i];
    }
  }

  return null;
}

function currentPrice(address) {
  var token =
    findToken(address);

  return token
    ? token.price
    : 0;
}

function getEquity() {
  var positionValue =
    0;

  var cost =
    0;

  var keys =
    Object.keys(
      state.positions
    );

  for (
    var i = 0;
    i < keys.length;
    i++
  ) {
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
  position,
  px,
  amount,
  pnl,
  reason
) {
  state.trades.unshift({
    time:
      Date.now(),

    symbol:
      position.symbol,

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
  position,
  fraction,
  px,
  reason
) {
  var qty =
    Math.min(
      position.qty,
      position.qty *
      fraction
    );

  var gross =
    qty *
    px;

  var fee =
    gross *
    0.005;

  var proceeds =
    gross -
    fee;

  var basis =
    qty *
    position.entry;

  var pnl =
    proceeds -
    basis;

  state.cash +=
    proceeds;

  state.fees +=
    fee;

  state.realized +=
    pnl;

  position.qty -=
    qty;

  addTrade(
    "SELL",
    position,
    px,
    gross,
    pnl,
    reason
  );

  if (
    position.qty <
    0.000000000001
  ) {
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

function managePositions() {
  var strategy =
    state.strategy;

  var keys =
    Object.keys(
      state.positions
    );

  for (
    var i = 0;
    i < keys.length;
    i++
  ) {
    var position =
      state.positions[
        keys[i]
      ];

    var market =
      findToken(
        position.address
      );

    if (!market) {
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

    if (
      ret <=
      -strategy.stopLoss
    ) {
      closePosition(
        position,
        1,
        px,
        "Hard stop"
      );

      continue;
    }

    if (
      market.liquidity <
      position.entryLiquidity *
      0.65
    ) {
      closePosition(
        position,
        1,
        px,
        "Liquidity drop"
      );

      continue;
    }

    if (
      !position.tp1 &&
      ret >=
      strategy.tp1
    ) {
      closePosition(
        position,
        0.40,
        px,
        "TP1"
      );

      position.tp1 =
        true;

      continue;
    }

    if (
      position.tp1 &&
      !position.tp2 &&
      ret >=
      strategy.tp2
    ) {
      closePosition(
        position,
        0.50,
        px,
        "TP2"
      );

      position.tp2 =
        true;

      continue;
    }

    if (
      position.tp1 &&
      px <=
      position.high *
      0.90
    ) {
      closePosition(
        position,
        1,
        px,
        "Trailing stop"
      );

      continue;
    }

    if (
      !position.tp1 &&
      Date.now() -
      position.opened >
      120 *
      60000
    ) {
      closePosition(
        position,
        1,
        px,
        "120m time stop"
      );
    }
  }
}

function enterPositions() {
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

  for (
    var i = 0;
    i < universe.length;
    i++
  ) {
    var token =
      universe[i];

    var evaluation =
      evaluate(token);

    if (
      evaluation.decision ===
      "BUY"
    ) {
      candidates.push({
        token,
        evaluation
      });
    }
  }

  candidates.sort(
    function (a,b) {
      return (
        b.evaluation.score -
        a.evaluation.score
      );
    }
  );

  for (
    var c = 0;
    c < candidates.length;
    c++
  ) {
    if (
      slots <= 0 ||
      room < 50
    ) {
      break;
    }

    var item =
      candidates[c];

    var p =
      item.token;

    if (
      state.positions[
        p.address
      ]
    ) {
      continue;
    }

    if (
      Date.now() <
      (
        state.cooldowns[
          p.address
        ] || 0
      )
    ) {
      continue;
    }

    var size =
      Math.min(
        equity.equity *
        strategy.positionPct,

        600,

        room,

        state.cash /
        1.005
      );

    if (
      size <
      50
    ) {
      continue;
    }

    var entryFee =
      size *
      0.005;

    state.cash -=
      size +
      entryFee;

    state.fees +=
      entryFee;

    var qty =
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
        item.evaluation.score
    };

    addTrade(
      "BUY",

      state.positions[
        p.address
      ],

      p.price,

      size,

      -entryFee,

      "Score " +
      item.evaluation.score
    );

    slots--;

    room -=
      size;
  }
}

// ============================================================
// STRATEGY EVOLUTION
// ============================================================

function maybeEvolveStrategy() {
  var sells =
    state.trades.filter(
      function (trade) {
        return (
          trade.action ===
          "SELL"
        );
      }
    );

  if (
    sells.length <
    6
  ) {
    return;
  }

  var evolution =
    state.evolution;

  if (
    Date.now() -
    evolution.lastTime <
    EVOLUTION_MS
  ) {
    return;
  }

  var newClosed =
    sells.length -
    evolution.lastClosedCount;

  if (
    evolution.lastTime &&
    newClosed <
    3
  ) {
    return;
  }

  var sample =
    sells.slice(
      0,
      20
    );

  var wins =
    sample.filter(
      function (trade) {
        return (
          trade.pnl >
          0
        );
      }
    );

  var totalPnl =
    sample.reduce(
      function (
        sum,
        trade
      ) {
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
    totalPnl /
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

  if (
    winRate <
    0.40 ||
    avgPnl <
    -3
  ) {
    // 防守模式
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
        strategy.positionPct -
        0.005,
        0.03,
        0.06
      );

    strategy.stopLoss =
      clamp(
        strategy.stopLoss -
        0.01,
        0.08,
        0.12
      );

    reason =
      "Defensive：近期勝率或平均損益偏弱";

  } else if (
    winRate >=
      0.60 &&
    avgPnl >
      2 &&
    maxDrawdown() <
      6
  ) {
    // 表現良好，小幅放寬
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
        strategy.positionPct +
        0.005,
        0.03,
        0.06
      );

    strategy.tp1 =
      clamp(
        strategy.tp1 +
        0.01,
        0.12,
        0.20
      );

    strategy.tp2 =
      clamp(
        strategy.tp2 +
        0.02,
        0.25,
        0.40
      );

    reason =
      "Expansion：近期勝率、平均損益與回撤表現良好";

  } else {
    // 中性：只做細調
    if (
      winRate <
      0.50
    ) {
      strategy.scoreMin =
        clamp(
          strategy.scoreMin + 1,
          65,
          82
        );

      reason =
        "Fine tune：勝率普通，提高進場品質";
    } else {
      strategy.ratioMin =
        clamp(
          strategy.ratioMin - 0.01,
          1.10,
          1.45
        );

      reason =
        "Fine tune：表現穩定，微幅放寬買壓條件";
    }
  }

  evolution.lastTime =
    Date.now();

  evolution.lastClosedCount =
    sells.length;

  evolution.history.unshift({
    time:
      Date.now(),

    sample:
      sample.length,

    winRate:
      winRate,

    avgPnl:
      avgPnl,

    reason,

    before,

    after:
      JSON.parse(
        JSON.stringify(
          strategy
        )
      )
  });

  evolution.history =
    evolution.history.slice(
      0,
      30
    );

  save();
}

// ============================================================
// EQUITY
// ============================================================

function recordEquity() {
  var value =
    getEquity()
      .equity;

  var history =
    state.equityHistory;

  var last =
    history[
      history.length -
      1
    ];

  if (
    !last ||
    Math.abs(
      last.equity -
      value
    ) >
    0.01 ||
    Date.now() -
    last.time >
    300000
  ) {
    history.push({
      time:
        Date.now(),

      equity:
        value
    });
  }

  if (
    history.length >
    2000
  ) {
    state.equityHistory =
      history.slice(
        -2000
      );
  }
}

function maxDrawdown() {
  var peak =
    0;

  var maximum =
    0;

  for (
    var i = 0;
    i <
    state.equityHistory.length;
    i++
  ) {
    var value =
      state.equityHistory[
        i
      ].equity;

    peak =
      Math.max(
        peak,
        value
      );

    if (peak) {
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

async function scan() {
  if (scanning) {
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

  try {
    var positionAddresses =
      Object.keys(
        state.positions
      );

    var requestUrl =
      "/api/market";

    if (
      positionAddresses.length
    ) {
      requestUrl +=
        "?positions=" +
        encodeURIComponent(
          positionAddresses.join(
            ","
          )
        );
    }

    var response =
      await fetch(
        requestUrl +
        (
          requestUrl.indexOf(
            "?"
          ) === -1
            ? "?"
            : "&"
        ) +
        "t=" +
        Date.now(),

        {
          cache:"no-store"
        }
      );

    if (!response.ok) {
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

    if (
      !result ||
      !Array.isArray(
        result.tokens
      )
    ) {
      throw new Error(
        "Invalid market response"
      );
    }

    universe =
      result.tokens;

    if (
      result.stale
    ) {
      warningBox.textContent =
        "本輪 discovery 失敗，暫時沿用上一批成功市場資料；持倉幣仍會另外刷新價格。";

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

  } catch (error) {
    console.error(
      error
    );

    errorBox.textContent =
      "行情抓取失敗：" +
      error.message;

    errorBox.style.display =
      "block";

  } finally {
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

function render() {
  var equity =
    getEquity();

  var total =
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

  var totalElement =
    byId(
      "totalPnl"
    );

  totalElement.textContent =
    (
      total >= 0
        ? "+"
        : ""
    ) +
    money(total) +
    " U";

  totalElement.className =
    "value " +
    color(total);

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
      function (trade) {
        return (
          trade.action ===
          "SELL"
        );
      }
    );

  var wins =
    sellTrades.filter(
      function (trade) {
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

  var evaluations =
    universe.map(
      function (token) {
        return {
          token,
          evaluation:
            evaluate(token)
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
      function (item) {
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

  var bestScore =
    0;

  for (
    var i = 0;
    i <
    evaluations.length;
    i++
  ) {
    bestScore =
      Math.max(
        bestScore,
        evaluations[i]
          .evaluation
          .score
      );
  }

  byId(
    "bestScore"
  ).textContent =
    evaluations.length
      ? bestScore
      : "—";

  byId(
    "tradeCount"
  ).textContent =
    state.trades.length;

  byId(
    "fees"
  ).textContent =
    money(
      state.fees
    ) +
    " U";

  byId(
    "exposure"
  ).textContent =
    (
      equity.positionValue /
      Math.max(
        1,
        equity.equity
      ) *
      100
    ).toFixed(1) +
    "%";

  // strategy display
  var strategy =
    state.strategy;

  byId(
    "strategyScore"
  ).textContent =
    strategy.scoreMin;

  byId(
    "strategyRatio"
  ).textContent =
    strategy.ratioMin
      .toFixed(2);

  byId(
    "strategySize"
  ).textContent =
    (
      strategy.positionPct *
      100
    ).toFixed(1) +
    "%";

  byId(
    "strategySl"
  ).textContent =
    "-" +
    (
      strategy.stopLoss *
      100
    ).toFixed(0) +
    "%";

  byId(
    "strategyTp1"
  ).textContent =
    "+" +
    (
      strategy.tp1 *
      100
    ).toFixed(0) +
    "%";

  byId(
    "strategyTp2"
  ).textContent =
    "+" +
    (
      strategy.tp2 *
      100
    ).toFixed(0) +
    "%";

  renderEvolution();

  // feed
  evaluations.sort(
    function (a,b) {
      return (
        b.evaluation.score -
        a.evaluation.score
      );
    }
  );

  var feedRows =
    [];

  for (
    var f = 0;
    f <
    Math.min(
      evaluations.length,
      50
    );
    f++
  ) {
    var item =
      evaluations[f];

    var p =
      item.token;

    var e =
      item.evaluation;

    var className =
      e.decision === "BUY"
        ? "green"
        : (
            e.decision ===
            "REJECT"
              ? "red"
              : "yellow"
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
      age(
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
      p.buys5m +
      "/" +
      p.sells5m +
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
      className +
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
      "尚未取得市場資料" +
      "</td>" +
      "</tr>"
    );

  // positions
  var positionRows =
    [];

  var positionKeys =
    Object.keys(
      state.positions
    );

  for (
    var pIndex = 0;
    pIndex <
    positionKeys.length;
    pIndex++
  ) {
    var position =
      state.positions[
        positionKeys[
          pIndex
        ]
      ];

    var px =
      currentPrice(
        position.address
      ) ||
      position.last ||
      position.entry;

    var value =
      position.qty *
      px;

    var pnl =
      value -
      position.qty *
      position.entry;

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
      money(value) +
      " U</td>" +

      '<td class="' +
      color(pnl) +
      '">' +
      (
        pnl >= 0
          ? "+"
          : ""
      ) +
      money(pnl) +
      " U</td>" +

      "<td>" +
      age(
        position.opened
      ) +
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
      '<td colspan="6">' +
      "目前沒有持倉" +
      "</td>" +
      "</tr>"
    );

  // trades
  var tradeRows =
    [];

  for (
    var t = 0;
    t <
    Math.min(
      state.trades.length,
      100
    );
    t++
  ) {
    var trade =
      state.trades[t];

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
        trade.price
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
      '<td colspan="7">' +
      "尚無交易" +
      "</td>" +
      "</tr>"
    );

  drawChart();
}

function renderEvolution() {
  var history =
    state.evolution
      .history;

  if (!history.length) {
    byId(
      "evolutionLog"
    ).innerHTML =
      '<div class="evolution-entry">' +
      "尚未調整。至少需要 6 筆出場紀錄後才會開始學習。" +
      "</div>";

    return;
  }

  var rows =
    [];

  for (
    var i = 0;
    i <
    Math.min(
      history.length,
      5
    );
    i++
  ) {
    var item =
      history[i];

    rows.push(
      '<div class="evolution-entry">' +

      "<b>" +
      new Date(
        item.time
      ).toLocaleString() +
      "</b><br>" +

      "最近 " +
      item.sample +
      " 筆出場｜勝率 " +
      (
        item.winRate *
        100
      ).toFixed(1) +
      "%｜平均 PnL " +
      money(
        item.avgPnl
      ) +
      "U<br>" +

      item.reason +

      "<br>Score " +
      item.before.scoreMin +
      " → " +
      item.after.scoreMin +

      "｜B/S " +
      item.before.ratioMin
        .toFixed(2) +
      " → " +
      item.after.ratioMin
        .toFixed(2) +

      "｜Size " +
      (
        item.before.positionPct *
        100
      ).toFixed(1) +
      "% → " +
      (
        item.after.positionPct *
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

function drawChart() {
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

  if (!data.length) {
    return;
  }

  var values =
    data.map(
      function (item) {
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

  if (
    maximum -
    minimum <
    1
  ) {
    minimum -= 10;
    maximum += 10;
  }

  context.strokeStyle =
    "#31e986";

  context.lineWidth =
    2;

  context.beginPath();

  for (
    var i = 0;
    i < data.length;
    i++
  ) {
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
          data.length -
          1
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

    if (i === 0) {
      context.moveTo(
        x,
        y
      );
    } else {
      context.lineTo(
        x,
        y
      );
    }
  }

  context.stroke();
}

function resetAccount() {
  if (
    !confirm(
      "確定清除交易、績效與 Strategy Evolution，重新從 10,000U 開始？"
    )
  ) {
    return;
  }

  state =
    freshState();

  save();

  render();
}

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
  function () {
    var seconds =
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
      seconds +
      "s";

    if (
      !scanning &&
      Date.now() >=
      nextScanAt
    ) {
      scan();
    }
  },
  1000
);

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
    async function (
      req,
      res
    ) {
      try {
        const url =
          new URL(
            req.url,
            "http://localhost"
          );

        if (
          url.pathname ===
          "/health"
        ) {
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

        if (
          url.pathname ===
          "/api/market"
        ) {
          try {
            const positionsRaw =
              url.searchParams.get(
                "positions"
              ) || "";

            const positions =
              positionsRaw
                .split(",")
                .map(
                  item =>
                    item.trim()
                )
                .filter(Boolean)
                .slice(0, 20);

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

          } catch (error) {
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

      } catch (error) {
        console.error(error);

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
  function () {
    console.log(
      "MemeHunter Evolution running on port",
      PORT
    );
  }
);
