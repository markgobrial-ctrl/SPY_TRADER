import express from "express";
import cors from "cors";
import cron from "node-cron";
import Anthropic from "@anthropic-ai/sdk";
import { Low } from "lowdb";
import { JSONFile } from "lowdb/node";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import "dotenv/config";
import { getAccountData, getRHToken } from "./rhApi.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(cors());
app.use(express.json());

// ── Basic Auth ────────────────────────────────────────────────────────────────
const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD;
if (DASHBOARD_PASSWORD) {
  app.use((req, res, next) => {
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
const db = new Low(new JSONFile(join(__dirname, "data/db.json")), {
  logs: [],
  trades: [],
  conversationHistory: [],
  agentEnabled: false,
  scanInterval: 10,
  stats: { totalScans: 0, totalTrades: 0, wins: 0, startingCapital: 2000, currentPnL: 0 },
});
await db.read();
db.data.logs         ??= [];
db.data.trades       ??= [];
db.data.conversationHistory ??= [];
db.data.agentEnabled ??= false;
db.data.scanInterval ??= 10;
db.data.stats        ??= { totalScans: 0, totalTrades: 0, wins: 0, startingCapital: 2000, currentPnL: 0 };
await db.write();

// ── SSE clients (live dashboard updates) ─────────────────────────────────────
const sseClients = new Set();

function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  sseClients.forEach(res => res.write(payload));
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
  db.write();
  broadcast("log", entry);
  console.log(`[${entry.time}] [${type}] ${content.slice(0, 120)}`);
}

// ── Market hours check ────────────────────────────────────────────────────────
function isMarketHours() {
  const et = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
  const day = et.getDay();
  if (day === 0 || day === 6) return false;
  const mins = et.getHours() * 60 + et.getMinutes();
  return mins >= 9 * 60 + 35 && mins < 16 * 60;
}

function getETTime() {
  return new Date().toLocaleTimeString("en-US", {
    timeZone: "America/New_York",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
}

function getETDate() {
  return new Date().toLocaleDateString("en-US", { timeZone: "America/New_York" });
}

// ── Anthropic client ──────────────────────────────────────────────────────────
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const ACCOUNT_NUMBER = process.env.ROBINHOOD_ACCOUNT ?? "5UV19627";
const MCP_RH  = "https://agent.robinhood.com/mcp/trading";
const MCP_FMP = "https://financialmodelingprep.com/mcp";

const SYSTEM_PROMPT = `You are an aggressive 0DTE SPY options trading agent. Your mandate is capital growth, not capital preservation. You trade SPY 0DTE calls and puts exclusively, targeting asymmetric setups where a small premium outlay can return 100–300% on a single move.

ACCOUNT: ${ACCOUNT_NUMBER} (Agentic individual brokerage — ~$2,000 starting capital)
INSTRUMENT: SPY 0DTE calls and puts ONLY. No spreads. No iron condors. Directional only.

## PHILOSOPHY
0DTE options are a growth instrument. The edge is catching strong intraday momentum early and letting winners run. You are NOT here to grind small credits — you are here to catch moves. A single 200% winner more than covers 3 stop-outs. Be patient waiting for the right setup, then be aggressive when it's there.

## YOUR DECISION FRAMEWORK

### Step 1 — Market Reconnaissance
Pull ALL of the following before any decision:
- SPY current price, open, intraday high/low, and % change via get_equity_quotes
- VIX level via FMP (^VIX)
- SPY 0DTE option chain via get_option_chains + get_option_instruments (look at ATM and 1-strike OTM calls and puts)
- Open positions via get_option_positions
- Open orders via get_option_orders

### Step 2 — Trade Window (STRICT)
ONLY trade between 9:35–11:00 AM ET. This is the only window.
- After 11:00 AM ET: manage existing positions only. NO new entries.
- After 3:45 PM ET: close everything. No exceptions.

### Step 3 — Setup Requirements (ALL must be true to enter)
**VIX filter:** VIX must be between 16 and 35. Outside this range — SIT OUT.
**Momentum filter:** SPY must be moving at least 0.4% from open. Move must be directional, not choppy.
**No opposing position:** Never hold both a call and a put simultaneously.

### Step 4 — Strike Selection
- Primary: ATM strike (closest to current SPY price)
- High conviction only: 1-strike OTM when move is already confirmed and accelerating
- NEVER go more than 1 strike OTM
- Skip if bid/ask spread wider than $0.15

### Step 5 — Position Sizing
- Standard: 1 contract
- Highest conviction (VIX 20–35, SPY >0.75% move, clear trend): 2 contracts
- Never spend more than $400 on a single trade
- If account below $1,500: 1 contract max

### Step 6 — Let Winners Run
- Minimum exit: 80% gain
- Target: 150% gain
- Moonshot: 200%+ if SPY still trending before 10:30 AM
- Once at 100% gain, stop moves to breakeven

### Step 7 — Stop Loss
- Exit immediately at 40% loss on premium paid
- No averaging down. Cut and wait for next setup.

### Step 8 — Position Management (every scan)
- Stop hit (down 40%) → close immediately
- Target hit (up 80%+) → evaluate trend, close if stalling
- Past 3:45 PM ET → close everything at market

### Step 9 — Report
📊 MARKET: [SPY price, % from open, VIX, trend]
🎯 SETUP: [Meets criteria? Why/why not]
📋 ACTION: [Trade details OR "WAITING — reason" OR position management]
💰 SIZING: [Contracts, premium, total outlay, max loss]
📈 BOOK: [Open positions, entry, current value, % P&L]
⏱ NEXT: [What to watch next scan]

## HARD RULES
- ONLY trade 9:35–11:00 AM ET
- ONLY SPY 0DTE calls or puts — no spreads
- ONLY 1–2 contracts, max $400/trade
- NEVER hold past 3:45 PM ET
- NEVER trade VIX < 16 or > 35
- NEVER enter if SPY < 0.4% from open
- ONE trade per day max unless first closed profitably
- Execute autonomously without asking for confirmation`;

// ── Core agent scan ───────────────────────────────────────────────────────────
let scanning = false;

async function runScan(instruction = null) {
  if (scanning) {
    log("warn", "Scan already in progress — skipping");
    return;
  }
  scanning = true;
  broadcast("status", { scanning: true });

  const scanInstruction = instruction ||
    `Autonomous scan. Today is ${getETDate()}, ET time is ${getETTime()}. ` +
    `Run full decision framework: check SPY vs open (need >0.4% move), VIX (need 16–35), open positions. ` +
    `Trade window 9:35–11:00 AM ET only. 1–2 contracts max, $400 max outlay. ` +
    `Let winners run to 150%+. Cut losers at 40%. Close all by 3:45 PM ET. Execute autonomously.`;

  log("info", `▶ Scan started — ${getETTime()}`);
  db.data.stats.totalScans++;
  await db.write();
  broadcast("stats", db.data.stats);

  try {
    const history = db.data.conversationHistory.slice(-20); // keep last 20 turns
    const messages = [...history, { role: "user", content: scanInstruction }];

    const rhToken = await getRHToken();
    const response = await anthropic.beta.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 1000,
      system: SYSTEM_PROMPT,
      messages,
      mcp_servers: [
        { type: "url", url: MCP_RH,  name: "robinhood", authorization_token: rhToken },
        { type: "url", url: MCP_FMP, name: "fmp" },
      ],
      betas: ["mcp-client-2025-04-04"],
    });

    const textBlocks = response.content.filter(b => b.type === "text");
    const toolCalls  = response.content.filter(b => b.type === "mcp_tool_use");
    const responseText = textBlocks.map(b => b.text).join("\n").trim();

    if (toolCalls.length > 0) {
      log("info", `🔧 Tools: ${toolCalls.map(t => t.name).join(", ")}`);
    }

    const didTrade = toolCalls.some(t => t.name?.includes("place"));
    if (didTrade) {
      db.data.stats.totalTrades++;
      const tradeEntry = {
        id: Date.now(),
        time: getETTime(),
        date: getETDate(),
        summary: responseText.slice(0, 300),
      };
      db.data.trades.unshift(tradeEntry);
      if (db.data.trades.length > 100) db.data.trades = db.data.trades.slice(0, 100);
      broadcast("trade", tradeEntry);
      log("trade", `⚡ Trade executed`);
    }

    if (responseText) log("agent", responseText);

    // Persist conversation (cap at 40 messages to avoid token bloat)
    const newHistory = [
      ...messages,
      { role: "assistant", content: response.content },
    ].slice(-40);
    db.data.conversationHistory = newHistory;
    await db.write();
    broadcast("stats", db.data.stats);

  } catch (err) {
    log("error", `Agent error: ${err.message}`);
  } finally {
    scanning = false;
    broadcast("status", { scanning: false });
  }
}

// ── Cron scheduler ────────────────────────────────────────────────────────────
// Runs every minute, checks if it's time to scan based on interval setting
let lastScanTime = 0;

cron.schedule("* * * * *", async () => {
  if (!db.data.agentEnabled) return;
  if (!isMarketHours()) return;

  const intervalMs = (db.data.scanInterval || 10) * 60 * 1000;
  const now = Date.now();
  if (now - lastScanTime < intervalMs) return;

  lastScanTime = now;
  await runScan();
});

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
  })}\n\n`);

  sseClients.add(res);
  req.on("close", () => sseClients.delete(res));
});

// Agent on/off
app.post("/api/agent/enable", async (req, res) => {
  db.data.agentEnabled = true;
  await db.write();
  log("info", "🟢 Agent ENABLED — autonomous trading active");
  broadcast("enabled", true);
  res.json({ ok: true });
});

app.post("/api/agent/disable", async (req, res) => {
  db.data.agentEnabled = false;
  await db.write();
  log("warn", "🔴 Agent DISABLED");
  broadcast("enabled", false);
  res.json({ ok: true });
});

// Manual scan trigger
app.post("/api/scan", async (req, res) => {
  const { instruction } = req.body;
  res.json({ ok: true });
  runScan(instruction || null); // fire and forget
});

// Update scan interval
app.post("/api/interval", async (req, res) => {
  const { minutes } = req.body;
  if (![5, 10, 15, 30].includes(minutes)) return res.status(400).json({ error: "Invalid interval" });
  db.data.scanInterval = minutes;
  await db.write();
  log("info", `⏱ Scan interval updated to ${minutes}m`);
  broadcast("interval", minutes);
  res.json({ ok: true });
});

// Emergency stop — disable agent and log
app.post("/api/emergency-stop", async (req, res) => {
  db.data.agentEnabled = false;
  await db.write();
  log("warn", "🛑 EMERGENCY STOP triggered");
  broadcast("enabled", false);
  broadcast("emergency", true);
  res.json({ ok: true });
});

// Close all positions (manual override)
app.post("/api/close-all", async (req, res) => {
  res.json({ ok: true });
  runScan("URGENT: Close ALL open SPY option positions immediately on account " + ACCOUNT_NUMBER + ". Check positions first then close each one.");
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

// ── Account data (direct Robinhood API, cached 30s) ───────────────────────────
let acctCache = null, acctCacheAt = 0;

app.get("/api/account", async (req, res) => {
  if (acctCache && Date.now() - acctCacheAt < 30_000) return res.json(acctCache);
  try {
    const data = await getAccountData();
    const stats = db.data.stats;
    const winRate = stats.totalTrades > 0 ? Math.round((stats.wins / stats.totalTrades) * 100) : null;
    acctCache = { ...data, stats: { ...stats, winRate } };
    acctCacheAt = Date.now();
    res.json(acctCache);
  } catch (e) {
    log("error", `Account fetch error: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
});

// Health check for Render
app.get("/health", (req, res) => res.json({ ok: true, time: getETTime() }));

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`SPY 0DTE Agent server running on port ${PORT}`);
  log("info", `🚀 Server started — port ${PORT}`);
});
