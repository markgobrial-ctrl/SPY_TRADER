/**
 * watch.mjs — fast, code-only exit engine for open SPY 0DTE positions.
 *
 * Runs on a ~30s loop (cron spawns this every minute; it loops for ~RUN_SECONDS).
 * Three jobs, all evaluated on EVERY 30s check:
 *   1. HARD STOP — flatten a position whose premium falls past -stopPct.
 *   2. MOMENTUM-STALL (primary profit-taking) — flatten when SPY stops making new
 *      favorable extremes (new highs for calls / new lows for puts) for STALL_MIN
 *      minutes. Rides a trend and exits near the peak; beat fixed +25% and trailing
 *      in backtest (+$633 vs +$191/+$185 on 28 trades). The armed flag is LATCHED
 *      on the position's peak P&L, so a winner that fades still stall-exits.
 *   3. GIVE-BACK GUARD — once armed (peaked >= STALL_ARM_PCT), flatten immediately
 *      if the premium gives back more than WATCH_GIVEBACK pts from its peak,
 *      floored at breakeven: an armed winner is never allowed to turn red.
 *
 * The stall timer is PERSISTED to a state file so it survives the per-minute cron
 * restarts — an in-memory timer would reset every ~55s and never reach STALL_MIN.
 * SPY is sampled each 30s check; the timer is wall-clock since the last new extreme.
 *
 * SAFETY: DISABLED unless WATCHER=1. DRY-RUN unless WATCHER_ARMED=1 (logs only).
 * SPY 0DTE + agentic account only. Respects the dashboard e-stop. Cancels the
 * resting backstop before any market close (never two live sells; a cash, level-2
 * account also rejects a stray short). Stall logic disable via WATCH_STALL=0.
 */

import { randomUUID } from "crypto";
import { readFileSync, writeFileSync, existsSync } from "fs";
import {
  getOpenSpyOdtePositions, getSpyPrice,
  findRestingSellOrders, cancelOptionOrder, sellToCloseLimit,
} from "./rhApi.js";
import { loadParams } from "./shadow.mjs";

const ENABLED = process.env.WATCHER === "1";
const ARMED = process.env.WATCHER_ARMED === "1";        // off ⇒ dry-run
const STALL_ON = process.env.WATCH_STALL !== "0";       // momentum-stall exit (default ON)
const STALL_MIN = Number(process.env.WATCH_STALL_MIN || 4);
const STALL_ARM_PCT = Number(process.env.WATCH_STALL_ARM || 12); // LATCHED: armed once the position has EVER been up >= this %
const GIVEBACK_PTS = Number(process.env.WATCH_GIVEBACK ?? 20);   // once armed, exit if P&L falls this many pts below its peak (floored at breakeven); 0 disables
const INTERVAL_SEC = Number(process.env.WATCH_INTERVAL_SEC || 30);
const RUN_SECONDS = Number(process.env.WATCH_RUN_SECONDS || 55);
const STOP_BUFFER = Number(process.env.WATCH_STOP_BUFFER || 0);
const RENDER_URL = process.env.RENDER_URL;
const PUSH_SECRET = process.env.PUSH_SECRET;
const STALL_STATE = process.env.WATCH_STALL_STATE || "/tmp/spy-watch-stall.json";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const round2 = (n) => Math.round(n * 100) / 100;
const stamp = () => new Date().toISOString();
const log = (...a) => console.log(`[watch ${stamp()}]`, ...a);

function etDate() { return new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" }); }
function isMarketHours() {
  const et = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
  const day = et.getDay();
  if (day === 0 || day === 6) return false;
  const mins = et.getHours() * 60 + et.getMinutes();
  return mins >= 9 * 60 + 35 && mins < 16 * 60;
}
function etMinutesNow() {
  const et = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
  return et.getHours() * 60 + et.getMinutes();
}
function loadStall() { try { return existsSync(STALL_STATE) ? JSON.parse(readFileSync(STALL_STATE, "utf8")) : {}; } catch { return {}; } }
function saveStall(s) { try { writeFileSync(STALL_STATE, JSON.stringify(s)); } catch { /* best-effort */ } }

async function pushLog(content, type = "info") {
  if (!RENDER_URL) return;
  try {
    await fetch(`${RENDER_URL}/api/push`, {
      method: "POST", headers: { "Content-Type": "application/json", "x-push-secret": PUSH_SECRET || "" },
      body: JSON.stringify({ type, content }),
    });
  } catch { /* best-effort */ }
}
async function agentEnabled() {
  if (!RENDER_URL) return false;
  try { const r = await fetch(`${RENDER_URL}/api/pending`, { headers: { "x-push-secret": PUSH_SECRET || "" } }); return !!(await r.json()).enabled; }
  catch { return false; }
}

const handled = new Set(); // option_ids acted on THIS process run

// Cancel the resting backstop limit, then market-close. `reason` e.g. "STOP -31%" / "STALL 3.0min".
async function flatten(p, reason, stall) {
  const desc = `${p.type} ${p.strike} exp ${p.expiry}`;
  const msg = `${reason} — ${desc} (mark ${p.mark}, avg ${p.avg_cost}, ${p.pnl_pct.toFixed(0)}%)`;
  if (!(await agentEnabled())) { log(`${msg} — agent disabled; standing down.`); handled.add(p.option_id); return; }
  if (!ARMED) {
    const px = round2(Math.max(0.01, (p.bid || p.mark) - 0.02));
    log(`[DRY-RUN] ${msg} → would cancel backstop + sell ${p.qty} @ ${px}`);
    await pushLog(`[DRY-RUN] ${reason} ${desc} (${p.pnl_pct.toFixed(0)}%)`, "info");
    handled.add(p.option_id); return;
  }
  handled.add(p.option_id); // claim before any await so the next loop iteration can't double-fire
  try {
    // Cancel any resting sell (the +75% backstop) FIRST — one contract backs only one sell, so the
    // close is rejected until the backstop is gone. Then POLL until it actually clears (cancel is async).
    let resting = await findRestingSellOrders(p.option_id);
    for (const o of resting) { log(`cancel resting sell ${o.id} (${o.state})`); try { await cancelOptionOrder(o); } catch (e) { log(`cancel ${o.id} failed: ${e.message}`); } }
    for (let i = 0; resting.length && i < 12; i++) { await sleep(500); resting = await findRestingSellOrders(p.option_id); }
    if (resting.length) log(`WARN ${resting.length} resting sell(s) still open after cancel — selling anyway`);
    const limit = round2(Math.max(0.01, (p.bid || p.mark) - 0.02));
    let res = null, lastErr = null;
    for (let attempt = 1; attempt <= 3 && !res; attempt++) {
      try { res = await sellToCloseLimit({ optionId: p.option_id, instrumentUrl: p.instrumentUrl, qty: p.qty, limitPrice: limit, refId: randomUUID() }); }
      catch (e) { lastErr = e; log(`sell attempt ${attempt} failed: ${e.message}`); if (attempt < 3) await sleep(900); }
    }
    if (!res) throw lastErr || new Error("sell failed after retries");
    log(`CLOSE (${reason}) ${p.qty}x ${desc} @ ${limit} (order ${res.id || "?"})`);
    await pushLog(`${reason.startsWith("STALL") ? "📉 stall-exit" : reason.startsWith("GIVEBACK") ? "📉 give-back exit" : "🛑 stop"} ${desc} ${p.pnl_pct.toFixed(0)}% — sold ${p.qty} @ ${limit}`, "warn");
    if (stall) delete stall[p.option_id];
  } catch (e) {
    log(`close FAILED ${desc}: ${e.message}`);
    await pushLog(`⚠ close failed ${desc}: ${e.message}`, "error");
    handled.delete(p.option_id); // allow a retry next cron run
  }
}

async function checkOnce() {
  if (!isMarketHours()) return;
  const params = loadParams();
  const stopPct = Number(params.stopPct || 28);
  const stopTrigger = -(stopPct + STOP_BUFFER);

  let positions;
  try { positions = await getOpenSpyOdtePositions(etDate()); }
  catch (e) { log("position read failed:", e.message); return; }

  let spy = null;
  if (STALL_ON && positions.length) { try { spy = await getSpyPrice(); } catch (e) { log("spy quote failed:", e.message); } }
  const stall = loadStall();
  const now = Date.now();
  const openIds = new Set(positions.map((p) => p.option_id));
  const etMin = etMinutesNow();

  for (const p of positions) {
    if (handled.has(p.option_id)) continue;

    // 0) EOD — the LLM no longer manages positions, so the watcher force-closes any SPY 0DTE by 3:45 ET.
    if (etMin >= 15 * 60 + 45) { await flatten(p, "EOD 3:45 close", stall); continue; }

    // 1) HARD STOP — most urgent
    if (p.pnl_pct <= stopTrigger) { await flatten(p, `STOP ${p.pnl_pct.toFixed(0)}%`, stall); continue; }

    // 2) MOMENTUM-STALL + GIVE-BACK — LOCK A GAIN. Track SPY's favorable extreme continuously
    //    AND the position's peak P&L. The armed flag is LATCHED: once the position has EVER been
    //    up >= STALL_ARM_PCT it stays armed, even if the premium later fades below the threshold.
    //    (The old check `p.pnl_pct >= STALL_ARM_PCT` was evaluated at exit time — a winner that
    //    peaked while SPY was still trending, then faded below +12% before the stall timer fired,
    //    could NEVER stall-exit and rode all the way to the hard stop: the 7/1 748C, up big →
    //    sold at −30%.) Two exits once armed:
    //      GIVEBACK — premium falls more than WATCH_GIVEBACK pts from its peak (floored at
    //                 breakeven: an armed winner is never allowed to turn red). Fires immediately.
    //      STALL    — SPY makes no new favorable extreme for STALL_MIN minutes. Fires on the timer.
    //    A flat/losing fresh trade is NOT stalled out (left to the hard stop), so we don't bail
    //    3-4 min after entry at a small loss (the 6/30 churn).
    if (STALL_ON && spy != null) {
      const call = p.type === "call";
      const st = stall[p.option_id] || { ext: spy, ts: now };
      const newExtreme = call ? spy > st.ext : spy < st.ext;
      if (newExtreme) { st.ext = spy; st.ts = now; }
      if (st.peak == null || p.pnl_pct > st.peak) st.peak = p.pnl_pct;   // latch peak P&L
      if (!st.armed && st.peak >= STALL_ARM_PCT) st.armed = true;        // latch armed
      stall[p.option_id] = st;
      const stalledMin = (now - st.ts) / 60000;
      if (st.armed && GIVEBACK_PTS > 0 && p.pnl_pct <= Math.max(0, st.peak - GIVEBACK_PTS)) {
        await flatten(p, `GIVEBACK peaked +${st.peak.toFixed(0)}%, now ${p.pnl_pct >= 0 ? "+" : ""}${p.pnl_pct.toFixed(0)}%`, stall); continue;
      }
      if (stalledMin >= STALL_MIN && st.armed) {
        await flatten(p, `STALL ${stalledMin.toFixed(1)}min no new ${call ? "high" : "low"} @ ${p.pnl_pct >= 0 ? "+" : ""}${p.pnl_pct.toFixed(0)}% (peak +${st.peak.toFixed(0)}%)`, stall); continue;
      }
    }
  }

  for (const id of Object.keys(stall)) if (!openIds.has(id)) delete stall[id]; // prune closed positions
  saveStall(stall);
}

async function main() {
  if (!ENABLED) { log("WATCHER disabled (set WATCHER=1 to enable). Exiting."); return; }
  log(`watcher start — ${ARMED ? "ARMED (live orders)" : "DRY-RUN"}, stall=${STALL_ON ? STALL_MIN + "min@+" + STALL_ARM_PCT + "% (latched)" : "off"}, giveback=${GIVEBACK_PTS > 0 ? GIVEBACK_PTS + "pts" : "off"}, interval=${INTERVAL_SEC}s, run=${RUN_SECONDS}s`);
  const end = Date.now() + RUN_SECONDS * 1000;
  while (true) {
    await checkOnce().catch((e) => log("check error:", e.message));
    if (Date.now() + INTERVAL_SEC * 1000 >= end) break;
    await sleep(INTERVAL_SEC * 1000);
  }
}

main();
