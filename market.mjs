/**
 * market.mjs — Deterministic SPY market snapshot + signal engine (NO LLM).
 *
 * Pulls everything Step-1 reconnaissance needs straight from the Robinhood REST
 * API (via rhApi.js) and FMP (VIX), in parallel, in ~1–2s — replacing the ~20
 * sequential MCP turns the agent currently spends gathering data. The four
 * signals are computed in code from the strategy's exact definitions, so they're
 * consistent (no LLM self-report drift, which the log review flagged) and fast.
 *
 * This module is intentionally STANDALONE and READ-ONLY: it never places orders
 * and is not yet imported by the trading loop. Run it directly to self-test:
 *
 *     node market.mjs
 *
 * It prints the snapshot + computed signals as JSON. Requires, in the same .env
 * the agent uses:
 *     ROBINHOOD_REFRESH_TOKEN   (or ROBINHOOD_TOKEN)   — for the RH REST reads
 *     FMP_API_KEY                                       — for the ^VIX read
 *
 * Verify the printed numbers against the live dashboard/market BEFORE any trading
 * logic is wired to depend on this.
 */

import { getAccountData, rhGet } from "./rhApi.js";

const FMP_BASE = "https://financialmodelingprep.com/api/v3";
// FMP_API_KEY is read at call time inside fetchVix (not at module load) so it's
// still picked up when the parent process loads .env via dotenv AFTER importing
// this file.

// ── ET time helpers ───────────────────────────────────────────────────────────
function etTimeStr() {
  return new Date().toLocaleTimeString("en-US", {
    timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
}
function etDateStr() {
  return new Date().toLocaleDateString("en-US", { timeZone: "America/New_York" });
}
// "YYYY-MM-DD" for today in ET (matches Robinhood option expiry strings).
function etISODate() {
  const p = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());
  return p; // en-CA formats as YYYY-MM-DD
}
// ET date (YYYY-MM-DD) of a specific timestamp — used to reject stale (non-today) bars.
function etISODateOf(isoTs) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date(isoTs));
}
// Minutes-since-midnight ET for a given ISO timestamp (used to bucket bars).
function etMinutesOf(isoTs) {
  const et = new Date(new Date(isoTs).toLocaleString("en-US", { timeZone: "America/New_York" }));
  return et.getHours() * 60 + et.getMinutes();
}

// ── Individual fetchers (each resilient; throw on failure, caught upstream) ─────

async function fetchSpyQuote() {
  const q = await rhGet("/quotes/SPY/");
  return {
    price: parseFloat(q.last_trade_price ?? q.last_extended_hours_trade_price ?? 0) || null,
    prevClose: parseFloat(q.previous_close ?? q.adjusted_previous_close ?? 0) || null,
    bid: parseFloat(q.bid_price ?? 0) || null,
    ask: parseFloat(q.ask_price ?? 0) || null,
  };
}

// Today's regular-session 5-min bars → open, VWAP, opening range, trend.
async function fetchSpyBars() {
  const data = await rhGet("/marketdata/historicals/SPY/?interval=5minute&span=day&bounds=regular");
  const raw = data.historicals || data.results?.[0]?.historicals || [];
  return raw
    .map(b => ({
      t: b.begins_at,
      open: parseFloat(b.open_price),
      high: parseFloat(b.high_price),
      low: parseFloat(b.low_price),
      close: parseFloat(b.close_price),
      volume: parseFloat(b.volume || 0),
    }))
    .filter(b => Number.isFinite(b.close));
}

// FMP reorganized into "stable" endpoints; newer keys return 403 on the legacy
// /api/v3 path (which is what we first hit). Try stable first, fall back to v3,
// and surface both statuses if neither works.
async function fetchVix() {
  const FMP_API_KEY = process.env.FMP_API_KEY;
  if (!FMP_API_KEY) throw new Error("FMP_API_KEY not set");
  const urls = [
    `https://financialmodelingprep.com/stable/quote?symbol=%5EVIX&apikey=${FMP_API_KEY}`,
    `${FMP_BASE}/quote/%5EVIX?apikey=${FMP_API_KEY}`,
  ];
  const problems = [];
  for (const url of urls) {
    const which = url.includes("/stable/") ? "stable" : "v3";
    try {
      const r = await fetch(url);
      if (!r.ok) { problems.push(`HTTP ${r.status} (${which})`); continue; }
      const arr = await r.json();
      const row = Array.isArray(arr) ? arr[0] : arr;
      const price = row ? parseFloat(row.price ?? row.previousClose) : NaN;
      if (Number.isFinite(price)) return price;
      problems.push(`bad payload (${which}): ${JSON.stringify(arr).slice(0, 120)}`);
    } catch (e) {
      problems.push(`${e.message} (${which})`);
    }
  }
  throw new Error(`FMP VIX failed — ${problems.join(" | ")}`);
}

// ── Derived metrics (pure functions over bars) ─────────────────────────────────

function computeVwap(bars) {
  let pv = 0, vol = 0;
  for (const b of bars) {
    const typical = (b.high + b.low + b.close) / 3;
    pv += typical * b.volume;
    vol += b.volume;
  }
  return vol > 0 ? pv / vol : null;
}

// Opening range = high/low of the 9:30–9:45 ET bars (first three 5-min bars).
// Fixed for the day once 9:45 passes — the whole point of caching it.
function computeOpeningRange(bars) {
  const orBars = bars.filter(b => {
    const m = etMinutesOf(b.t);
    return m >= 9 * 60 + 30 && m < 9 * 60 + 45;
  });
  if (!orBars.length) return null;
  return { high: Math.max(...orBars.map(b => b.high)), low: Math.min(...orBars.map(b => b.low)) };
}

// Deterministic 5-min trend read over the last ~6 bars: higher-highs/higher-lows
// = bull, lower-lows/lower-highs = bear, otherwise chop.
function computeTrend(bars) {
  const n = bars.slice(-6);
  if (n.length < 4) return "chop";
  const mid = Math.floor(n.length / 2);
  const firstHigh = Math.max(...n.slice(0, mid).map(b => b.high));
  const lastHigh = Math.max(...n.slice(mid).map(b => b.high));
  const firstLow = Math.min(...n.slice(0, mid).map(b => b.low));
  const lastLow = Math.min(...n.slice(mid).map(b => b.low));
  if (lastHigh > firstHigh && lastLow > firstLow) return "bull";
  if (lastHigh < firstHigh && lastLow < firstLow) return "bear";
  return "chop";
}

// ── Snapshot ───────────────────────────────────────────────────────────────────

/**
 * Fetches the full market + account snapshot in parallel. Individual failures
 * degrade gracefully: the field is null and the reason is added to `errors`
 * (mirrors the strategy's "if a data point isn't available, note it and proceed").
 */
export async function getSnapshot() {
  const [quoteR, barsR, vixR, acctR] = await Promise.allSettled([
    fetchSpyQuote(), fetchSpyBars(), fetchVix(), getAccountData(),
  ]);

  const quote = quoteR.status === "fulfilled" ? quoteR.value : null;
  const allBars = barsR.status === "fulfilled" ? barsR.value : [];
  const vix   = vixR.status   === "fulfilled" ? vixR.value   : null;
  const acct  = acctR.status  === "fulfilled" ? acctR.value  : null;

  const errors = [];
  for (const [name, r] of [["quote", quoteR], ["bars", barsR], ["vix", vixR], ["account", acctR]]) {
    if (r.status === "rejected") errors.push(`${name}: ${r.reason?.message || r.reason}`);
  }
  // Reject STALE bars: keep only bars dated TODAY (ET). Guards against the historicals
  // feed returning the prior session (e.g. pre-open), which would compute open/VWAP/OR
  // off the wrong day. If this leaves no bars, signal fields degrade to null → safe WAIT.
  const todayISO = etISODate();
  const bars = allBars.filter(b => etISODateOf(b.t) === todayISO);
  if (allBars.length && !bars.length) errors.push("bars: stale (none dated today) — signals degraded");

  const open = bars.length ? bars[0].open : null;
  const price = quote?.price ?? (bars.length ? bars[bars.length - 1].close : null);
  const pctFromOpen = (open && price) ? ((price - open) / open) * 100 : null;
  const vwap = bars.length ? computeVwap(bars) : null;
  const or = bars.length ? computeOpeningRange(bars) : null;
  const trend = bars.length ? computeTrend(bars) : "chop";
  const high = bars.length ? Math.max(...bars.map(b => b.high)) : null;
  const low = bars.length ? Math.min(...bars.map(b => b.low)) : null;

  // Tag SPY 0DTE positions (today's expiry) so the management logic can find them.
  const positions = (acct?.positions || []).map(p => ({
    ...p,
    isSpy0dte: p.symbol === "SPY" && p.expiry === todayISO,
  }));

  return {
    ts: Date.now(), etDate: etDateStr(), etTime: etTimeStr(),
    spy: {
      price, open, pctFromOpen,
      high, low, prevClose: quote?.prevClose ?? null,
      bid: quote?.bid ?? null, ask: quote?.ask ?? null,
    },
    vwap, openingRange: or, vix, trend,
    lastBarClose: bars.length ? bars[bars.length - 1].close : null,
    account: acct ? { buyingPower: acct.buying_power, portfolioValue: acct.portfolio_value } : null,
    positions,
    barsCount: bars.length,
    errors,
  };
}

// ── Signals (code-computed, per the strategy's exact definitions) ──────────────

/**
 * Computes the four directional signals deterministically. `direction` is the
 * majority of FIRING signals; a tie with both sides firing is a CONFLICT → null.
 * `signals` lists exactly the firing signals that AGREE with `direction`, so
 * signalCount === signals.length by construction (the count/sign bugs the log
 * review found are impossible here).
 *
 * params needs: minMovePct, vixMin, vixMax.
 */
export function computeSignals(snap, params) {
  const fired = {};
  const votes = { call: 0, put: 0 };

  // move: |% from open| >= minMovePct → votes the side of the move
  if (snap.spy.pctFromOpen != null && Math.abs(snap.spy.pctFromOpen) >= params.minMovePct) {
    const dir = snap.spy.pctFromOpen > 0 ? "call" : "put";
    fired.move = dir; votes[dir]++;
  }
  // vwap: price must be CLEARLY on one side (>=0.10%, not a 0.03% rounding wobble) AND the
  // last completed 5-min bar must confirm it ("holding it", per the strategy) — kills the
  // flip-flop when price oscillates right around VWAP.
  if (snap.vwap != null && snap.spy.price != null) {
    const diffPct = ((snap.spy.price - snap.vwap) / snap.vwap) * 100;
    const lc = snap.lastBarClose;
    const holding = lc == null || Math.sign(lc - snap.vwap) === Math.sign(snap.spy.price - snap.vwap);
    if (Math.abs(diffPct) >= 0.10 && holding) {
      const dir = diffPct > 0 ? "call" : "put";
      fired.vwap = dir; votes[dir]++;
    }
  }
  // or_breakout: trading beyond the 9:30–9:45 opening range
  if (snap.openingRange && snap.spy.price != null) {
    if (snap.spy.price > snap.openingRange.high) { fired.or_breakout = "call"; votes.call++; }
    else if (snap.spy.price < snap.openingRange.low) { fired.or_breakout = "put"; votes.put++; }
  }
  // trend: 5-min structure
  if (snap.trend === "bull") { fired.trend = "call"; votes.call++; }
  else if (snap.trend === "bear") { fired.trend = "put"; votes.put++; }

  let direction = null;
  if (votes.call > votes.put) direction = "call";
  else if (votes.put > votes.call) direction = "put";
  // both>0 and equal = conflict → null; both 0 = no signals → null

  const signals = direction ? Object.keys(fired).filter(k => fired[k] === direction) : [];
  const vixOk = snap.vix != null && snap.vix >= params.vixMin && snap.vix <= params.vixMax;

  return {
    signals,
    signalCount: signals.length,
    direction,
    fired,
    votes,
    vixOk,
    conflict: votes.call > 0 && votes.call === votes.put,
    vwapSide: (snap.vwap != null && snap.spy.price != null)
      ? (snap.spy.price > snap.vwap ? "above" : snap.spy.price < snap.vwap ? "below" : "at")
      : "na",
    openingRange: (snap.openingRange && snap.spy.price != null)
      ? (snap.spy.price > snap.openingRange.high ? "breakout_up"
        : snap.spy.price < snap.openingRange.low ? "breakout_down" : "inside")
      : "na",
  };
}

// ── Self-test: `node market.mjs` ───────────────────────────────────────────────
if (import.meta.url === `file://${process.argv[1]}`) {
  const DEFAULTS = { minMovePct: 0.4, vixMin: 16, vixMax: 35 };
  getSnapshot()
    .then(snap => {
      const sig = computeSignals(snap, DEFAULTS);
      console.log(JSON.stringify({ snapshot: snap, signals: sig }, null, 2));
      if (snap.errors.length) {
        console.error("\n⚠️  Some fetches failed — check creds/endpoints:\n  " + snap.errors.join("\n  "));
        process.exit(1);
      }
      console.log("\n✓ Snapshot OK — verify these numbers against the live market before wiring in.");
    })
    .catch(e => {
      console.error("Snapshot failed:", e?.message || e);
      process.exit(1);
    });
}
