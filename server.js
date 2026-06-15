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

// ── Basic Auth ────────────────────────────────────────────────────────────────
const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD;
if (DASHBOARD_PASSWORD) {
  app.use((req, res, next) => {
    // VPS endpoints use PUSH_SECRET — skip Basic Auth for them
    if (req.path === "/api/push" || req.path === "/api/pending") return next();
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
  stats: { totalScans: 0, totalTrades: 0, wins: 0, startingCapital: 2000, currentPnL: 0, realizedTotal: 0, realizedToday: 0, realizedDate: null },
});
await db.read();
db.data.logs         ??= [];
db.data.trades       ??= [];
db.data.agentEnabled ??= false;
db.data.scanInterval ??= 10;
db.data.pendingAction ??= null;
db.data.lastAccount  ??= null;
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
  if (!DAILY_LOSS_LIMIT) return;
  if (!db.data.agentEnabled) return;
  if (db.data.stats.realizedToday > -DAILY_LOSS_LIMIT) return;
  db.data.agentEnabled = false;
  log("warn", `🛑 Daily loss limit hit (${db.data.stats.realizedToday.toFixed(2)} ≤ -${DAILY_LOSS_LIMIT}). Agent auto-disabled for the day.`);
  broadcast("enabled", false);
  broadcast("emergency", true);
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
  const { type, content, trade, account, scanningNow, win, realizedPnl } = req.body;

  if (scanningNow !== undefined) {
    scanning = scanningNow;
    broadcast("status", { scanning });
  }

  if (content) log(type || "agent", content);

  if (trade) {
    db.data.stats.totalTrades++;
    // win is an optional explicit flag from the agent (true on a profitable close).
    if (win === true) db.data.stats.wins++;

    // Accumulate realized P&L from this closed round trip. realizedToday resets
    // automatically when the ET calendar day rolls over.
    const pnl = Number(realizedPnl);
    if (Number.isFinite(pnl)) {
      const today = getETDate();
      if (db.data.stats.realizedDate !== today) {
        db.data.stats.realizedDate = today;
        db.data.stats.realizedToday = 0;
      }
      db.data.stats.realizedTotal += pnl;
      db.data.stats.realizedToday += pnl;
      maybeTripLossLimit();
    }

    const entry = { id: Date.now(), time: getETTime(), date: getETDate(), summary: content?.slice(0, 300) || "" };
    db.data.trades.unshift(entry);
    if (db.data.trades.length > 100) db.data.trades = db.data.trades.slice(0, 100);
    broadcast("trade", entry);
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
app.get("/health", (req, res) => res.json({ ok: true, time: getETTime() }));

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`SPY 0DTE Agent server running on port ${PORT}`);
  log("info", `🚀 Server started — port ${PORT}`);
});
