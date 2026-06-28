/**
 * watch.mjs — fast, code-only stop watcher for open SPY 0DTE positions.
 *
 * WHY: the LLM scan loop runs at most every few minutes and a 0DTE option can
 * blow through its stop in seconds. The resting take-profit limit (placed at
 * entry by the agent) already handles the UPSIDE between scans; this watcher is
 * the matching DOWNSIDE backstop — it checks open positions every ~30s and
 * flattens one whose premium has fallen past the hard stop.
 *
 * SCHEDULING: cron fires this every minute (`* * * * *`). Each run loops for
 * ~WATCH_RUN_SECONDS, checking every WATCH_INTERVAL_SEC, so the effective cadence
 * is ~30s without needing sub-minute cron.
 *
 * SAFETY (read before arming):
 *   - DISABLED unless WATCHER=1.
 *   - DRY-RUN unless WATCHER_ARMED=1 — in dry-run it only LOGS what it would do.
 *   - SPY 0DTE only, agentic account only (rhApi enforces both).
 *   - Respects the dashboard e-stop: if the agent is disabled, it stands down
 *     (you've taken manual control) and only logs.
 *   - Cancels the resting take-profit BEFORE closing, so there is never more than
 *     one live sell on a contract. Backstop: this is a cash, level-2 account, so a
 *     stray extra sell would be a naked short (sell-to-open) which level 2 forbids
 *     — the broker rejects it rather than leaving you short.
 *   - `handled` guard prevents re-issuing a close for the same position within a run.
 */

import { randomUUID } from "crypto";
import {
  getOpenSpyOdtePositions,
  findRestingSellOrders,
  cancelOptionOrder,
  sellToCloseLimit,
} from "./rhApi.js";
import { loadParams } from "./shadow.mjs";

const ENABLED = process.env.WATCHER === "1";
const ARMED = process.env.WATCHER_ARMED === "1"; // off ⇒ dry-run (no orders placed)
const INTERVAL_SEC = Number(process.env.WATCH_INTERVAL_SEC || 30);
const RUN_SECONDS = Number(process.env.WATCH_RUN_SECONDS || 55);
const STOP_BUFFER = Number(process.env.WATCH_STOP_BUFFER || 0); // extra pts past stopPct before firing
const RENDER_URL = process.env.RENDER_URL;
const PUSH_SECRET = process.env.PUSH_SECRET;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const round2 = (n) => Math.round(n * 100) / 100;
const stamp = () => new Date().toISOString();
const log = (...a) => console.log(`[watch ${stamp()}]`, ...a);

function etDate() {
  return new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" }); // YYYY-MM-DD
}
function isMarketHours() {
  const et = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
  const day = et.getDay();
  if (day === 0 || day === 6) return false;
  const mins = et.getHours() * 60 + et.getMinutes();
  return mins >= 9 * 60 + 35 && mins < 16 * 60; // 9:35–16:00 ET
}

// Dashboard log (best-effort; the watcher must never throw because a push failed).
async function pushLog(content, type = "info") {
  if (!RENDER_URL) return;
  try {
    await fetch(`${RENDER_URL}/api/push`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-push-secret": PUSH_SECRET || "" },
      body: JSON.stringify({ type, content }),
    });
  } catch { /* best-effort */ }
}

// Server e-stop: only act when the agent is enabled. Fail safe = do NOT act.
async function agentEnabled() {
  if (!RENDER_URL) return false;
  try {
    const r = await fetch(`${RENDER_URL}/api/pending`, { headers: { "x-push-secret": PUSH_SECRET || "" } });
    const j = await r.json();
    return !!j.enabled;
  } catch {
    return false;
  }
}

const handled = new Set(); // option_ids already acted on THIS process run

async function checkOnce() {
  if (!isMarketHours()) return;
  const params = loadParams();
  const stopPct = Number(params.stopPct || 40);
  const trigger = -(stopPct + STOP_BUFFER); // pnl_pct at/below this ⇒ flatten

  let positions;
  try {
    positions = await getOpenSpyOdtePositions(etDate());
  } catch (e) {
    log("position read failed:", e.message);
    return;
  }

  for (const p of positions) {
    if (handled.has(p.option_id)) continue;
    if (!(p.pnl_pct <= trigger)) continue; // not breached

    const desc = `${p.type} ${p.strike} exp ${p.expiry}`;
    const msg = `STOP BREACH ${desc}: mark ${p.mark} vs avg ${p.avg_cost} = ${p.pnl_pct.toFixed(0)}% (trigger -${stopPct + STOP_BUFFER}%)`;

    const enabled = await agentEnabled();
    if (!enabled) {
      log(`${msg} — agent disabled; standing down (manual control).`);
      handled.add(p.option_id);
      continue;
    }
    if (!ARMED) {
      const wouldPx = round2(Math.max(0.01, (p.bid || p.mark) - 0.02));
      log(`[DRY-RUN] ${msg} → would cancel resting take-profit and sell-to-close ${p.qty} @ ${wouldPx}`);
      await pushLog(`[DRY-RUN] fast stop would close ${desc} at ${p.pnl_pct.toFixed(0)}%`, "info");
      handled.add(p.option_id);
      continue;
    }

    // ARMED: cancel the resting take-profit first, then flatten.
    handled.add(p.option_id); // claim immediately so the next loop iteration can't double-fire
    try {
      const resting = await findRestingSellOrders(p.option_id);
      for (const o of resting) {
        log(`cancelling resting sell ${o.id} (${o.state})`);
        await cancelOptionOrder(o);
      }
      if (resting.length) await sleep(1500); // let the cancel settle so the contract frees up

      const limit = round2(Math.max(0.01, (p.bid || p.mark) - 0.02)); // marketable: at/under bid
      const refId = randomUUID();
      const res = await sellToCloseLimit({
        optionId: p.option_id, instrumentUrl: p.instrumentUrl, qty: p.qty, limitPrice: limit, refId,
      });
      log(`SELL-TO-CLOSE placed: ${p.qty}x ${desc} @ ${limit} (order ${res.id || "?"})`);
      await pushLog(`🛑 Fast stop closed ${desc} at ${p.pnl_pct.toFixed(0)}% — sold ${p.qty} @ ${limit}`, "warn");
    } catch (e) {
      log(`close FAILED for ${desc}: ${e.message}`);
      await pushLog(`⚠ Fast-stop close FAILED for ${desc}: ${e.message}`, "error");
      handled.delete(p.option_id); // allow a retry next cron run
    }
  }
}

async function main() {
  if (!ENABLED) {
    log("WATCHER disabled (set WATCHER=1 to enable). Exiting.");
    return;
  }
  log(`watcher start — mode=${ARMED ? "ARMED (live orders)" : "DRY-RUN"}, interval=${INTERVAL_SEC}s, run=${RUN_SECONDS}s`);
  const end = Date.now() + RUN_SECONDS * 1000;
  while (true) {
    await checkOnce().catch((e) => log("check error:", e.message));
    if (Date.now() + INTERVAL_SEC * 1000 >= end) break;
    await sleep(INTERVAL_SEC * 1000);
  }
}

main();
