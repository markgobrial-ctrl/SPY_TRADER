/**
 * vps-agent.mjs — SPY 0DTE trading agent for Linux VPS
 *
 * Runs via cron every minute. Checks if a scan is due, calls Claude Code
 * with the Robinhood MCP, then pushes results to the Render dashboard.
 *
 * Setup:
 *   1. npm install -g @anthropic-ai/claude-code
 *   2. claude mcp add robinhood-trading --transport http https://agent.robinhood.com/mcp/trading
 *   3. claude mcp add fmp --transport http https://financialmodelingprep.com/mcp
 *   4. Authenticate Robinhood (one-time browser link)
 *   5. Set env vars in /etc/environment or ~/.bashrc:
 *      RENDER_URL=https://spy-trader.onrender.com
 *      PUSH_SECRET=<same secret as Render env var>
 *      ANTHROPIC_API_KEY=<your key>
 *   6. Add to crontab: * * * * * /usr/bin/node /root/spy-trader/vps-agent.mjs >> /root/spy-agent.log 2>&1
 */

import { execFileSync } from "child_process";

const RENDER_URL = process.env.RENDER_URL?.replace(/\/$/, "");
const PUSH_SECRET = process.env.PUSH_SECRET;
const ACCOUNT_NUMBER = process.env.ROBINHOOD_ACCOUNT || "5UV19627";

if (!RENDER_URL) {
  console.error("RENDER_URL env var is required");
  process.exit(1);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function getET() {
  return new Date().toLocaleString("en-US", { timeZone: "America/New_York" });
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

function isMarketHours() {
  const et = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
  const day = et.getDay();
  if (day === 0 || day === 6) return false;
  const mins = et.getHours() * 60 + et.getMinutes();
  return mins >= 9 * 60 + 35 && mins < 16 * 60;
}

async function push(body) {
  try {
    await fetch(`${RENDER_URL}/api/push`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-push-secret": PUSH_SECRET || "",
      },
      body: JSON.stringify(body),
    });
  } catch (e) {
    console.error("Push failed:", e.message);
  }
}

async function getPending() {
  try {
    const r = await fetch(`${RENDER_URL}/api/pending`, {
      headers: { "x-push-secret": PUSH_SECRET || "" },
    });
    return r.json();
  } catch {
    return { enabled: false, interval: 10, action: null };
  }
}

// ── Scan state (persisted between cron runs via a lock file) ──────────────────
import { readFileSync, writeFileSync, existsSync } from "fs";

const STATE_FILE = "/tmp/spy-agent-state.json";
function loadState() {
  try { return existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, "utf8")) : {}; }
  catch { return {}; }
}
function saveState(s) {
  writeFileSync(STATE_FILE, JSON.stringify(s));
}

// ── Trading system prompt ─────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are an aggressive 0DTE SPY options trading agent running autonomously on a VPS. Your mandate is capital growth. You trade SPY 0DTE calls and puts exclusively.

ACCOUNT: ${ACCOUNT_NUMBER} (Robinhood Agentic account)
INSTRUMENT: SPY 0DTE calls and puts ONLY. No spreads. Directional only.

## DECISION FRAMEWORK

Step 1 — Reconnaissance: Pull SPY price/open/high/low/%, VIX, SPY 0DTE option chain (ATM + 1-OTM), open positions, open orders.

Step 2 — Trade Window (STRICT): ONLY enter 9:35–11:00 AM ET. After 11 AM: manage only. After 3:45 PM: close everything.

Step 3 — Setup Requirements (ALL must be true):
- VIX between 16 and 35
- SPY >0.4% from open, directional
- No opposing position

Step 4 — Strike: ATM primary. 1-OTM only on highest conviction. NEVER >1 OTM. Skip if spread >$0.15.

Step 5 — Size: 1 contract standard, 2 contracts max (VIX 20–35, SPY >0.75% move). Never >$400/trade. If account <$1,500: 1 contract max.

Step 6 — Exits: Min 80% gain, target 150%, moonshot 200%+ before 10:30 AM. At 100% gain, stop to breakeven.

Step 7 — Stop: Exit at 40% loss. No averaging.

Step 8 — Manage every scan: Stop hit → close. Target hit → evaluate. Past 3:45 PM → close all.

Step 9 — Report format:
📊 MARKET: [SPY price, % from open, VIX, trend]
🎯 SETUP: [Meets criteria? Why/why not]
📋 ACTION: [Trade details OR "WAITING — reason"]
💰 SIZING: [Contracts, premium, outlay, max loss]
📈 BOOK: [Open positions, entry, current, % P&L]
⏱ NEXT: [What to watch]
💾 ACCOUNT_JSON: {"buyingPower":0,"portfolioValue":0,"totalPnl":0}

Replace the zeros in ACCOUNT_JSON with real values from the portfolio tool. This line must always appear.

HARD RULES: ONLY 9:35–11 AM entries. ONLY SPY 0DTE. ONLY 1–2 contracts, max $400. NEVER past 3:45 PM. NEVER VIX <16 or >35. NEVER <0.4% move. ONE trade/day max unless first closed profitably. Execute autonomously.`;

// ── Run a Claude Code scan ────────────────────────────────────────────────────

async function runScan(instruction = null) {
  const prompt = instruction || [
    `Autonomous scan. Today is ${getETDate()}, ET time is ${getETTime()}.`,
    `Run full decision framework: check SPY vs open (need >0.4% move), VIX (need 16–35), open positions.`,
    `Trade window 9:35–11:00 AM ET only. 1–2 contracts max, $400 max outlay.`,
    `Let winners run to 150%+. Cut losers at 40%. Close all by 3:45 PM ET.`,
    `Execute autonomously.`,
  ].join(" ");

  await push({ type: "info", content: `▶ Scan started — ${getETTime()}`, scanningNow: true });
  await push({ type: "scan_start" });

  try {
    const output = execFileSync("claude", [
      "--model", "claude-sonnet-4-6",
      "--max-turns", "20",
      "-p", prompt,
    ], {
      env: { ...process.env },
      timeout: 3 * 60 * 1000, // 3 min max
      encoding: "utf8",
    });

    const text = output.trim();
    const didTrade = /place_option_order|placed.*order|bought|sold/i.test(text);

    // Extract account data from JSON footer in scan output
    let account = null;
    const acctMatch = text.match(/ACCOUNT_JSON:\s*(\{[^}]+\})/);
    if (acctMatch) {
      try { account = JSON.parse(acctMatch[1]); } catch {}
    }

    await push({
      type: "agent",
      content: text,
      trade: didTrade,
      ...(account ? { account } : {}),
    });

    console.log(`[${getETTime()}] Scan done. Trade: ${didTrade}`);
  } catch (err) {
    await push({ type: "error", content: `VPS agent error: ${err.message}` });
    console.error("Scan error:", err.message);
  } finally {
    await push({ scanningNow: false });
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

const state = loadState();
const { enabled, interval, action } = await getPending();

// Handle pending commands from dashboard (close_all, manual scan)
if (action) {
  if (action.type === "close_all") {
    await runScan(`URGENT: Close ALL open SPY option positions immediately on account ${ACCOUNT_NUMBER}. Check positions then close each one at market.`);
  } else if (action.type === "scan") {
    await runScan(action.instruction || null);
  }
  saveState({ ...state, lastScanTime: Date.now() });
  process.exit(0);
}

// Push basic account data every run (so dashboard always shows something)
async function pushAccountData() {
  try {
    const output = execFileSync("claude", [
      "--model", "claude-sonnet-4-6",
      "--max-turns", "3",
      "-p", `Use the robinhood-trading MCP to get portfolio and account info for account ${ACCOUNT_NUMBER}. Reply ONLY with a JSON object (no markdown) with these fields: accountNumber, buyingPower, portfolioValue, totalPnl. Use numbers not strings for numeric fields.`,
    ], {
      env: { ...process.env },
      timeout: 60 * 1000,
      encoding: "utf8",
    });
    const match = output.match(/\{[\s\S]*\}/);
    if (match) {
      const account = JSON.parse(match[0]);
      await push({ account });
    }
  } catch (e) {
    console.error("Account push failed:", e.message);
  }
}

// Only push account data during market hours, once every 15 minutes
const nearMarket = (() => {
  const et = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
  const day = et.getDay();
  if (day === 0 || day === 6) return false;
  const mins = et.getHours() * 60 + et.getMinutes();
  return mins >= 9 * 60 + 30 && mins < 16 * 60 + 15;
})();
if (nearMarket && (!state.lastAccountPush || Date.now() - state.lastAccountPush > 15 * 60 * 1000)) {
  await pushAccountData();
  saveState({ ...state, lastAccountPush: Date.now() });
}

// Skip if disabled or outside market hours
if (!enabled) { console.log("Agent disabled"); process.exit(0); }
if (!isMarketHours()) { console.log("Outside market hours"); process.exit(0); }

// Enforce scan interval
const intervalMs = (interval || 10) * 60 * 1000;
if (state.lastScanTime && Date.now() - state.lastScanTime < intervalMs) {
  const wait = Math.round((intervalMs - (Date.now() - state.lastScanTime)) / 60000);
  console.log(`Next scan in ~${wait}m`);
  process.exit(0);
}

// Run the scan
saveState({ ...state, lastScanTime: Date.now() });
await runScan();
