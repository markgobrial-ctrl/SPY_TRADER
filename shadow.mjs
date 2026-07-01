/**
 * shadow.mjs — Objective shadow-test for proposed strategy parameter changes.
 *
 * Replays the scan journal under a parameter set and estimates how the entries
 * that set WOULD have taken performed, so we can compare a proposed config to the
 * current one on real observed conditions — not on the agents' opinions.
 *
 * Honesty about the model: we don't have historical 0DTE option prices, so each
 * hypothetical entry's return is ESTIMATED from |delta| x the underlying's move
 * over premium, walked forward along the day's price path under the strategy's
 * real exit model (hard stop, trailing stop once armed, EOD close), clamped to the
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
const MANUAL_FILE = "/root/spy-trader/manual.json";   // user overrides (any lever)
const LEARNED_FILE = "/root/spy-trader/learned.json"; // auto-tuner overrides (safe keys only)
const HISTORY_FILE = "/root/spy-trader/params-history.jsonl";

function readJson(f) { try { return JSON.parse(readFileSync(f, "utf8")); } catch { return {}; } }
function writeJson(f, o) { writeFileSync(f, JSON.stringify(o, null, 2)); }
function pick(obj, keys) { const o = {}; for (const k of keys) if (obj[k] !== undefined) o[k] = obj[k]; return o; }
function logHistory(meta) { try { appendFileSync(HISTORY_FILE, JSON.stringify({ ts: Date.now(), etDate: new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" }), ...meta }) + "\n"); } catch {} }
export const DEFAULT_PARAMS = {
  entryWindowStart: "09:35", entryWindowEnd: "14:00",
  minSignals: 2, deltaLow: 0.45, deltaHigh: 0.55,
  maxContracts: 2, maxOutlay: 400, maxEntriesPerDay: 2,
  stopPct: 28, targetPct: 75, trailPct: 35, // targetPct = HIGH backstop limit; primary exit is the watcher momentum-stall
  vixMin: 16, vixMax: 35, minMovePct: 0.4,
  dailyLossLimit: 0,
};

// Bounds enforced on EVERY write (manual or auto), so even a malformed/extreme
// value cannot push a param out of a safe box.
export const BOUNDS = {
  entryWindowStart: { type: "time", min: "09:35", max: "10:30" },
  entryWindowEnd:   { type: "time", min: "10:00", max: "15:00" },
  minSignals:  { type: "int", min: 1, max: 4 },
  deltaLow:    { type: "num", min: 0.30, max: 0.65 },
  deltaHigh:   { type: "num", min: 0.35, max: 0.75 },
  maxContracts:{ type: "int", min: 1, max: 5 },
  maxOutlay:   { type: "int", min: 100, max: 1500 },
  maxEntriesPerDay: { type: "int", min: 1, max: 6 },
  stopPct:     { type: "int", min: 20, max: 60 },
  targetPct:   { type: "int", min: 10, max: 100 },
  trailPct:    { type: "int", min: 20, max: 50 },
  vixMin:      { type: "int", min: 10, max: 25 },
  vixMax:      { type: "int", min: 25, max: 50 },
  minMovePct:  { type: "num", min: 0.2, max: 1.0 },
  dailyLossLimit: { type: "int", min: 0, max: 1000 },
};
// The auto-tuner may ONLY ever propose these; manual edits may touch any key.
export const AUTO_KEYS = ["entryWindowEnd", "minSignals", "deltaLow", "deltaHigh"];

function minToTime(m) { return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`; }
function clampOne(b, v) {
  if (b.type === "time") return minToTime(Math.max(hhmm(b.min), Math.min(hhmm(b.max), hhmm(v))));
  let n = Number(v); if (Number.isNaN(n)) return undefined;
  if (b.type === "int") n = Math.round(n);
  return Math.max(b.min, Math.min(b.max, n));
}

// Clamp every provided key to its bounds; enforce cross-constraints.
export function clampParams(p) {
  const out = { ...DEFAULT_PARAMS, ...p };
  for (const k of Object.keys(BOUNDS)) {
    if (out[k] !== undefined && out[k] !== null) { const c = clampOne(BOUNDS[k], out[k]); if (c !== undefined) out[k] = c; }
  }
  if (out.deltaHigh <= out.deltaLow) out.deltaHigh = Math.min(0.75, Math.round((out.deltaLow + 0.05) * 100) / 100);
  if (out.vixMax <= out.vixMin) out.vixMax = Math.min(50, out.vixMin + 5);
  return out;
}

// Promotion gates — a proposal must clear ALL of these to auto-apply.
const MIN_ENTRIES = 25;      // need at least this many evaluated hypothetical entries
const MIN_EDGE_PP = 5;       // proposed avg return must beat current by ≥5 percentage points

// ── Layered params: baseline (code) ◄ learned (auto) ◄ manual (user) ──────────
export function loadLayers() {
  return { baseline: { ...DEFAULT_PARAMS }, learned: readJson(LEARNED_FILE), manual: readJson(MANUAL_FILE) };
}
export function loadParams() {
  const L = loadLayers();
  return { ...L.baseline, ...L.learned, ...L.manual };
}
// Per-lever provenance: "manual" | "learned" | "baseline".
export function paramSources() {
  const L = loadLayers(), out = {};
  for (const k of Object.keys(DEFAULT_PARAMS)) out[k] = (k in L.manual) ? "manual" : (k in L.learned) ? "learned" : "baseline";
  return out;
}

// User sets levers by hand. Clamp the merged result, store the touched keys in
// the manual layer (so they pin against the auto-tuner). Returns effective params.
export function setManual(change, meta = {}) {
  const L = loadLayers();
  const merged = clampParams({ ...L.baseline, ...L.learned, ...L.manual, ...change });
  const manual = { ...L.manual, ...pick(merged, Object.keys(change)) };
  writeJson(MANUAL_FILE, manual);
  logHistory({ layer: "manual", change: pick(merged, Object.keys(change)), source: meta.source || "manual" });
  return loadParams();
}

// Auto-tuner applies a learned change (safe keys only).
export function setLearned(change, meta = {}) {
  const L = loadLayers();
  const safe = pick(change, AUTO_KEYS);
  const merged = clampParams({ ...L.baseline, ...L.learned, ...safe });
  const learned = { ...L.learned, ...pick(merged, Object.keys(safe)) };
  writeJson(LEARNED_FILE, learned);
  logHistory({ layer: "learned", change: pick(merged, Object.keys(safe)), source: meta.source || "auto", edge: meta.edge });
  return loadParams();
}
// Back-compat name used by the shadow-test CLI.
export const promote = (proposed, meta = {}) => setLearned(proposed, meta);

// Reset levers to baseline by removing them from BOTH override layers.
// keys empty/null = reset everything.
export function resetParams(keys, meta = {}) {
  const L = loadLayers();
  if (!keys || !keys.length) { writeJson(MANUAL_FILE, {}); writeJson(LEARNED_FILE, {}); logHistory({ layer: "reset", change: "all", source: meta.source || "reset" }); return loadParams(); }
  for (const k of keys) { delete L.manual[k]; delete L.learned[k]; }
  writeJson(MANUAL_FILE, L.manual); writeJson(LEARNED_FILE, L.learned);
  logHistory({ layer: "reset", change: keys, source: meta.source || "reset" });
  return loadParams();
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

// Walk the same-day price path forward from entry i and apply the strategy's real
// exit model: hard stop, trailing stop once armed (tightened late in the session),
// and an end-of-day close. Returns the estimated option return (fraction) or null.
function simulateExit(recs, i, lean, delta, premium, p) {
  const entrySpy = recs[i].spy;
  let peak = 0, last = null;
  for (let j = i + 1; j < recs.length; j++) {
    if (recs[j].etDate !== recs[i].etDate) break;   // never cross sessions
    if (!(recs[j].spy > 0)) continue;
    const moveDir = lean === "call" ? recs[j].spy - entrySpy : entrySpy - recs[j].spy;
    const optRet = (delta * moveDir) / premium;     // est. option % return at this step
    last = optRet;
    if (optRet <= p.stop) return p.stop;            // hard stop
    if (optRet >= p.target) return p.target;        // target cap
    if (optRet > peak) peak = optRet;               // new high-water mark
    if (peak >= p.arm) {                            // trailing stop armed (>= +80%)
      const tm = etMinutes(recs[j].ts);
      let effTrail = p.trail;                        // tighten the trail late in the day
      if (tm >= hhmm("14:30")) effTrail = Math.min(effTrail, 0.20);
      else if (tm >= hhmm("13:00")) effTrail = Math.min(effTrail, 0.25);
      let trailStop = peak - effTrail;
      if (peak >= 1.0) trailStop = Math.max(trailStop, 0); // +100% never round-trips to a loss
      if (optRet <= trailStop) return Math.max(p.stop, trailStop);
    }
  }
  return last == null ? null : Math.max(p.stop, Math.min(p.target, last)); // EOD close
}

// Replay the journal under `params`; return estimated entry performance using the
// hold-aware exit model above (not a fixed 30-min snapshot).
export function evaluate(recs, params) {
  const startMin = hhmm(params.entryWindowStart || "09:35");
  const endMin = hhmm(params.entryWindowEnd);
  const exit = {
    stop: -(Number(params.stopPct ?? 28) / 100),
    target: Number(params.targetPct ?? 75) / 100,
    trail: Number(params.trailPct ?? 35) / 100,
    arm: 0.8, // trail never arms (targetPct 75 < 80). NOTE: the LIVE exit is the watcher's
              // momentum-stall (watch.mjs), which simulateExit does NOT model — it scores a fixed
              // +targetPct cap, so these estimates OVER-state real exits. Only the (off-by-default)
              // entry-key auto-tuner consumes them; ignore the absolute avgReturn here.
  };
  let entries = 0, sumRet = 0, wins = 0;
  for (let i = 0; i < recs.length; i++) {
    const r = recs[i];
    const m = etMinutes(r.ts);
    if (m < startMin || m > endMin) continue;               // entry window
    if ((r.signalCount || 0) < params.minSignals) continue; // confluence
    const c = r.candidate;
    if (!c || !(c.premium > 0)) continue;                   // need a real candidate
    const d = Math.abs(c.delta ?? 0.5);
    if (d < params.deltaLow - 0.05 || d > params.deltaHigh + 0.05) continue; // delta band (0.05 slack)
    const lean = r.direction || (Number(r.pctFromOpen) >= 0 ? "call" : "put");
    const ret = simulateExit(recs, i, lean, d, c.premium, exit);
    if (ret == null) continue;
    entries++; sumRet += ret; if (ret > 0) wins++;
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
    promote(override, { edge: Math.round(edge * 10) / 10, source: "shadow-cli" });
    console.log(`PROMOTED → wrote learned.json (safe keys only). Agent uses it on the next scan.`);
  } else if (wins) {
    console.log(`(Set AUTO_PROMOTE=1 to apply to the learned layer.)`);
  }
}
