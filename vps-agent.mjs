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
import { getSnapshot, computeSignals } from "./market.mjs";
import { getAccountData, getTodayClosedSpyRoundTrips, getTodaySpyEntryState, cancelOptionOrder } from "./rhApi.js";

// Load the project-dir .env with a tiny zero-dependency parser. The VPS agent has
// no npm packages installed (only Node built-ins + the `claude` CLI), so we must
// NOT depend on `dotenv`. cron's cwd isn't the script dir, and the Robinhood REST
// + FMP creds the FAST_PATH layer needs live in /root/spy-trader/.env. This is
// non-destructive: it never overrides a var the environment already set, so any
// cron-provided RENDER_URL/PUSH_SECRET stay authoritative.
(function loadDotEnv() {
  try {
    const txt = readFileSync(new URL("./.env", import.meta.url).pathname, "utf8");
    for (const line of txt.split("\n")) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (!m) continue;
      let val = m[2];
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
      if (process.env[m[1]] === undefined) process.env[m[1]] = val;
    }
  } catch { /* no/unreadable .env — rely on the ambient environment */ }
})();

// FAST_PATH: gather market data in code (market.mjs) and only spawn the LLM when
// a cycle is actually actionable (open SPY 0DTE position, or a setup firing in the
// entry window). Off by default; ANY data-layer failure falls back to the full
// legacy LLM+MCP scan, so live trading is never left without coverage.
const FAST_PATH = process.env.FAST_PATH === "1";

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

// ── Scan state + single-run lock (coordinate the per-minute cron invocations) ──
import { readFileSync, writeFileSync, existsSync, appendFileSync, openSync, writeSync, closeSync, unlinkSync, statSync } from "fs";
import { loadParams, paramSources, loadLayers, setManual, resetParams } from "./shadow.mjs";

const JOURNAL_FILE = "/root/spy-trader/journal.jsonl";
const HISTORY_FILE = "/root/spy-trader/params-history.jsonl";
const PROPOSALS_FILE = "/root/spy-trader/proposals.jsonl";

function readJsonl(file, n = 30) {
  try {
    return readFileSync(file, "utf8").split("\n").filter(Boolean).slice(-n)
      .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}

// Extract the first balanced JSON object following a tag (handles nested objects
// and quoted braces — a plain regex can't). Returns the parsed object or null.
function extractJson(text, tag) {
  const idx = text.indexOf(tag);
  if (idx === -1) return null;
  const start = text.indexOf("{", idx);
  if (start === -1) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
    } else if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) {
      try { return JSON.parse(text.slice(start, i + 1)); } catch { return null; }
    }
  }
  return null;
}

const STATE_FILE = "/tmp/spy-agent-state.json";
function loadState() {
  try { return existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, "utf8")) : {}; }
  catch { return {}; }
}
function saveState(s) {
  writeFileSync(STATE_FILE, JSON.stringify(s));
}

// ── Single-run lock ───────────────────────────────────────────────────────────
// cron fires this script every minute, but one invocation can run for several
// minutes (the account-refresh + scan `claude` subprocesses). Without a mutex a
// later tick starts an overlapping run — the duplicate scan seen on the dashboard,
// and the subprocess contention that then trips the scan's wall-clock timeout.
// This O_EXCL lock guarantees one run at a time; a lock older than LOCK_STALE_MS
// is assumed to be from a crashed run (the exit handler can't fire on SIGKILL/OOM)
// and reclaimed.
const LOCK_FILE = "/tmp/spy-agent.lock";
// Hard wall-clock cap for ONE `claude` scan (env-overridable). Raised 4→8 min:
// the live log showed every scan dying at exactly 4:00, because a single scan now
// does ~20+ sequential MCP round-trips (derive VWAP from 5-min bars, opening
// range, 0DTE chain w/ greeks, positions/orders, PLUS managing an open position)
// and no longer fits in 4 min. 8 min lets it finish; the lock makes the longer
// run safe (overlapping ticks just bail).
const SCAN_TIMEOUT_MS = Number(process.env.SCAN_TIMEOUT_MS) || 8 * 60 * 1000;
// Stale threshold must clear the worst-case single run: one scan (SCAN_TIMEOUT_MS)
// plus the pre-scan and finally account refreshes (~2.5 min each). ~9 min headroom.
const LOCK_STALE_MS = SCAN_TIMEOUT_MS + 9 * 60 * 1000;
let holdsLock = false;

function lockIsStale() {
  try {
    const info = JSON.parse(readFileSync(LOCK_FILE, "utf8"));
    if (typeof info.ts === "number") return Date.now() - info.ts > LOCK_STALE_MS;
  } catch {}
  // Unreadable/empty/corrupt lock — fall back to the file's mtime so a genuinely
  // stuck lock can still be reclaimed, without stealing one that's only
  // momentarily mid-write.
  try { return Date.now() - statSync(LOCK_FILE).mtimeMs > LOCK_STALE_MS; } catch { return true; }
}

function writeLock() {
  const fd = openSync(LOCK_FILE, "wx"); // wx = O_CREAT|O_EXCL — throws EEXIST if it exists
  writeSync(fd, JSON.stringify({ pid: process.pid, ts: Date.now() }));
  closeSync(fd);
  holdsLock = true;
}

// Returns true if this process now owns the lock, false if a live run holds it.
function acquireLock() {
  try {
    writeLock();
    return true;
  } catch (e) {
    if (e.code !== "EEXIST") throw e;
    if (!lockIsStale()) return false;        // a live run holds it — bail this tick
    try { unlinkSync(LOCK_FILE); } catch {}   // reclaim a crashed run's lock
    try { writeLock(); return true; }
    catch { return false; }                   // lost the steal race to another tick — bail
  }
}

function releaseLock() {
  if (!holdsLock) return;
  try {
    // Only remove the lock if it's still ours (don't delete one a later run stole).
    const info = JSON.parse(readFileSync(LOCK_FILE, "utf8"));
    if (info.pid === process.pid) unlinkSync(LOCK_FILE);
  } catch {}
  holdsLock = false;
}
// Fires on normal completion and every process.exit() path below; covers all
// exits except hard kills (handled by the stale-lock reclaim above).
process.on("exit", releaseLock);

// ── Tunable strategy parameters ───────────────────────────────────────────────
// PARAMS come from params.json (single source: shadow.mjs loadParams + defaults).
// You may change ANY of them manually from the dashboard (each is bounds-clamped).
// The autonomous learning loop, however, may only ever change the four SAFE knobs
// (entryWindowEnd, minSignals, deltaLow, deltaHigh) — the risk levers are off-limits
// to auto-tuning and only you can change them. The SPY-0DTE-only guardrail is fixed.
const PARAMS = loadParams();

// ── Trading system prompt ─────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are an aggressive 0DTE SPY options trading agent running autonomously on a VPS. Your mandate is capital growth. You trade SPY 0DTE calls and puts exclusively.

ACCOUNT: ${ACCOUNT_NUMBER} (Robinhood Agentic account)
INSTRUMENT: SPY 0DTE calls and puts ONLY. No spreads. Directional only.

EXECUTION SCOPE (CRITICAL — read carefully): You may place BUY and SELL/CLOSE orders ONLY for SPY 0DTE options. You must NEVER sell, close, roll, or otherwise modify ANY other holding in this account — not other-expiry options, not non-SPY options, not stocks/ETFs/equities — under ANY circumstance or instruction. If any instruction says "close everything" or "close all", it means SPY 0DTE options ONLY; leave every other position completely untouched. You MAY read and give an opinion on other holdings when asked, but you may NEVER place an order against them. The account may contain unrelated investments the user does not want you to touch — when in doubt, do nothing.

## DECISION FRAMEWORK

Step 1 — Reconnaissance: Pull SPY price/open/high/low/%, intraday VWAP, and the opening-range high/low (the 9:30–9:45 ET range). Get VIX from the FMP MCP "quote" endpoint with symbol "^VIX" — use the "price" field (dayHigh/dayLow/previousClose are also there); this is the working VIX source, do NOT report VIX as unavailable. VIX9D/term-structure data is NOT on the current data plan, so skip the term-structure check entirely (do not block on it). Pull the SPY 0DTE chain WITH greeks (ATM ± a few strikes). (Market internals like NYSE TICK / advance-decline are NOT available on the current data plan — do not attempt to fetch them.) Note any scheduled US econ releases today (CPI, PCE, jobs, FOMC) and their times. Pull open positions and open orders. If a data point isn't available from your tools, note it and proceed — don't block on it.

Step 2 — Trade Window (STRICT): ONLY enter ${PARAMS.entryWindowStart} AM–${PARAMS.entryWindowEnd} ET. After ${PARAMS.entryWindowEnd}: manage only. After 3:45 PM: close every SPY 0DTE position you hold (SPY 0DTE options ONLY — never touch other holdings).

Step 3 — Setup Requirements:
(A) REGIME — all must hold:
- VIX between ${PARAMS.vixMin} and ${PARAMS.vixMax} (from FMP quote "^VIX", "price" field). This is a HARD filter — if VIX is outside ${PARAMS.vixMin}–${PARAMS.vixMax}, do not enter.
- VIX term structure: VIX9D is unavailable on the current plan, so this check is skipped. Do not let its absence block a trade.
- No opposing position open.
(B) DIRECTIONAL SIGNAL — genuine continuation, not just a number. Four signals, each votes a direction:
- move: |SPY % from open| >= ${PARAMS.minMovePct}% — votes the side of the move (up = call, down = put). A move smaller than ${PARAMS.minMovePct}% does NOT fire.
- vwap: SPY clearly on one side of intraday VWAP and holding it (above = call, below = put). "at"/touching does NOT fire.
- or_breakout: trading beyond the 9:30–9:45 opening range (breakout up = call, breakout down = put). Inside the range does NOT fire.
- trend: 5-min structure — higher-highs/higher-lows (call) or lower-lows/lower-highs (put). Chop does NOT fire.
Direction = the side with the MAJORITY of FIRING signals. Confluence counts ONLY the firing signals that AGREE with that direction; opposing signals never count, and if the two sides tie it is a CONFLICT → WAIT. Enter only if the agreeing-signal count is >= ${PARAMS.minSignals}.
CONSISTENCY (hard, applies to SCAN_JSON): "signals" must list exactly the firing signals that agree with "direction"; "signalCount" MUST equal that array's length; for a put the candidate delta is NEGATIVE, for a call POSITIVE. Never report a count that disagrees with the array.
DATA-MISSING DEGRADATION: vwap and or_breakout need intraday bars. Before declaring either unavailable, TRY to derive them yourself: pull today's 5-min (or 1-min) SPY bars (robinhood get_equity_historicals, or the FMP chart / technicalIndicators endpoints), compute session VWAP and the 9:30–9:45 high/low, and set vwapSide / openingRange from them. Only if intraday bars truly cannot be fetched, mark the unobservable signal(s) "na" and decide on the OBSERVABLE signals — but you still need >= ${PARAMS.minSignals} AGREEING observable signals; if fewer than ${PARAMS.minSignals} signals are even observable, WAIT. Never manufacture confluence from missing data. (Market internals like TICK/advance-decline are not on the data plan — do not attempt to fetch them.)
(C) TIMING (time-of-day expectancy — from the Jun 28 trade-history analysis):
- No entries before 9:35 (ignore the 9:30–9:35 noise).
- HIGHEST-expectancy window is the OPEN, 9:35–10:30 ET — by far the largest favorable moves in the data (avg peak excursion ~+85–103% vs ~+30–40% later). Prefer your full-conviction entries here.
- MIDDAY (HARD RULE, enforced in code on the fast path): after 11:00 ET a minimum of 3 AGREEING signals is REQUIRED to enter — the 11:00–12:30 lull has the smallest moves and most chop (the 7/1 midday entry was the day's only loser). With fewer than 3, PASS.
- Avoid lunch chop (~12:00–13:30 ET) unless a clean trend is clearly intact.
- Do NOT open a new position in the 15 min before a scheduled econ release unless that release IS the catalyst you intend to trade.

Step 4 — Strike selection (DELTA-anchored, not strike-distance). Pull the 0DTE chain WITH greeks and choose by delta:
- Default target: the strike nearest |delta| ${PARAMS.deltaLow}–${PARAMS.deltaHigh} (≈ATM). This keeps risk consistent across calm and volatile days.
- Early entries (9:35–10:00 ET): you MAY go as low as |delta| 0.40 for cheaper, more convex exposure when conviction is high — gamma has time to work.
- Later entries (after 10:30 ET): tighten to |delta| 0.55–0.60 (ATM/slightly ITM) to reduce theta bleed; less time for a far strike to pay off.
- HARD FLOOR: never buy below |delta| 0.35. Too far OTM = theta/IV-crush trap.
- Breakeven gate: breakeven = strike + ask (calls) or strike − ask (puts). Estimate expected remaining move from the ATM straddle mid (the market's expected move for the rest of the session). REQUIRE the breakeven to sit within ~70% of that expected remaining move in your direction. If the day can't realistically deliver the move to breakeven, SKIP — do not reach for a cheaper far-OTM strike and hope.
- Liquidity gate: skip if bid/ask spread > 3% of the option's mid price (0DTE spreads are a tax; the prior 5% was too loose — clean ATM SPY 0DTE strikes are typically well under 3%), or if volume/open interest is thin. Spreads widen at midday, late in the session, and on far strikes — prefer the tightest qualifying strike and treat a 2–3% spread as a real cost in the breakeven/target math. Use mid for sizing, ask for the breakeven calc (assume you pay up).
- When two strikes both qualify, prefer the one with the better reward-to-risk at your ${PARAMS.targetPct}% target given your ${PARAMS.stopPct}% stop.

Step 5 — Size (RISK-BASED, not fixed count): Your hard stop is ${PARAMS.stopPct}% of premium. Risk budget per trade = the smaller of $160 or 8% of account equity. Contracts = floor(riskBudget ÷ (entryPremium × 100 × ${(PARAMS.stopPct / 100).toFixed(2)})). Then clamp to ${PARAMS.maxContracts} contract(s) max, and NEVER exceed $${PARAMS.maxOutlay} total outlay. If account < $1,500: 1 contract max. If even 1 contract would risk more than the budget or cost > $${PARAMS.maxOutlay}, pick a cheaper qualifying strike or SKIP — never over-risk.

Step 6 — Exits (HANDLED IN CODE by the watcher — you only enter):
- EXITS ARE HANDLED IN CODE — do NOT place any resting take-profit/backstop limit at entry, EVER. A resting sell reserves the single contract and BLOCKS the code watcher's close (this caused failed sells). The watcher (watch.mjs) owns ALL profit-taking: it locks the gain on a MOMENTUM-STALL once you're in profit (SPY stops making new highs for calls / new lows for puts), and cuts losers at the hard stop. Just enter cleanly and let the watcher exit; never place a resting limit that would block it.
- HARD STOP / INVALIDATION (SECONDARY, monitored each scan): if the position is at −${PARAMS.stopPct}% premium OR SPY has lost the level that justified the trade (back through VWAP / back inside the opening range against you), exit immediately. Price action leads premium.
- NEVER DOUBLE-SELL (CRITICAL — real money): there must never be two live sell orders on one contract. Before placing ANY stop / invalidation / EOD close, you MUST first check for and CANCEL any live sell order on that contract (there should be none — you never place resting sells — but verify) and confirm the cancel, THEN close. If a sell already filled, the position is flat — do nothing.
- LATE-DAY: after 14:30 ET theta and pin risk dominate — if a position is still open, cancel any live sell order on it, then close at market rather than waiting.

Step 7 — Stop (HARD): Exit at ${PARAMS.stopPct}% premium loss OR when the underlying invalidates the setup (back through VWAP / opening range against you), whichever comes first. No averaging down, ever.

Step 8 — Manage every scan: for each open SPY 0DTE position, do NOT place or re-place any resting take-profit — the code watcher owns profit-taking. Re-check the hard stop, the underlying level, and the time of day. Stop or invalidation hit → cancel any live sell order on that contract (verify — there should be none), confirm, then close. Past 3:45 PM → cancel any live sell orders, then close all SPY 0DTE positions (SPY 0DTE only — leave every other holding untouched).
ORDER EXECUTION: use marketable LIMIT orders (price a few cents through the mid), never naked market orders — the 0DTE spread is a tax. Prefer entering on a small pullback toward VWAP over chasing an extended candle.
RISK GUARDRAILS (now ALSO enforced in code — the fast path will not even wake you when a gate is hit): max ${PARAMS.maxEntriesPerDay ?? 2} entries per day. STOP trading for the day after 2 consecutive losing trades. Never open a new position while ANY buy order is still working (unfilled) — one entry order at a time, and at most ONE entry order per scan. After your first profitable close of the day, take at most one more trade and only on A+ confluence — otherwise bank the day.

Step 9 — Report format:
📊 MARKET: [SPY price, % from open, vs VWAP, opening-range status, VIX (from ^VIX), trend]
🎯 SETUP: [Regime OK? Which directional signals fired (count ≥2?), chosen direction, or why WAITING]
📋 ACTION: [Trade details OR "WAITING — reason"]
💰 SIZING: [Contracts, premium, outlay, max loss]
📈 BOOK: [Open positions, entry, current, % P&L]
⏱ NEXT: [What to watch]
💾 ACCOUNT_JSON: {"buyingPower":0,"portfolioValue":0,"totalPnl":0}
💾 SCAN_JSON: {"spy":0,"pctFromOpen":0,"vwapSide":"above","openingRange":"inside","vix":0,"trend":"bull","signals":[],"signalCount":0,"regimeOk":true,"decision":"WAIT","direction":null,"reason":"","candidate":null,"entry":null}

Replace the zeros in ACCOUNT_JSON with real values from the portfolio tool. This line must always appear. (Win/loss and realized P&L are tracked separately from your order history, so you do not need to report closes here.)

SCAN_JSON is a machine-readable snapshot of THIS scan for the learning journal — it must ALWAYS appear, on every scan, trade or not. Fill every field from your analysis:
- spy: current SPY price (number). pctFromOpen: % move from today's open (signed number, e.g. -0.32).
- vwapSide: "above" | "below" | "at" (SPY vs intraday VWAP). openingRange: "breakout_up" | "breakout_down" | "inside" | "na".
- vix: VIX level from ^VIX (number). trend: "bull" | "bear" | "chop".
- signals: the FIRING signals that AGREE with "direction", from ["move","vwap","or_breakout","trend"]. signalCount MUST equal signals.length (never disagree with the array).
- regimeOk: true/false (VIX 16–35 and conditions acceptable). decision: "ENTER" | "WAIT" | "MANAGE" | "NONE" (NONE = outside hours/market closed).
- direction: "call" | "put" | null (null when signals tie/conflict). For a put the candidate delta is NEGATIVE; for a call, POSITIVE. reason: one short sentence explaining the decision.
- candidate: the SPY 0DTE option you WOULD trade in the leaned direction THIS scan (fill it even on WAIT, so we capture option-level data): {"strike":<n>,"delta":<n>,"premium":<mid per-share>,"spreadPct":<bid-ask spread as % of mid>}. Use null only if the market is closed or no sensible candidate exists.
- entry: if you actually ENTERED this scan, {"strike":<n>,"delta":<n>,"contracts":<n>,"premium":<n>}; otherwise null.
Keep it on ONE line of valid JSON (candidate and entry are the only nested objects).

HARD RULES: ONLY trade SPY 0DTE options — NEVER sell, close, or modify any other option or any equity, even on "close all". ONLY ${PARAMS.entryWindowStart}–${PARAMS.entryWindowEnd} ET entries. Directional, no spreads. Risk-based sizing, ${PARAMS.maxContracts} contract(s) max, max $${PARAMS.maxOutlay} outlay. NEVER hold a SPY 0DTE position past 3:45 PM. NEVER VIX <${PARAMS.vixMin} or >${PARAMS.vixMax}. Need real directional confluence (≥${PARAMS.minSignals} signals), never a lone % move. Marketable limit orders only; do NOT place a resting take-profit limit at entry (it blocks the code watcher's close) — the watcher handles momentum-stall profit-taking + the ${PARAMS.stopPct}% hard stop. STOP for the day after 2 consecutive losses. No averaging down. Execute autonomously.`;

// ── Journal hygiene ───────────────────────────────────────────────────────────
// Make a scan record self-consistent before it enters the learning journal. The
// model occasionally (a) reports a signalCount that disagrees with its own signals
// array, or (b) emits a candidate whose delta sign contradicts the trade direction.
// We TRUST the model's signal list and direction (its nuanced reads, incl. whether
// VWAP is "holding") and only enforce internal consistency: signalCount === list
// length, and candidate delta sign === direction (puts negative, calls positive).
// The live ENTER/WAIT decision the agent already made is never altered here; this
// only keeps the recorded data clean so the learning loop isn't fed contradictions.
function reconcileScan(rec) {
  const before = { signalCount: rec.signalCount, delta: rec.candidate ? rec.candidate.delta : undefined };
  if (Array.isArray(rec.signals)) rec.signalCount = rec.signals.length;
  if (rec.candidate && typeof rec.candidate.delta === "number" && (rec.direction === "put" || rec.direction === "call")) {
    const want = rec.direction === "put" ? -1 : 1;
    if (rec.candidate.delta !== 0 && Math.sign(rec.candidate.delta) !== want) {
      rec.candidate.delta = Math.abs(rec.candidate.delta) * want;
    }
  }
  const changed = before.signalCount !== rec.signalCount ||
    (rec.candidate && before.delta !== rec.candidate.delta);
  if (changed) rec.reportedByModel = before; // telemetry: keep the model's original read
  return rec;
}

// ── Run a Claude Code scan ────────────────────────────────────────────────────

async function runScan(instruction = null, opts = {}) {
  // Derive every concrete number from PARAMS so the task line can never
  // contradict the SYSTEM_PROMPT. Previously this hardcoded "9:35–11:00 AM ET
  // only", which fought the system prompt's entryWindowEnd (e.g. 13:00) and made
  // the agent anchor on 11:00 — silently suppressing every afternoon entry.
  const prompt = instruction || [
    `Autonomous scan. Today is ${getETDate()}, ET time is ${getETTime()}.`,
    `Run full decision framework: check SPY vs open (need >${PARAMS.minMovePct}% move), VIX (need ${PARAMS.vixMin}–${PARAMS.vixMax}), open positions.`,
    `Entry window ${PARAMS.entryWindowStart}–${PARAMS.entryWindowEnd} ET ONLY (manage-only after). ${PARAMS.maxContracts} contract(s) max, $${PARAMS.maxOutlay} max outlay.`,
    `Do NOT place any resting take-profit/backstop limit at entry — the code watcher owns exits (momentum-stall profit-take once in profit + ${PARAMS.stopPct}% hard stop). Just enter cleanly. Place at most ONE entry order this scan. Close all SPY 0DTE by 3:45 PM ET.`,
    opts.noEntryReason ? `⛔ CODE GATE ACTIVE — DO NOT OPEN ANY NEW POSITION THIS SCAN (${opts.noEntryReason}). Manage-only.` : null,
    `Execute autonomously.`,
  ].filter(Boolean).join(" ");

  await push({ type: "info", content: `▶ Scan started — ${getETTime()}`, scanningNow: true });
  await push({ type: "scan_start" });

  const startedAt = Date.now();
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
      "--max-turns", String(opts.maxTurns || 30),
      "-p", fullPrompt,
    ], {
      env: envForClaude,
      timeout: SCAN_TIMEOUT_MS,
      maxBuffer: 10 * 1024 * 1024, // 10MB — default 1MB can overflow a verbose scan and get mis-killed (looks like a timeout)
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
    const account = extractJson(text, "ACCOUNT_JSON");

    // Append this scan's structured read to the learning journal (best-effort).
    // Every scan — trade or not — becomes a labeled observation we can review later.
    try {
      const rec = extractJson(text, "SCAN_JSON");
      if (rec) {
        reconcileScan(rec); // enforce signalCount===signals.length and delta sign===direction
        rec.ts = Date.now();
        rec.etDate = getETDate();
        rec.etTime = getETTime();
        appendFileSync(JOURNAL_FILE, JSON.stringify(rec) + "\n");
        console.log(`[${getETTime()}] Journaled scan: decision=${rec.decision} signals=${rec.signalCount}${rec.reportedByModel ? " (reconciled)" : ""}`);
      }
    } catch (e) {
      console.error("Journal append failed:", e.message);
    }

    // Push the full scan output + latest account snapshot.
    await push({
      type: "agent",
      content: text,
      ...(account ? { account } : {}),
    });

    console.log(`[${getETTime()}] Scan done in ${Math.round((Date.now() - startedAt) / 1000)}s.`);
  } catch (err) {
    const elapsedS = Math.round((Date.now() - startedAt) / 1000);
    const capS = Math.round(SCAN_TIMEOUT_MS / 1000);
    // execFileSync hides the real reason in err.stdout/err.stderr — surface it, and
    // keep a tail of whatever the scan emitted before dying so an intermittent stall
    // is debuggable next time (did auth succeed? how many tool calls landed?).
    const detail = [err.stderr, err.stdout].map(x => (x || "").toString().trim()).filter(Boolean).join(" | ");
    const tail = detail ? ` — last output: …${detail.slice(-300)}` : "";
    const maxBuf = /maxBuffer/i.test(err.message || "");
    const timedOut = err.killed || err.signal === "SIGTERM" || /ETIMEDOUT|timed out/i.test(err.message || "");

    // A scan can stall on an expired Robinhood OAuth — the CLI prints the sign-in
    // URL but never returns, so it's killed at the cap and looks like a plain
    // timeout. Catch that in the partial output and escalate as auth instead.
    if (/https?:\/\/[^\s"]*oauth|claude\.ai\/oauth|agent\.robinhood.*auth|sign.?in.*required|needs?.auth/i.test(detail)) {
      const urlMatch = detail.match(/https?:\/\/[^\s"]+/);
      await push({ type: "error", content: `⚠️ Robinhood auth looks expired (scan stalled ${elapsedS}s). Re-auth on the VPS: cd /root/spy-trader && source .env && claude -p "check robinhood"${urlMatch ? `\n\nURL: ${urlMatch[0]}` : ""}` });
      console.error(`[${getETTime()}] Scan stalled on Robinhood auth (${elapsedS}s)`);
    } else {
      const reason = maxBuf ? `output too large after ${elapsedS}s (maxBuffer exceeded)`
                   : /max turns/i.test(detail) ? `hit max turns (scan too long, ${elapsedS}s)`
                   : timedOut ? `timed out after ${elapsedS}s (cap ${capS}s)`
                   : (detail || err.message || "unknown error").slice(0, 200);
      await push({ type: "error", content: `VPS scan error: ${reason}${tail}` });
      console.error(`Scan error: ${reason}${tail}`);
    }
  } finally {
    // ALWAYS reconcile account data + closed round trips, even if the scan above
    // errored or timed out. Win/loss + realized P&L are counted from order history
    // (see pushAccountData), catching both agent-executed and manual closes.
    try { await pushAccountData(); } catch {}
    await push({ scanningNow: false });
  }
}

// ── FAST_PATH: code-gathered snapshot + gated LLM ─────────────────────────────

function withinEntryWindow() {
  const et = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
  const mins = et.getHours() * 60 + et.getMinutes();
  const [sh, sm] = String(PARAMS.entryWindowStart).split(":").map(Number);
  const [eh, em] = String(PARAMS.entryWindowEnd).split(":").map(Number);
  return mins >= sh * 60 + sm && mins < eh * 60 + em;
}

function etMinutesNow() {
  const et = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
  return et.getHours() * 60 + et.getMinutes();
}

// ── Code-enforced entry gates + stale-entry sweep ─────────────────────────────
// The Jun 28 + Jul 1 reviews showed the frequency rules were prose the LLM
// ignored (6 round-trips on 6/30; two concurrent positions + a $706 outlay on
// 7/1). These gates run in CODE before the LLM is ever woken, so they cannot be
// ignored. The 7/1 double-position root cause — a buy limit that sat 20 min
// unfilled and was invisible to the position snapshot — is covered two ways:
// working buy orders block new entries, and the sweep cancels them after
// ENTRY_ORDER_MAX_AGE_MS (a marketable limit that hasn't filled in ~90s is
// mispriced; don't leave a GFD buy resting while scans continue).
const ENTRY_ORDER_MAX_AGE_MS = Number(process.env.ENTRY_ORDER_MAX_AGE_MS) || 90 * 1000;
const MIDDAY_GATE_MIN = 11 * 60; // after 11:00 ET, require >= 3 agreeing signals (hard)

function todayETISO() {
  return new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
}

// Cancel working SPY buy orders older than the age cap. Returns the buys still
// live after the sweep (i.e. young ones — an entry legitimately in flight).
async function sweepStaleEntryOrders(workingBuys) {
  const still = [];
  for (const wb of workingBuys) {
    if (wb.ageMs < ENTRY_ORDER_MAX_AGE_MS) { still.push(wb); continue; }
    try {
      await cancelOptionOrder(wb.order);
      const ageS = Math.round(wb.ageMs / 1000);
      console.log(`[${getETTime()}] Canceled stale entry order ${wb.order.id} (unfilled ${ageS}s)`);
      await push({ type: "warn", content: `🧹 Canceled stale entry order (unfilled ${ageS}s, limit ${wb.order.price}) — a marketable limit should fill in seconds` });
    } catch (e) {
      console.error(`Stale-entry cancel ${wb.order.id} failed:`, e.message);
      still.push(wb); // cancel failed → still treat it as working (blocks new entries)
    }
  }
  return still;
}

// Returns a blocking reason string, or null if a new entry is allowed.
// FAIL-CLOSED: if the gate data can't be fetched, entries are blocked this tick
// (capital protection first; the next tick retries).
async function checkEntryGates() {
  try {
    const todayET = todayETISO();
    const st = await getTodaySpyEntryState(todayET);
    const working = await sweepStaleEntryOrders(st.workingBuys);
    if (working.length) return `entry order already working (${working.length})`;
    const maxEntries = Number(PARAMS.maxEntriesPerDay ?? 2);
    if (st.entries.length >= maxEntries) return `daily entry cap reached (${st.entries.length}/${maxEntries})`;
    const closes = await getTodayClosedSpyRoundTrips(todayET); // newest first
    if (closes.length >= 2 && closes[0].realizedPnl < 0 && closes[1].realizedPnl < 0)
      return "2 consecutive losses — halted for the day";
    return null;
  } catch (e) {
    console.error("Entry-gate check failed (fail-closed):", e.message);
    return `gate check failed (${e.message.slice(0, 80)})`;
  }
}

function fastStatusLine(snap, sig, decision, reason) {
  const pct = snap.spy.pctFromOpen != null ? `${snap.spy.pctFromOpen >= 0 ? "+" : ""}${snap.spy.pctFromOpen.toFixed(2)}%` : "n/a";
  const sigs = sig.signals.length ? sig.signals.join("+") + (sig.direction ? ` ${sig.direction}` : "") : "none";
  return `⚡ ${getETTime()} — SPY ${snap.spy.price} (${pct}), ${sig.vwapSide} VWAP, signals: ${sigs} → ${decision} (${reason}) · VIX ${snap.vix ?? "n/a"} · code`;
}

function journalCodeScan(snap, sig, decision, reason) {
  try {
    const rec = {
      spy: snap.spy.price,
      pctFromOpen: snap.spy.pctFromOpen != null ? Math.round(snap.spy.pctFromOpen * 100) / 100 : null,
      vwapSide: sig.vwapSide, openingRange: sig.openingRange,
      vix: snap.vix, trend: snap.trend,
      signals: sig.signals, signalCount: sig.signalCount,
      regimeOk: sig.vixOk, decision, direction: sig.direction,
      reason, candidate: null, entry: null,
      ts: Date.now(), etDate: getETDate(), etTime: getETTime(), source: "code",
    };
    appendFileSync(JOURNAL_FILE, JSON.stringify(rec) + "\n");
    console.log(`[${getETTime()}] FAST journaled: ${decision} signals=${sig.signalCount} (${reason})`);
  } catch (e) { console.error("Code journal failed:", e.message); }
}

// Build the instruction for a woken LLM scan: hand it the verified snapshot so it
// skips the ~20-turn reconnaissance and goes straight to decide/execute.
function buildFastInstruction(snap, sig) {
  const spyPos = snap.positions.filter(p => p.isSpy0dte);
  const other = snap.positions.filter(p => !p.isSpy0dte).map(p => `${p.symbol} ${p.type} ${p.strike} ${p.expiry}`);
  return [
    `Autonomous scan. Today ${snap.etDate}, ET ${snap.etTime}.`,
    ``,
    `A VERIFIED market snapshot was already gathered in code — TRUST these numbers and DO NOT re-fetch SPY price / VWAP / opening range / VIX / positions. (Re-fetch ONLY the 0DTE option chain with greeks IF you decide to enter, for strike selection.)`,
    `- SPY ${snap.spy.price} | open ${snap.spy.open} | ${snap.spy.pctFromOpen?.toFixed(2)}% from open | hi ${snap.spy.high} / lo ${snap.spy.low}`,
    `- VWAP ${snap.vwap?.toFixed(2)} → SPY is ${sig.vwapSide} VWAP`,
    `- Opening range (9:30-9:45) ${snap.openingRange ? `${snap.openingRange.low}-${snap.openingRange.high}` : "n/a"} → ${sig.openingRange}`,
    `- VIX ${snap.vix} → regime ${sig.vixOk ? "OK" : "OUT OF BAND"}`,
    `- 5-min trend ${snap.trend}`,
    `- Signals firing (code-computed, agreeing with direction): [${sig.signals.join(", ")}] → direction ${sig.direction ?? "none"} (count ${sig.signalCount}; need >=${PARAMS.minSignals})`,
    `- Open SPY 0DTE positions: ${spyPos.length ? JSON.stringify(spyPos) : "none"}`,
    other.length ? `- OTHER holdings — NEVER touch, never close: ${other.join("; ")}` : ``,
    `- Account: buyingPower ${snap.account?.buyingPower}, portfolioValue ${snap.account?.portfolioValue}`,
    ``,
    `Apply the full decision framework with these numbers. Entry window ${PARAMS.entryWindowStart}-${PARAMS.entryWindowEnd} ET ONLY (manage-only after). Do NOT place any resting take-profit — the code watcher owns ALL exits (momentum-stall profit-take + hard stop + 3:45 close); manage any open SPY 0DTE per Step 6 (hard stop, underlying invalidation, time-of-day) only. Place at most ONE entry order this scan, and never while another buy order is still working. ${PARAMS.maxContracts} contract(s) max, $${PARAMS.maxOutlay} max outlay. Execute autonomously. ALWAYS emit the ACCOUNT_JSON and SCAN_JSON footers.`,
  ].filter(Boolean).join("\n");
}

async function runScanFast() {
  let snap;
  try {
    snap = await getSnapshot();
  } catch (e) {
    console.error("FAST_PATH snapshot threw — falling back to full scan:", e.message);
    return runScan();
  }
  // If the code data path is unhealthy (no price), fall back to the legacy LLM+MCP
  // scan so we never lose coverage on a bad data day or if the REST creds expire.
  if (!snap || snap.spy.price == null) {
    const errs = (snap?.errors || []).join("; ").slice(0, 160);
    console.error(`FAST_PATH snapshot unhealthy (${errs}) — falling back to full scan`);
    await push({ type: "info", content: `⚡ Fast snapshot incomplete${errs ? ` (${errs})` : ""} — using full scan` });
    return runScan();
  }

  const sig = computeSignals(snap, PARAMS);
  const spyPositions = snap.positions.filter(p => p.isSpy0dte && Number(p.qty) !== 0);
  const hasPos = spyPositions.length > 0;
  const inWindow = withinEntryWindow();
  // Wake the LLM ONLY to ENTER: flat, in the entry window, with signals firing. The code
  // watcher (watch.mjs) owns ALL exits/management (stall + hard stop + 3:45 close), so we no
  // longer spend a 16-turn LLM scan every cycle just to "manage" an open position — that was
  // the bulk of the Claude burn. When a position is open we skip the LLM entirely.
  // MIDDAY HARD GATE: after 11:00 ET the wake bar rises to 3 agreeing signals — the
  // 11:00–12:30 lull is the documented dead zone (7/1's only loser entered 12:19 ET).
  const midday = etMinutesNow() >= MIDDAY_GATE_MIN;
  const wakeThreshold = midday
    ? Math.max(Number(PARAMS.minSignals || 2), 3)
    : Math.max(1, (PARAMS.minSignals || 2) - 1);
  let actionable = !hasPos && inWindow && sig.signalCount >= wakeThreshold;

  // Entry gates (code-enforced, checked only when we'd otherwise wake the LLM):
  // working buy order, daily entry cap, 2-consecutive-red halt. Also sweeps stale
  // unfilled entry limits as a side effect.
  let gateReason = null;
  if (actionable) {
    gateReason = await checkEntryGates();
    if (gateReason) actionable = false;
  }

  // Refresh the dashboard book from the cheap, accurate snapshot every cycle.
  await push({ account: {
    accountNumber: ACCOUNT_NUMBER,
    buyingPower: snap.account?.buyingPower,
    portfolioValue: snap.account?.portfolioValue,
    positions: snap.positions,
  } });
  await push({ type: "scan_start" });

  if (!actionable) {
    const reason = gateReason ? `entry gate: ${gateReason}`
      : hasPos ? "position open — watcher manages exits"
      : !inWindow ? "flat, outside entry window"
      : midday && sig.signalCount >= (PARAMS.minSignals || 2) ? `midday gate: ${sig.signalCount}/3 signals (post-11:00 ET needs 3)`
      : `only ${sig.signalCount}/${wakeThreshold} signals firing`;
    journalCodeScan(snap, sig, "WAIT", reason);
    await push({ type: "info", content: fastStatusLine(snap, sig, "WAIT", reason), scanningNow: false });
    console.log(`[${getETTime()}] FAST skip — ${reason}`);
    // Closes / realized P&L are reconciled by the separate 15-min account refresh,
    // so skipping the LLM here drops no trade accounting.
    return;
  }

  // Actionable → wake the LLM with the snapshot and a smaller turn budget (no
  // 20-turn recon needed). Same lock + wall-clock timeout as a normal scan.
  console.log(`[${getETTime()}] FAST wake LLM — entry (signals ${sig.signalCount})`);
  await runScan(buildFastInstruction(snap, sig), { maxTurns: 16 });
}

// ── Main ──────────────────────────────────────────────────────────────────────

const state = loadState();

// Serialize cron ticks before doing anything expensive (or consuming the pending
// action). If a previous invocation is still running its account refresh or scan,
// bail immediately rather than starting an overlapping run.
if (!acquireLock()) {
  console.log("Another agent run in progress — skipping this tick");
  process.exit(0);
}

const { enabled, interval, action } = await getPending();

// Push current strategy levers + change/proposal history so the dashboard can
// show them and the user can see what's being tried (cheap; no Claude call).
async function pushStrategy() {
  try {
    const L = loadLayers();
    await push({ strategy: {
      params: loadParams(), sources: paramSources(),
      manual: L.manual, learned: L.learned,
      history: readJsonl(HISTORY_FILE), proposals: readJsonl(PROPOSALS_FILE),
    } });
  } catch (e) { console.error("Strategy push failed:", e.message); }
}

// Handle pending commands from dashboard (close_all, manual scan, manual lever change)
if (action) {
  if (action.type === "close_all") {
    await runScan(`URGENT: Close ALL open SPY 0DTE option positions immediately on account ${ACCOUNT_NUMBER} — SPY 0DTE OPTIONS ONLY. Check positions, then market-close each SPY 0DTE option. Do NOT sell, close, or modify any other option, any other-expiry contract, or any equity/stock/ETF — leave every non-SPY-0DTE holding completely untouched.`);
  } else if (action.type === "scan") {
    await runScan(action.instruction || null);
  } else if (action.type === "set_params") {
    // Manual lever change from the dashboard — clamp + write to the MANUAL layer.
    setManual(action.change || {}, { source: "manual" });
    await push({ type: "info", content: `🛠 Strategy levers set manually: ${JSON.stringify(action.change || {})}` });
    await pushStrategy();
    process.exit(0);
  } else if (action.type === "reset_params") {
    const eff = resetParams(action.keys, { source: "reset" });
    await push({ type: "info", content: `↺ Levers reset to baseline${action.keys && action.keys.length ? " (" + action.keys.join(", ") + ")" : " (all)"}` });
    await pushStrategy();
    process.exit(0);
  }
  saveState({ ...state, lastScanTime: Date.now() });
  process.exit(0);
}

// Push account data (buying power, portfolio value, open positions) AND today's
// closed SPY round trips reconciled from order history. The closes carry the
// closing order's id so the server can count each one exactly once — this is how
// both agent-executed AND manually-closed positions get into win-rate/P&L.
//
// COST: this is pure bookkeeping, so it's done with direct Robinhood REST calls
// (rhApi.js) — NO Claude. The old LLM version spawned a 16-turn Sonnet+MCP
// session every 15 min (7am–8pm) PLUS after every scan (~90 sessions/day) and was
// the single largest Claude burn. The LLM path is kept below ONLY as a fallback
// for when the REST creds are missing/expired, so the dashboard never goes dark.
async function pushAccountData() {
  try {
    const { buying_power, portfolio_value, positions } = await getAccountData();
    let closes = [];
    try {
      const todayET = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
      closes = await getTodayClosedSpyRoundTrips(todayET);
    } catch (e) {
      console.error("Closes reconcile failed (account snapshot still pushed):", e.message);
    }
    await push({
      account: {
        accountNumber: ACCOUNT_NUMBER,
        buyingPower: buying_power,
        portfolioValue: portfolio_value,
        positions,
      },
      ...(closes.length ? { closes } : {}),
    });
    console.log(`[${getETTime()}] Account refresh (REST): pv=${portfolio_value} positions=${positions.length} closes=${closes.length}`);
  } catch (e) {
    console.error(`Account refresh via REST failed (${e.message}) — falling back to LLM`);
    await pushAccountDataLLM();
  }
}

// Legacy LLM-based account refresh — FALLBACK ONLY (REST creds missing/expired).
async function pushAccountDataLLM() {
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

// Decide whether a scan is due and CLAIM THE SLOT up front, before the
// long-running account refresh below. pushAccountData() shells out to `claude`
// (up to ~150s); the old code wrote lastScanTime only after that call, so a tick
// firing during the refresh read a stale timestamp and launched a duplicate scan.
// Writing it here means the next tick already sees this scan accounted for. (The
// run-lock above is the primary guard; this is the belt-and-suspenders half.)
const intervalMs = (interval || 10) * 60 * 1000;
const sinceLastScan = state.lastScanTime ? Date.now() - state.lastScanTime : Infinity;
const scanDue = enabled && isMarketHours() && sinceLastScan >= intervalMs;
if (scanDue) {
  state.lastScanTime = Date.now();
  saveState(state); // claim the slot now, before any long-running work
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
  await pushStrategy();
  state.lastAccountPush = Date.now();
  saveState(state);
}

// Skip if disabled or outside market hours
if (!enabled) { console.log("Agent disabled"); process.exit(0); }
if (!isMarketHours()) { console.log("Outside market hours"); process.exit(0); }

// EVERY tick during market hours: cancel stale unfilled entry limits. This runs
// even between scans, so an unfilled GFD buy can never sit for 20 minutes again
// (the 7/1 double-position root cause). One cheap REST call per minute.
try {
  const { workingBuys } = await getTodaySpyEntryState(todayETISO());
  if (workingBuys.length) await sweepStaleEntryOrders(workingBuys);
} catch (e) { console.error("Stale-entry sweep failed:", e.message); }

// Run the scan if it was due (the slot was already claimed above).
if (!scanDue) {
  const wait = Math.round((intervalMs - sinceLastScan) / 60000);
  console.log(`Next scan in ~${wait}m`);
  process.exit(0);
}
if (FAST_PATH) await runScanFast();
else {
  // Legacy full-scan path: the entry gates can't physically stop the LLM here,
  // so a hit gate becomes a hard manage-only instruction in the prompt.
  const gate = await checkEntryGates();
  await runScan(null, gate ? { noEntryReason: gate } : {});
}
