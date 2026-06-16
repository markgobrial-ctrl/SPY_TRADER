/**
 * shadow.mjs — Objective shadow-test for proposed strategy parameter changes.
 *
 * Replays the scan journal under a parameter set and estimates how the entries
 * that set WOULD have taken performed, so we can compare a proposed config to the
 * current one on real observed conditions — not on the agents' opinions.
 *
 * Honesty about the model: we don't have historical 0DTE option prices, so each
 * hypothetical entry's return is ESTIMATED from the candidate option's delta and
 * premium applied to the realized 30-min SPY move, then clamped to the strategy's
 * stop/target (−40% / +150%). This is a relative comparison metric, not a precise
 * backtest. Treat results as directional evidence, and require a real sample.
 *
 * Only SAFE params are tunable: entryWindowEnd, minSignals, deltaLow, deltaHigh.
 * Risk controls are never shadow-tested or changed here.
 *
 * Usage:
 *   node shadow.mjs                      # evaluate current params over the journal
 *   node shadow.mjs '{"minSignals":3}'   # compare current vs current+override
 *   AUTO_PROMOTE=1 node shadow.mjs '{...}'  # write params.json IF it clearly wins
 */

import { readFileSync, existsSync, writeFileSync, appendFileSync } from "fs";

const JOURNAL_FILE = "/root/spy-trader/journal.jsonl";
const PARAMS_FILE = "/root/spy-trader/params.json";
const HISTORY_FILE = "/root/spy-trader/params-history.jsonl";
const DEFAULT_PARAMS = { entryWindowEnd: "11:00", minSignals: 2, deltaLow: 0.45, deltaHigh: 0.55 };

// Hard bounds — applied before ANY write, so even a malformed/extreme proposal
// (or an LLM that ignores the stated ranges) cannot push params out of a safe box.
export function clampParams(p) {
  const out = { ...DEFAULT_PARAMS, ...p };
  out.minSignals = Math.max(2, Math.min(4, Math.round(Number(out.minSignals) || 2)));
  out.deltaLow = Math.max(0.30, Math.min(0.65, Number(out.deltaLow) || 0.45));
  out.deltaHigh = Math.max(out.deltaLow + 0.05, Math.min(0.70, Number(out.deltaHigh) || 0.55));
  const m = Math.max(600, Math.min(660, hhmm(out.entryWindowEnd))); // 10:00–11:00 only
  out.entryWindowEnd = `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
  return out;
}

// Apply a promotion: clamp, write params.json, append an audit record.
export function promote(proposed, meta = {}) {
  const from = loadParams();
  const to = clampParams(proposed);
  writeFileSync(PARAMS_FILE, JSON.stringify(to, null, 2));
  try { appendFileSync(HISTORY_FILE, JSON.stringify({ ts: Date.now(), etDate: new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" }), from, to, ...meta }) + "\n"); } catch {}
  return to;
}

// Promotion gates — a proposal must clear ALL of these to auto-apply.
const MIN_ENTRIES = 25;      // need at least this many evaluated hypothetical entries
const MIN_EDGE_PP = 5;       // proposed avg return must beat current by ≥5 percentage points
const STOP = -0.40, TARGET = 1.50;

export function loadParams() {
  try { return { ...DEFAULT_PARAMS, ...JSON.parse(readFileSync(PARAMS_FILE, "utf8")) }; }
  catch { return { ...DEFAULT_PARAMS }; }
}

export function loadJournal(days = 60) {
  if (!existsSync(JOURNAL_FILE)) return [];
  const cutoff = Date.now() - days * 86400000;
  return readFileSync(JOURNAL_FILE, "utf8").split("\n").filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch { return null; } })
    .filter(r => r && typeof r.ts === "number" && r.ts >= cutoff)
    .sort((a, b) => a.ts - b.ts);
}

function etMinutes(ts) {
  const d = new Date(new Date(ts).toLocaleString("en-US", { timeZone: "America/New_York" }));
  return d.getHours() * 60 + d.getMinutes();
}
function hhmm(s) { const [h, m] = String(s).split(":").map(Number); return h * 60 + (m || 0); }

function forwardReturn(recs, i, minutes) {
  const target = recs[i].ts + minutes * 60000;
  for (let j = i + 1; j < recs.length; j++) {
    if (recs[j].etDate !== recs[i].etDate) break;
    if (recs[j].ts >= target && recs[i].spy > 0 && recs[j].spy > 0)
      return (recs[j].spy - recs[i].spy) / recs[i].spy;
  }
  return null;
}

// Replay the journal under `params`; return estimated entry performance.
export function evaluate(recs, params) {
  const endMin = hhmm(params.entryWindowEnd);
  let entries = 0, sumRet = 0, wins = 0;
  for (let i = 0; i < recs.length; i++) {
    const r = recs[i];
    const m = etMinutes(r.ts);
    if (m < 9 * 60 + 35 || m > endMin) continue;           // entry window
    if ((r.signalCount || 0) < params.minSignals) continue; // confluence
    const c = r.candidate;
    if (!c || !(c.premium > 0)) continue;                   // need a real candidate
    const d = Math.abs(c.delta ?? 0.5);
    if (d < params.deltaLow - 0.05 || d > params.deltaHigh + 0.05) continue; // delta band (±0.05 slack)
    const fr = forwardReturn(recs, i, 30);
    if (fr == null) continue;
    const lean = r.direction || (Number(r.pctFromOpen) >= 0 ? "call" : "put");
    const dirMoveDollars = (lean === "call" ? fr : -fr) * r.spy;  // $ move in leaned dir
    let optRet = (d * dirMoveDollars) / c.premium;               // est. option % return
    optRet = Math.max(STOP, Math.min(TARGET, optRet));          // clamp to stop/target
    entries++; sumRet += optRet; if (optRet > 0) wins++;
  }
  return {
    entries,
    avgRetPct: entries ? Math.round((sumRet / entries) * 1000) / 10 : null,
    winRatePct: entries ? Math.round((wins / entries) * 1000) / 10 : null,
  };
}

// ── CLI ───────────────────────────────────────────────────────────────────────
if (import.meta.url === `file://${process.argv[1]}`) {
  const recs = loadJournal(60);
  const current = loadParams();
  const override = process.argv[2] ? JSON.parse(process.argv[2]) : null;
  const proposed = override ? { ...current, ...override } : null;

  const cur = evaluate(recs, current);
  console.log(`Journal records: ${recs.length}`);
  console.log(`CURRENT  ${JSON.stringify(current)}`);
  console.log(`  entries=${cur.entries}  avgEstReturn=${cur.avgRetPct}%  estWinRate=${cur.winRatePct}%`);

  if (!proposed) process.exit(0);

  const pro = evaluate(recs, proposed);
  console.log(`PROPOSED ${JSON.stringify(proposed)}`);
  console.log(`  entries=${pro.entries}  avgEstReturn=${pro.avgRetPct}%  estWinRate=${pro.winRatePct}%`);

  const enough = pro.entries >= MIN_ENTRIES && cur.entries >= MIN_ENTRIES;
  const edge = (pro.avgRetPct ?? -999) - (cur.avgRetPct ?? -999);
  const wins = enough && edge >= MIN_EDGE_PP;
  console.log(`\nVERDICT: ${!enough ? `INSUFFICIENT DATA (need ≥${MIN_ENTRIES} entries each; have cur=${cur.entries}, pro=${pro.entries})`
    : wins ? `PROPOSED WINS by ${edge.toFixed(1)}pp avg return` : `HOLD — not a clear improvement (edge ${edge.toFixed(1)}pp, need ≥${MIN_EDGE_PP}pp)`}`);

  if (wins && process.env.AUTO_PROMOTE === "1") {
    const applied = promote(proposed, { edge: Math.round(edge * 10) / 10, source: "shadow-cli" });
    console.log(`PROMOTED → wrote ${PARAMS_FILE}: ${JSON.stringify(applied)}. Agent uses it on the next scan.`);
  } else if (wins) {
    console.log(`(Set AUTO_PROMOTE=1 to apply, or write params.json yourself.)`);
  }
}
