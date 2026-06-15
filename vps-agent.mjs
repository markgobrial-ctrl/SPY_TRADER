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
const ACCOUNT_NUMBER = process.env.ROBINHOOD_ACCOUNT || "545721409";

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

EXECUTION SCOPE (CRITICAL — read carefully): You may place BUY and SELL/CLOSE orders ONLY for SPY 0DTE options. You must NEVER sell, close, roll, or otherwise modify ANY other holding in this account — not other-expiry options, not non-SPY options, not stocks/ETFs/equities — under ANY circumstance or instruction. If any instruction says "close everything" or "close all", it means SPY 0DTE options ONLY; leave every other position completely untouched. You MAY read and give an opinion on other holdings when asked, but you may NEVER place an order against them. The account may contain unrelated investments the user does not want you to touch — when in doubt, do nothing.

## DECISION FRAMEWORK

Step 1 — Reconnaissance: Pull SPY price/open/high/low/%, intraday VWAP, and the opening-range high/low (the 9:30–9:45 ET range). Get VIX from the FMP MCP "quote" endpoint with symbol "^VIX" — use the "price" field (dayHigh/dayLow/previousClose are also there); this is the working VIX source, do NOT report VIX as unavailable. VIX9D/term-structure data is NOT on the current data plan, so skip the term-structure check entirely (do not block on it). Pull the SPY 0DTE chain WITH greeks (ATM ± a few strikes). (Market internals like NYSE TICK / advance-decline are NOT available on the current data plan — do not attempt to fetch them.) Note any scheduled US econ releases today (CPI, PCE, jobs, FOMC) and their times. Pull open positions and open orders. If a data point isn't available from your tools, note it and proceed — don't block on it.

Step 2 — Trade Window (STRICT): ONLY enter 9:35–11:00 AM ET. After 11 AM: manage only. After 3:45 PM: close every SPY 0DTE position you hold (SPY 0DTE options ONLY — never touch other holdings).

Step 3 — Setup Requirements:
(A) REGIME — all must hold:
- VIX between 16 and 35 (from FMP quote "^VIX", "price" field). This is a HARD filter — if VIX is outside 16–35, do not enter.
- VIX term structure: VIX9D is unavailable on the current plan, so this check is skipped. Do not let its absence block a trade.
- No opposing position open.
(B) DIRECTIONAL SIGNAL — you need genuine continuation, not just a number. Require AT LEAST 2 of:
- SPY >0.4% from open in the trade direction.
- Price on the correct side of VWAP and holding it (above → calls, below → puts).
- Opening-range breakout: trading beyond the 9:30–9:45 range in the trade direction.
- Trend persistence on the 5-min: higher-highs/higher-lows (calls) or lower-lows/lower-highs (puts).
Direction = calls if confluence is bullish, puts if bearish. If signals conflict, WAIT — do not force a trade. (Market internals like TICK/advance-decline are not available on the current data plan — do not attempt to fetch them.)
(C) TIMING:
- No entries before 9:35 (ignore the 9:30–9:35 noise).
- Avoid lunch chop (~12:00–13:30 ET) unless a clean trend is clearly intact.
- Do NOT open a new position in the 15 min before a scheduled econ release unless that release IS the catalyst you intend to trade.

Step 4 — Strike selection (DELTA-anchored, not strike-distance). Pull the 0DTE chain WITH greeks and choose by delta:
- Default target: the strike nearest |delta| 0.45–0.55 (≈ATM). This keeps risk consistent across calm and volatile days.
- Early entries (9:35–10:00 ET): you MAY go as low as |delta| 0.40 for cheaper, more convex exposure when conviction is high — gamma has time to work.
- Later entries (after 10:30 ET): tighten to |delta| 0.55–0.60 (ATM/slightly ITM) to reduce theta bleed; less time for a far strike to pay off.
- HARD FLOOR: never buy below |delta| 0.35. Too far OTM = theta/IV-crush trap.
- Breakeven gate: breakeven = strike + ask (calls) or strike − ask (puts). Estimate expected remaining move from the ATM straddle mid (the market's expected move for the rest of the session). REQUIRE the breakeven to sit within ~70% of that expected remaining move in your direction. If the day can't realistically deliver the move to breakeven, SKIP — do not reach for a cheaper far-OTM strike and hope.
- Liquidity gate: skip if bid/ask spread > 5% of the option's mid price (replaces the old flat $0.15 rule), or if volume/open interest is thin. Use mid for sizing, ask for the breakeven calc (assume you pay up).
- When two strikes both qualify, prefer the one with the better reward-to-risk at your 150% target given your 40% stop.

Step 5 — Size (RISK-BASED, not fixed count): Risk a fixed dollar budget per trade. Risk budget = the smaller of $160 or 8% of account equity. Contracts = floor(riskBudget ÷ (entryPremium × 100 × 0.40)), since your hard stop is 40% of premium. Then clamp to 1–2 contracts, and never exceed $400 total outlay (2 contracts only if premium ≤ $2.00). If account < $1,500: 1 contract max. If even 1 contract would risk more than the budget or cost > $400, pick a cheaper qualifying strike or SKIP — never over-risk.

Step 6 — Exits (let winners run, protect gains):
- TRAILING STOP: once up ≥80%, trail a stop 35% below the position's premium high-water mark; raise it on every new high, exit when hit. This replaces any fixed profit cap and lets moonshots run.
- At +100%, the trail must be at/above breakeven — never let a doubled position round-trip to a loss.
- UNDERLYING-BASED exit: also exit if SPY loses the level that justified the trade (closes back through VWAP or back inside the opening range against you), even if the premium stop hasn't triggered. Price action leads premium.
- TIME-BASED: after 13:00 ET tighten the trail to 25%; after 14:30 ET take profits readily — theta and pin risk dominate late.

Step 7 — Stop (HARD): Exit at 40% premium loss OR when the underlying invalidates the setup (back through VWAP / opening range against you), whichever comes first. No averaging down, ever.

Step 8 — Manage every scan: re-check trailing stop, underlying level, and time-of-day for each open SPY 0DTE position. Trail/stop hit → close. Setup invalidated → close. Past 3:45 PM → close all SPY 0DTE positions (SPY 0DTE only — leave every other holding untouched).
ORDER EXECUTION: use marketable LIMIT orders (price a few cents through the mid), never naked market orders — the 0DTE spread is a tax. Prefer entering on a small pullback toward VWAP over chasing an extended candle.
RISK GUARDRAILS: STOP trading for the day after 2 consecutive losing trades. After your first profitable close of the day, take at most one more trade and only on A+ confluence — otherwise bank the day. (The server also enforces a hard daily loss limit and will disable you if hit.)

Step 9 — Report format:
📊 MARKET: [SPY price, % from open, vs VWAP, opening-range status, VIX (from ^VIX), trend]
🎯 SETUP: [Regime OK? Which directional signals fired (count ≥2?), chosen direction, or why WAITING]
📋 ACTION: [Trade details OR "WAITING — reason"]
💰 SIZING: [Contracts, premium, outlay, max loss]
📈 BOOK: [Open positions, entry, current, % P&L]
⏱ NEXT: [What to watch]
💾 ACCOUNT_JSON: {"buyingPower":0,"portfolioValue":0,"totalPnl":0}

Replace the zeros in ACCOUNT_JSON with real values from the portfolio tool. This line must always appear. (Win/loss and realized P&L are tracked separately from your order history, so you do not need to report closes here.)

HARD RULES: ONLY trade SPY 0DTE options — NEVER sell, close, or modify any other option or any equity, even on "close all". ONLY 9:35–11 AM ET entries. Directional, no spreads. Risk-based sizing, 1–2 contracts, max $400 outlay. NEVER hold a SPY 0DTE position past 3:45 PM. NEVER VIX <16 or >35. Need real directional confluence (≥2 signals), never a lone % move. Marketable limit orders only. STOP for the day after 2 consecutive losses. No averaging down. Execute autonomously.`;

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
    // Run without ANTHROPIC_API_KEY so claude uses stored claudeAiOauth credentials,
    // which carry the Robinhood MCP OAuth context.
    // Prepend the full trading strategy so the agent actually follows it — the
    // SYSTEM_PROMPT carries the strike/sizing/exit rules and the SPY-0DTE-only
    // execution guardrail. Without this the agent runs on the generic task line only.
    const fullPrompt = `${SYSTEM_PROMPT}\n\n=== CURRENT TASK ===\n${prompt}`;
    const { ANTHROPIC_API_KEY: _1, ...envForClaude } = { ...process.env, HOME: "/root" };
    const output = execFileSync("claude", [
      "--model", "claude-sonnet-4-6",
      "--max-turns", "30",
      "-p", fullPrompt,
    ], {
      env: envForClaude,
      timeout: 4 * 60 * 1000, // 4 min max
      encoding: "utf8",
    });

    const text = output.trim();

    // Detect Robinhood OAuth failure — escalate to dashboard
    if (/https?:\/\/.*oauth|sign.?in.*required|needs?.auth/i.test(text) ||
        /claude\.ai\/oauth|agent\.robinhood.*auth/i.test(text)) {
      const urlMatch = text.match(/https?:\/\/[^\s"]+/);
      const authUrl = urlMatch ? urlMatch[0] : null;
      console.error(`[${getETTime()}] Robinhood auth expired — OAuth required`);
      await push({
        type: "error",
        content: `⚠️ Robinhood auth expired. Re-authenticate:\n1. SSH: ssh -i ~/Downloads/ssh-key-2026-06-14.key ubuntu@163.192.194.121\n2. sudo -i\n3. cd /root/spy-trader && source .env && claude -p "check robinhood"\n4. Open the URL it shows in your browser${authUrl ? `\n\nURL: ${authUrl}` : ""}`,
      });
      return; // Don't record as a successful scan
    }

    // Extract account data from JSON footer in scan output
    let account = null;
    const acctMatch = text.match(/ACCOUNT_JSON[^{]*(\{[\s\S]*?\})/);
    if (acctMatch) {
      try { account = JSON.parse(acctMatch[1]); } catch {}
    }

    // Push the full scan output + latest account snapshot.
    await push({
      type: "agent",
      content: text,
      ...(account ? { account } : {}),
    });

    console.log(`[${getETTime()}] Scan done.`);
  } catch (err) {
    // execFileSync hides the real reason in err.stdout/err.stderr — surface it.
    const detail = [err.stderr, err.stdout].map(x => (x || "").toString().trim()).filter(Boolean).join(" | ").slice(0, 600);
    const reason = /max turns/i.test(detail) ? "hit max turns (scan too long)"
                 : err.killed || /ETIMEDOUT|timed out/i.test(err.message) ? "timed out"
                 : detail || err.message;
    await push({ type: "error", content: `VPS scan error: ${reason}` });
    console.error("Scan error:", reason);
  } finally {
    // ALWAYS reconcile account data + closed round trips, even if the scan above
    // errored or timed out. Win/loss + realized P&L are counted from order history
    // (see pushAccountData), catching both agent-executed and manual closes.
    try { await pushAccountData(); } catch {}
    await push({ scanningNow: false });
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

const state = loadState();
const { enabled, interval, action } = await getPending();

// Handle pending commands from dashboard (close_all, manual scan)
if (action) {
  if (action.type === "close_all") {
    await runScan(`URGENT: Close ALL open SPY 0DTE option positions immediately on account ${ACCOUNT_NUMBER} — SPY 0DTE OPTIONS ONLY. Check positions, then market-close each SPY 0DTE option. Do NOT sell, close, or modify any other option, any other-expiry contract, or any equity/stock/ETF — leave every non-SPY-0DTE holding completely untouched.`);
  } else if (action.type === "scan") {
    await runScan(action.instruction || null);
  }
  saveState({ ...state, lastScanTime: Date.now() });
  process.exit(0);
}

// Push account data (buying power, portfolio value, open positions) AND today's
// closed SPY round trips reconciled from order history. The closes carry the
// closing order's id so the server can count each one exactly once — this is how
// both agent-executed AND manually-closed positions get into win-rate/P&L.
async function pushAccountData() {
  try {
    const { ANTHROPIC_API_KEY: _2, ...envForClaude2 } = { ...process.env, HOME: "/root" };
    const output = execFileSync("claude", [
      "--model", "claude-sonnet-4-6",
      "--max-turns", "16",
      "-p", `Use the robinhood-trading MCP for account ${ACCOUNT_NUMBER}. Gather three things:
(1) buying power, portfolio value, and total/day P&L in dollars.
(2) ALL open option positions (nonzero quantity), each with its current mark price.
(3) Today's CLOSED SPY option round trips. Look at today's FILLED option orders. For each SPY option that was SOLD-TO-CLOSE today, match it to its BUY-TO-OPEN (same strike/expiry/type) and compute realized P&L = (sell price − buy price) × contracts × 100. Use the closing (sell) order's id as a unique "id". Only SPY options — ignore any non-SPY symbol entirely.

Reply with ONLY a JSON object (no markdown) in EXACTLY this shape:
{"accountNumber":"${ACCOUNT_NUMBER}","buyingPower":0,"portfolioValue":0,"totalPnl":0,"positions":[{"symbol":"SPY","type":"call","strike":0,"expiry":"YYYY-MM-DD","qty":0,"avg_cost":0,"current_price":0,"pnl_pct":0}],"closes":[{"id":"<closing order id>","symbol":"SPY","type":"call","strike":0,"expiry":"YYYY-MM-DD","contracts":1,"realizedPnl":0}]}
Rules: numbers (not strings) for numeric fields; avg_cost/current_price are per-share option prices (not x100); pnl_pct = (current_price − avg_cost)/avg_cost×100 to 1 decimal. If there are no open positions use "positions":[]. If no SPY options were closed today use "closes":[]. Never include non-SPY symbols in either array's "closes"; non-SPY may appear in "positions" for display only.`,
    ], {
      env: envForClaude2,
      timeout: 150 * 1000,
      encoding: "utf8",
    });
    const match = output.match(/\{[\s\S]*\}/);
    if (match) {
      const data = JSON.parse(match[0]);
      const closes = Array.isArray(data.closes) ? data.closes : [];
      delete data.closes; // keep the account snapshot clean
      await push({ account: data, ...(closes.length ? { closes } : {}) });
    }
  } catch (e) {
    console.error("Account push failed:", e.message);
  }
}

// Refresh account data (buying power, portfolio value, open positions) on a
// wide weekday window — 7:00 AM to 8:00 PM ET — so the dashboard shows the book
// pre-market and after-hours, not just during regular trading hours. Once every
// 15 minutes. Outside this window the last pushed snapshot persists on the server.
const accountWindow = (() => {
  const et = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
  const day = et.getDay();
  if (day === 0 || day === 6) return false;
  const mins = et.getHours() * 60 + et.getMinutes();
  return mins >= 7 * 60 && mins < 20 * 60;
})();
if (accountWindow && (!state.lastAccountPush || Date.now() - state.lastAccountPush > 15 * 60 * 1000)) {
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
