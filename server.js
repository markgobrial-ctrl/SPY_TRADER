import express from "express";
import cors from "cors";
import { Low } from "lowdb";
import { JSONFile } from "lowdb/node";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { mkdirSync } from "fs";
import "dotenv/config";

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(cors());
app.use(express.json());

// Robinhood account number — single source of truth (env-overridable)
const ACCOUNT_NUMBER = process.env.ROBINHOOD_ACCOUNT || "545721409";

// Optional protective guardrail: max realized loss allowed in a single ET day,
// in dollars (positive number). If realized P&L for the day falls to -limit,
// the agent auto-disables for the rest of the day. Unset/0 = no breaker.
const DAILY_LOSS_LIMIT = Number(process.env.DAILY_LOSS_LIMIT) || 0;

// Levers the USER may set manually from the app. (The autonomous learning loop
// is separately restricted to only the four safe knobs in review.mjs — it can
// never touch the risk levers.) Bounds-clamping is authoritative on the VPS
// (clampParams); the server just refuses keys outside this list.
const TUNABLE_PARAM_KEYS = [
  "entryWindowStart", "entryWindowEnd", "minSignals", "deltaLow", "deltaHigh",
  "maxContracts", "maxOutlay", "maxEntriesPerDay", "stopPct", "targetPct", "trailPct",
  "vixMin", "vixMax", "minMovePct", "dailyLossLimit",
];
const DEFAULT_STRATEGY_PARAMS = {
  entryWindowStart: "09:35", entryWindowEnd: "14:00", minSignals: 2, deltaLow: 0.45, deltaHigh: 0.55,
  maxContracts: 2, maxOutlay: 400, maxEntriesPerDay: 2, stopPct: 28, targetPct: 75, trailPct: 35,
  vixMin: 16, vixMax: 35, minMovePct: 0.4, dailyLossLimit: 0,
};

// ── Basic Auth ────────────────────────────────────────────────────────────────
const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD;
// PWA icons + manifest must be publicly fetchable: when Android/iOS adds the
// site to the home screen it requests these WITHOUT the user's Basic Auth
// credentials, so gating them makes the install fall back to a blank/letter icon.
const PUBLIC_PWA_ASSETS = new Set([
  "/manifest.webmanifest", "/favicon.png", "/favicon.ico", "/apple-touch-icon.png",
  "/icon-192.png", "/icon-512.png", "/icon-maskable-192.png", "/icon-maskable-512.png",
  "/alfredo-logo.png",
]);
if (DASHBOARD_PASSWORD) {
  app.use((req, res, next) => {
    // VPS endpoints use PUSH_SECRET — skip Basic Auth for them.
    // /health is public so Render's health check (and version probes) work.
    // PWA icon/manifest assets are public so home-screen install can fetch them.
    if (req.path === "/api/push" || req.path === "/api/pending" || req.path === "/health") return next();
    if (PUBLIC_PWA_ASSETS.has(req.path)) return next();
    const auth = req.headers.authorization;
    if (auth && auth.startsWith("Basic ")) {
      const [, user, pass] = Buffer.from(auth.slice(6), "base64").toString().match(/^([^:]*):(.*)$/) || [];
      if (pass === DASHBOARD_PASSWORD) return next();
    }
    res.set("WWW-Authenticate", 'Basic realm="SPY Trader"');
    res.status(401).send("Unauthorized");
  });
}

app.use(express.static(__dirname));

// ── Database (flat JSON file, persists on Render disk) ────────────────────────
const dbPath = join(__dirname, "data/db.json");
// Ensure the data directory exists, otherwise lowdb's first write throws ENOENT
// and crashes the server on boot (e.g. local dev or a misconfigured disk mount).
mkdirSync(dirname(dbPath), { recursive: true });
const db = new Low(new JSONFile(dbPath), {
  logs: [],
  trades: [],
  agentEnabled: false,
  scanInterval: 10,
  pendingAction: null,
  lastAccount: null,
  countedCloseIds: [],
  strategy: { params: { ...DEFAULT_STRATEGY_PARAMS }, sources: {}, manual: {}, learned: {}, history: [], proposals: [] },
  stats: { totalScans: 0, totalTrades: 0, wins: 0, startingCapital: 2000, currentPnL: 0, realizedTotal: 0, realizedToday: 0, realizedDate: null },
});
await db.read();
db.data.logs         ??= [];
db.data.trades       ??= [];
db.data.agentEnabled ??= false;
db.data.scanInterval ??= 10;
db.data.pendingAction ??= null;
db.data.lastAccount  ??= null;
db.data.countedCloseIds ??= [];
db.data.strategy ??= { params: { ...DEFAULT_STRATEGY_PARAMS }, sources: {}, manual: {}, learned: {}, history: [], proposals: [] };
db.data.strategy.params = { ...DEFAULT_STRATEGY_PARAMS, ...(db.data.strategy.params || {}) };
db.data.strategy.sources ??= {};
db.data.strategy.manual ??= {};
db.data.strategy.learned ??= {};
db.data.strategy.history ??= [];
db.data.strategy.proposals ??= [];
db.data.stats        ??= { totalScans: 0, totalTrades: 0, wins: 0, startingCapital: 2000, currentPnL: 0 };
// Backfill realized-P&L fields on databases created before this feature existed.
db.data.stats.realizedTotal ??= 0;
db.data.stats.realizedToday ??= 0;
db.data.stats.realizedDate  ??= null;
await db.write();

// ── Serialized DB writes ──────────────────────────────────────────────────────
// lowdb's JSONFile is not concurrency-safe: overlapping writes can corrupt
// db.json. Chain every write onto a single promise so they run one at a time.
let _writeChain = Promise.resolve();
function queueWrite() {
  _writeChain = _writeChain
    .catch(() => {})
    .then(() => db.write())
    .catch(err => console.error("DB write failed:", err.message));
  return _writeChain;
}

// ── SSE clients (live dashboard updates) ─────────────────────────────────────
const sseClients = new Set();

function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    try {
      res.write(payload);
    } catch {
      sseClients.delete(res); // drop dead client
    }
  }
}

// ── Logging ───────────────────────────────────────────────────────────────────
function log(type, content) {
  const entry = {
    id: Date.now(),
    type,
    content,
    time: new Date().toLocaleTimeString("en-US", {
      timeZone: "America/New_York",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    }),
    ts: Date.now(),
  };
  db.data.logs.unshift(entry);
  if (db.data.logs.length > 500) db.data.logs = db.data.logs.slice(0, 500);
  queueWrite();
  broadcast("log", entry);
  console.log(`[${entry.time}] [${type}] ${content.slice(0, 120)}`);
}

// ── Time helpers (ET) ─────────────────────────────────────────────────────────
function getETTime() {
  return new Date().toLocaleTimeString("en-US", {
    timeZone: "America/New_York",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
}

function getETDate() {
  return new Date().toLocaleDateString("en-US", { timeZone: "America/New_York" });
}

// ── Daily loss-limit circuit breaker (opt-in via DAILY_LOSS_LIMIT) ────────────
// If the day's realized losses reach the limit, disable the agent so the VPS
// stops opening new trades for the rest of the session. Protective only.
function maybeTripLossLimit() {
  // Limit comes from the strategy lever (user-set) and falls back to the env var.
  const limit = Number(db.data.strategy?.params?.dailyLossLimit) || DAILY_LOSS_LIMIT;
  if (!limit) return;
  if (!db.data.agentEnabled) return;
  // realizedToday only resets inside recordClose on the first close of a new ET
  // day. If we're on a new day and haven't recorded a close yet, yesterday's
  // figure is stale — treat today's realized as 0 so we neither falsely trip the
  // breaker nor carry a prior-day loss into the new session.
  const realizedToday = db.data.stats.realizedDate === getETDate() ? db.data.stats.realizedToday : 0;
  if (realizedToday > -limit) return;
  db.data.agentEnabled = false;
  log("warn", `🛑 Daily loss limit hit (${realizedToday.toFixed(2)} ≤ -${limit}). Agent auto-disabled for the day.`);
  broadcast("enabled", false);
  broadcast("emergency", true);
}

// ── Record a closed round trip exactly once ───────────────────────────────────
// Closes are reconciled from Robinhood order history every cycle, so the same
// close is reported repeatedly. Dedupe by the closing order id: count trades,
// wins, and realized P&L only the first time we see a given id. Returns true if
// it was newly counted. Catches both agent-executed and manual closes.
function recordClose(c) {
  const pnl = Number(c.realizedPnl ?? c.pnl);
  if (!Number.isFinite(pnl)) return false;
  const id = c.id != null ? String(c.id) : null;
  if (id && db.data.countedCloseIds.includes(id)) return false; // already counted

  db.data.stats.totalTrades++;
  if (pnl > 0) db.data.stats.wins++;

  const today = getETDate();
  if (db.data.stats.realizedDate !== today) {
    db.data.stats.realizedDate = today;
    db.data.stats.realizedToday = 0;
  }
  db.data.stats.realizedTotal += pnl;
  db.data.stats.realizedToday += pnl;

  if (id) {
    db.data.countedCloseIds.push(id);
    if (db.data.countedCloseIds.length > 1000) {
      db.data.countedCloseIds = db.data.countedCloseIds.slice(-1000);
    }
  }

  const label = [c.symbol || "SPY", c.strike ? "$" + c.strike : "", (c.type || "").toUpperCase()].filter(Boolean).join(" ");
  const entry = {
    id: Date.now() + Math.floor(Math.random() * 1000),
    time: getETTime(), date: today,
    summary: `Closed ${label} — realized P&L ${pnl >= 0 ? "+" : "-"}$${Math.abs(pnl).toFixed(2)}`,
  };
  db.data.trades.unshift(entry);
  if (db.data.trades.length > 100) db.data.trades = db.data.trades.slice(0, 100);
  broadcast("trade", entry);

  maybeTripLossLimit();
  return true;
}

// ── Agent state (set by VPS push) ─────────────────────────────────────────────
let scanning = false;

// ── API routes ────────────────────────────────────────────────────────────────

// SSE endpoint — dashboard connects here for live updates
app.get("/api/stream", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  // Send current state immediately on connect
  res.write(`event: init\ndata: ${JSON.stringify({
    logs:    db.data.logs.slice(0, 100),
    trades:  db.data.trades.slice(0, 20),
    stats:   db.data.stats,
    enabled: db.data.agentEnabled,
    interval: db.data.scanInterval,
    scanning,
    account: ACCOUNT_NUMBER,
    strategy: db.data.strategy,
  })}\n\n`);

  sseClients.add(res);
  req.on("close", () => sseClients.delete(res));
});

// Agent on/off
app.post("/api/agent/enable", async (req, res) => {
  db.data.agentEnabled = true;
  await queueWrite();
  log("info", "🟢 Agent ENABLED — autonomous trading active");
  broadcast("enabled", true);
  res.json({ ok: true });
});

app.post("/api/agent/disable", async (req, res) => {
  db.data.agentEnabled = false;
  await queueWrite();
  log("warn", "🔴 Agent DISABLED");
  broadcast("enabled", false);
  res.json({ ok: true });
});

// Manual scan trigger — sets a pending action for the VPS to pick up
app.post("/api/scan", async (req, res) => {
  const { instruction } = req.body;
  db.data.pendingAction = { type: "scan", instruction: instruction || null, at: Date.now() };
  await queueWrite();
  log("info", "⚡ Manual scan requested — VPS will pick up shortly");
  res.json({ ok: true });
});

// Update scan interval
app.post("/api/interval", async (req, res) => {
  const { minutes } = req.body;
  if (![5, 10, 15, 30].includes(minutes)) return res.status(400).json({ error: "Invalid interval" });
  db.data.scanInterval = minutes;
  await queueWrite();
  log("info", `⏱ Scan interval updated to ${minutes}m`);
  broadcast("interval", minutes);
  res.json({ ok: true });
});

// Emergency stop — disable agent and log
app.post("/api/emergency-stop", async (req, res) => {
  db.data.agentEnabled = false;
  await queueWrite();
  log("warn", "🛑 EMERGENCY STOP triggered");
  broadcast("enabled", false);
  broadcast("emergency", true);
  res.json({ ok: true });
});

// Close all positions — sets pending action for VPS
app.post("/api/close-all", async (req, res) => {
  db.data.pendingAction = { type: "close_all", at: Date.now() };
  await queueWrite();
  log("warn", "🛑 Close-all requested — VPS will execute");
  res.json({ ok: true });
});

// Get logs
app.get("/api/logs", (req, res) => {
  res.json(db.data.logs.slice(0, 200));
});

// Get trades
app.get("/api/trades", (req, res) => {
  res.json(db.data.trades.slice(0, 50));
});

// Get stats
app.get("/api/stats", (req, res) => {
  res.json({ ...db.data.stats, enabled: db.data.agentEnabled, interval: db.data.scanInterval, scanning });
});

// Get strategy state (current levers + change history + proposal log)
app.get("/api/strategy", (req, res) => res.json(db.data.strategy));

// Manually set strategy levers — queues a clamped change the VPS applies.
app.post("/api/params", async (req, res) => {
  const incoming = req.body && req.body.change ? req.body.change : req.body || {};
  const change = {};
  for (const k of TUNABLE_PARAM_KEYS) if (incoming[k] !== undefined && incoming[k] !== null) change[k] = incoming[k];
  if (!Object.keys(change).length) return res.status(400).json({ error: "No valid params (allowed: " + TUNABLE_PARAM_KEYS.join(", ") + ")" });
  db.data.pendingAction = { type: "set_params", change, at: Date.now() };
  // Optimistically reflect the requested change so the dashboard shows it right
  // away instead of appearing to do nothing while the VPS is between cron ticks
  // (or down). The VPS remains authoritative: it clamps the value and pushes the
  // real strategy back, overwriting this. Mark each touched lever as "pending".
  db.data.strategy.params = { ...db.data.strategy.params, ...change };
  for (const k of Object.keys(change)) db.data.strategy.sources[k] = "pending";
  broadcast("strategy", db.data.strategy);
  await queueWrite();
  log("info", `🛠 Manual param change requested: ${JSON.stringify(change)} — VPS will apply & clamp`);
  res.json({ ok: true, change });
});

// Reset levers to baseline (specific keys, or all if none given).
app.post("/api/params/reset", async (req, res) => {
  const keys = Array.isArray(req.body && req.body.keys) ? req.body.keys.filter(k => TUNABLE_PARAM_KEYS.includes(k)) : null;
  db.data.pendingAction = { type: "reset_params", keys, at: Date.now() };
  await queueWrite();
  log("info", `↺ Param reset requested: ${keys && keys.length ? keys.join(", ") : "all to baseline"}`);
  res.json({ ok: true, keys });
});

// ── Account data (pushed by VPS, served from DB) ─────────────────────────────
app.get("/api/account", (req, res) => {
  if (!db.data.lastAccount) return res.status(503).json({ error: "No account data yet — VPS hasn't pushed data" });
  const stats = db.data.stats;
  const winRate = stats.totalTrades > 0 ? Math.round((stats.wins / stats.totalTrades) * 100) : null;
  res.json({ ...db.data.lastAccount, stats: { ...stats, winRate } });
});

// ── VPS push endpoint — receives agent output & account data ──────────────────
const PUSH_SECRET = process.env.PUSH_SECRET;

app.post("/api/push", async (req, res) => {
  if (PUSH_SECRET && req.headers["x-push-secret"] !== PUSH_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  const { type, content, account, scanningNow, closes, strategy } = req.body;

  // VPS reports the live strategy params + change history + proposal log.
  if (strategy && typeof strategy === "object") {
    if (strategy.params) db.data.strategy.params = strategy.params;
    if (strategy.sources) db.data.strategy.sources = strategy.sources;
    if (strategy.manual) db.data.strategy.manual = strategy.manual;
    if (strategy.learned) db.data.strategy.learned = strategy.learned;
    if (Array.isArray(strategy.history)) db.data.strategy.history = strategy.history.slice(-50);
    if (Array.isArray(strategy.proposals)) db.data.strategy.proposals = strategy.proposals.slice(-50);
    broadcast("strategy", db.data.strategy);
  }

  if (scanningNow !== undefined) {
    scanning = scanningNow;
    broadcast("status", { scanning });
  }

  if (content) log(type || "agent", content);

  // Closed round trips reconciled from order history (deduped by order id).
  if (Array.isArray(closes)) {
    for (const c of closes) recordClose(c);
  }

  if (type === "scan_start") db.data.stats.totalScans++;

  if (account) {
    // Merge rather than replace: lightweight pushes (e.g. warmup sends only
    // buying power / portfolio value, no positions) must not wipe the last
    // known positions list. A push that includes positions:[] still overwrites.
    db.data.lastAccount = { ...(db.data.lastAccount || {}), ...account };
    // Keep the headline P&L stat in sync with the latest account snapshot so the
    // dashboard shows a real number instead of always "—".
    const pnl = Number(account.totalPnl ?? account.total_pnl);
    if (Number.isFinite(pnl)) db.data.stats.currentPnL = pnl;
  }

  broadcast("stats", db.data.stats);

  await queueWrite();
  res.json({ ok: true });
});

// ── Pending actions — VPS polls this to get queued commands ──────────────────
app.get("/api/pending", async (req, res) => {
  if (PUSH_SECRET && req.headers["x-push-secret"] !== PUSH_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  const action = db.data.pendingAction;
  db.data.pendingAction = null;
  await queueWrite();
  res.json({
    action,
    enabled: db.data.agentEnabled,
    interval: db.data.scanInterval,
  });
});

// Health check for Render
app.get("/health", (req, res) => res.json({
  ok: true,
  time: getETTime(),
  version: process.env.RENDER_GIT_COMMIT || "dev",
  // Capability markers — confirm which features the running build has.
  features: { closeTracking: true, mergeAccount: true },
}));

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`SPY 0DTE Agent server running on port ${PORT}`);
  log("info", `🚀 Server started — port ${PORT}`);
});
