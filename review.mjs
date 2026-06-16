/**
 * review.mjs — Periodic performance review for the SPY 0DTE agent.
 *
 * Reads the scan journal (journal.jsonl, one structured scan per line) plus this
 * period's closed trades, computes deterministic stats (so the numbers are real,
 * not LLM-estimated), then asks Claude to write a plain-language review with
 * SPECIFIC, TESTABLE suggestions. The suggestions are advisory — a human decides
 * whether to apply them. Saves a markdown report and pushes a summary to the
 * dashboard.
 *
 * Run weekly via cron, e.g.:
 *   0 14 * * 0 cd /root/spy-trader && /usr/bin/node --env-file=.env review.mjs >> /root/spy-trader/review.log 2>&1
 * Or on demand:  node --env-file=.env review.mjs [days]
 */

import { execFileSync } from "child_process";
import { readFileSync, existsSync, mkdirSync, writeFileSync } from "fs";
import { evaluate, loadParams } from "./shadow.mjs";

// Extract first balanced JSON object after a tag (handles nesting).
function extractJson(text, tag) {
  const idx = text.indexOf(tag); if (idx === -1) return null;
  const start = text.indexOf("{", idx); if (start === -1) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) { if (esc) esc = false; else if (ch === "\\") esc = true; else if (ch === '"') inStr = false; }
    else if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) { try { return JSON.parse(text.slice(start, i + 1)); } catch { return null; } }
  }
  return null;
}
const SAFE_KEYS = ["entryWindowEnd", "minSignals", "deltaLow", "deltaHigh"];

const JOURNAL_FILE = "/root/spy-trader/journal.jsonl";
const REVIEW_DIR = "/root/spy-trader/reviews";
const RENDER_URL = process.env.RENDER_URL?.replace(/\/$/, "");
const PUSH_SECRET = process.env.PUSH_SECRET;
const ACCOUNT_NUMBER = process.env.ROBINHOOD_ACCOUNT || "545721409";
const DAYS = Number(process.argv[2]) || 7;

function etDateStr() {
  return new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" }); // YYYY-MM-DD
}

async function push(body) {
  if (!RENDER_URL) return;
  try {
    await fetch(`${RENDER_URL}/api/push`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-push-secret": PUSH_SECRET || "" },
      body: JSON.stringify(body),
    });
  } catch (e) { console.error("Push failed:", e.message); }
}

// ── Load + parse journal ──────────────────────────────────────────────────────
function loadJournal(days) {
  if (!existsSync(JOURNAL_FILE)) return [];
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  return readFileSync(JOURNAL_FILE, "utf8")
    .split("\n")
    .filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch { return null; } })
    .filter(r => r && typeof r.ts === "number" && r.ts >= cutoff)
    .sort((a, b) => a.ts - b.ts);
}

// Forward SPY return from record i to the first record at least `minutes` later
// the SAME day (so we never cross sessions). null if none.
function forwardReturn(recs, i, minutes) {
  const target = recs[i].ts + minutes * 60000;
  for (let j = i + 1; j < recs.length; j++) {
    if (recs[j].etDate !== recs[i].etDate) break;
    if (recs[j].ts >= target && recs[i].spy > 0 && recs[j].spy > 0) {
      return (recs[j].spy - recs[i].spy) / recs[i].spy;
    }
  }
  return null;
}

function pct(n, d) { return d > 0 ? Math.round((n / d) * 1000) / 10 : null; }

// ── Deterministic analysis ────────────────────────────────────────────────────
function analyze(recs) {
  const decisions = {};
  const signalFreq = {};
  let withLean = 0, favorable30 = 0, evaluated30 = 0, sumMove30 = 0;
  const byHour = {}; // hour -> {fav, n}
  const setups = recs.filter(r => (r.signalCount || 0) >= 2); // would-trade conditions

  for (const r of recs) {
    decisions[r.decision || "?"] = (decisions[r.decision || "?"] || 0) + 1;
    for (const s of (r.signals || [])) signalFreq[s] = (signalFreq[s] || 0) + 1;
  }

  for (let i = 0; i < recs.length; i++) {
    const r = recs[i];
    if ((r.signalCount || 0) < 2) continue; // only evaluate would-trade setups
    const lean = r.direction || (Number(r.pctFromOpen) >= 0 ? "call" : "put");
    const fr = forwardReturn(recs, i, 30);
    if (fr == null) continue;
    withLean++;
    evaluated30++;
    const favorable = lean === "call" ? fr > 0 : fr < 0;
    const dirMove = lean === "call" ? fr : -fr; // move in the leaned direction
    sumMove30 += dirMove;
    if (favorable) favorable30++;
    const h = new Date(r.ts).toLocaleString("en-US", { timeZone: "America/New_York", hour: "2-digit", hour12: false });
    byHour[h] = byHour[h] || { fav: 0, n: 0 };
    byHour[h].n++; if (favorable) byHour[h].fav++;
  }

  return {
    totalScans: recs.length,
    days: DAYS,
    decisions,
    signalFreq,
    setupCount: setups.length,
    setup30: {
      evaluated: evaluated30,
      favorableRate: pct(favorable30, evaluated30),
      avgDirMovePct: evaluated30 ? Math.round((sumMove30 / evaluated30) * 10000) / 100 : null,
    },
    byHour: Object.fromEntries(
      Object.entries(byHour).map(([h, v]) => [h + ":00 ET", { n: v.n, favorableRate: pct(v.fav, v.n) }])
    ),
  };
}

// ── Main ──────────────────────────────────────────────────────────────────────
const recs = loadJournal(DAYS);
if (recs.length < 5) {
  console.log(`Only ${recs.length} journal records in the last ${DAYS}d — not enough to review yet. Skipping.`);
  await push({ type: "info", content: `📊 Weekly review skipped — only ${recs.length} scans journaled so far (need a few days of data).` });
  process.exit(0);
}

const stats = analyze(recs);
const statsBlock = JSON.stringify(stats, null, 2);
const recentSample = recs.slice(-60).map(r =>
  `${r.etDate} ${r.etTime} SPY=${r.spy} %open=${r.pctFromOpen} vwap=${r.vwapSide} OR=${r.openingRange} vix=${r.vix} trend=${r.trend} sigs=${(r.signals||[]).join("+")||"none"}(${r.signalCount}) -> ${r.decision}${r.direction?"/"+r.direction:""} : ${r.reason||""}`
).join("\n");

const prompt = `You are reviewing the performance of an autonomous SPY 0DTE options trading agent to find ways to improve it. Below is (A) a deterministic stats summary computed from the scan journal, (B) a sample of recent scans, and you should also (C) pull this account's CLOSED SPY option round trips from the last ${DAYS} days via the robinhood-trading MCP (account ${ACCOUNT_NUMBER}) and factor in their realized P&L.

IMPORTANT context for your analysis:
- "favorableRate" for ≥2-signal setups = how often SPY moved in the leaned direction over the next 30 min. This is a proxy for whether entering would have worked. A rate near 50% means the entry signals have no edge; >55% suggests some edge.
- Be statistically honest: if the sample is small (under ~30 evaluated setups or under ~20 trades), say so and treat findings as TENTATIVE hypotheses, not conclusions. Do NOT recommend aggressive changes off tiny samples.
- Suggestions must be SPECIFIC and TESTABLE (e.g. "favorableRate is 38% for entries after 10:30 ET vs 61% before — consider ending the entry window at 10:30"), and framed as proposals for a human to approve, never auto-applied.

(A) STATS SUMMARY:
${statsBlock}

(B) RECENT SCANS (last 60):
${recentSample}

Write a concise markdown review with these sections:
## Summary (2-3 sentences, include sample-size caveat)
## What's working
## What's not
## Signal edge (interpret the favorableRate numbers honestly)
## Suggested experiments (specific, testable, human-approved; mark each "low/medium/high confidence")
## Data quality notes (anything missing or unreliable in the journal)
Keep it tight and practical.

Then, on the VERY LAST line, output ONE machine-readable proposal for your single best, safe parameter change as:
PROPOSAL_JSON: {"change":{<one or more of entryWindowEnd,minSignals,deltaLow,deltaHigh>},"rationale":"<one sentence>","confidence":"low|medium|high"}
You may ONLY propose those four keys (entryWindowEnd is "HH:MM" ET ≤ "11:00"; minSignals 2-4; deltaLow/deltaHigh between 0.30 and 0.70). NEVER propose changes to sizing, stops, the $400 cap, the VIX band, or anything else — those are fixed. If you have no confident change, output PROPOSAL_JSON: {"change":{},"rationale":"insufficient evidence","confidence":"low"}.`;

let review = "";
try {
  const { ANTHROPIC_API_KEY: _drop, ...env } = { ...process.env, HOME: "/root" };
  review = execFileSync("claude", ["--model", "claude-sonnet-4-6", "--max-turns", "12", "-p", prompt], {
    env, timeout: 4 * 60 * 1000, encoding: "utf8",
  }).trim();
} catch (e) {
  const detail = [e.stderr, e.stdout].map(x => (x || "").toString().trim()).filter(Boolean).join(" | ");
  console.error("Review generation failed:", detail || e.message);
  await push({ type: "error", content: `📊 Weekly review failed to generate: ${(detail || e.message).slice(0, 200)}` });
  process.exit(1);
}

// ── Proposal → critic → shadow-test ───────────────────────────────────────────
const current = loadParams();
let verdictBlock = "## Shadow-test\n";
let dashVerdict = "";

const proposalRaw = extractJson(review, "PROPOSAL_JSON");
const change = proposalRaw && proposalRaw.change && typeof proposalRaw.change === "object" ? proposalRaw.change : {};
// Keep only safe keys — anything else is silently dropped (risk params are off-limits).
const safeChange = Object.fromEntries(Object.entries(change).filter(([k]) => SAFE_KEYS.includes(k)));

if (!Object.keys(safeChange).length) {
  verdictBlock += "No safe parameter change proposed this cycle.\n";
  dashVerdict = "No change proposed.";
} else {
  const proposed = { ...current, ...safeChange };

  // Critic pass — an independent skeptic stress-tests the proposal.
  let critique = "";
  try {
    const { ANTHROPIC_API_KEY: _d, ...env } = { ...process.env, HOME: "/root" };
    critique = execFileSync("claude", ["--model", "claude-sonnet-4-6", "--max-turns", "4", "-p",
      `You are a skeptical risk reviewer for a live-money 0DTE trading bot. A reviewer proposed this parameter change: ${JSON.stringify(safeChange)} (rationale: ${proposalRaw?.rationale || "n/a"}). Current params: ${JSON.stringify(current)}. Based on this stats summary:\n${statsBlock}\n\nIn 3-4 sentences: is this justified by the data or is it likely overfitting a small sample? What would falsify it? Be blunt; default to "not yet" when the sample is thin.`,
    ], { env, timeout: 90000, encoding: "utf8" }).trim();
  } catch { critique = "(critic pass unavailable)"; }

  // Objective shadow-test over the journal.
  const cur = evaluate(recs, current);
  const pro = evaluate(recs, proposed);
  const enough = cur.entries >= 25 && pro.entries >= 25;
  const edge = (pro.avgRetPct ?? -999) - (cur.avgRetPct ?? -999);
  const wins = enough && edge >= 5;
  const verdict = !enough
    ? `INSUFFICIENT DATA (need ≥25 evaluated entries each; have current=${cur.entries}, proposed=${pro.entries})`
    : wins ? `PROPOSED WINS by ${edge.toFixed(1)}pp est. return — candidate for promotion`
           : `HOLD — not a clear improvement (edge ${edge.toFixed(1)}pp, need ≥5pp)`;

  verdictBlock += `Proposed change: \`${JSON.stringify(safeChange)}\` (confidence: ${proposalRaw?.confidence || "?"})\n\n`
    + `Shadow-test over ${recs.length} journaled scans (est. option return clamped to −40%/+150%):\n`
    + `- current  \`${JSON.stringify(current)}\` → entries=${cur.entries}, avgEstReturn=${cur.avgRetPct}%, estWin=${cur.winRatePct}%\n`
    + `- proposed \`${JSON.stringify(proposed)}\` → entries=${pro.entries}, avgEstReturn=${pro.avgRetPct}%, estWin=${pro.winRatePct}%\n\n`
    + `**Verdict: ${verdict}**\n\n### Critic\n${critique}\n`;
  dashVerdict = `Proposed ${JSON.stringify(safeChange)} → ${verdict}`;

  // Auto-promotion is OFF by default. Only writes params.json when explicitly
  // enabled AND the shadow-test clears the gates. Risk params can never be here.
  if (wins && process.env.AUTO_PROMOTE === "1") {
    writeFileSync("/root/spy-trader/params.json", JSON.stringify(proposed, null, 2));
    verdictBlock += `\n_PROMOTED: wrote params.json. Agent uses the new params next scan._\n`;
    dashVerdict += " — PROMOTED (auto)";
    await push({ type: "warn", content: `⚙️ Strategy auto-updated after shadow-test: ${JSON.stringify(safeChange)}` });
  }
}

// Save the full review
mkdirSync(REVIEW_DIR, { recursive: true });
const file = `${REVIEW_DIR}/review-${etDateStr()}.md`;
const full = `# SPY 0DTE Agent — Performance Review (${etDateStr()}, last ${DAYS}d)\n\n_${recs.length} scans journaled, ${stats.setup30.evaluated} ≥2-signal setups evaluated._\n\n${review}\n\n---\n\n${verdictBlock}\n---\n\n## Raw stats\n\`\`\`json\n${statsBlock}\n\`\`\`\n`;
writeFileSync(file, full);
console.log(`Saved ${file}`);

// Push a compact summary to the dashboard
const headline = review.split("\n").find(l => l.trim() && !l.startsWith("#") && !l.startsWith("PROPOSAL_JSON")) || "Review ready.";
await push({ type: "agent", content: `📊 WEEKLY REVIEW (${etDateStr()}, ${recs.length} scans, last ${DAYS}d)\n${headline}\n\n${dashVerdict}\n\nFull review saved on the VPS: ${file}` });
console.log("Review pushed to dashboard.");
