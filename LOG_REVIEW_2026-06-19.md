# SPY 0DTE Agent — Log Review (Jun 16–18, 2026)

Scope: algorithm/lever improvements only. Auth and infra-timing issues ignored per request.

## Bottom line

Across 102 price scans over three sessions the agent placed **zero trades**. The signal engine was actually working — it correctly flagged a textbook bearish trend on 6/17 — but the **entry window was closed during every tradeable move**. Then a second, subtler problem: the learning loop's shadow-test can't *see* the payoff of those moves, so it would reject the fix.

## Finding 1 — The entry window is the binding constraint (highest impact)

The live `entryWindowEnd` was **11:00** (dashboard `db.json`), not the `13:00` code default. During the logged sessions the agent treated 11:00 (and sometimes 11:30) as a hard cutoff.

Where the qualifying setups actually fired:

| Setup quality | Inside 9:35–11:00 window | After 11:00 |
|---|---|---|
| ≥2 signals | 4 | 28 |
| ≥3 signals | 2 | 23 |

**~88% of all qualifying confluence occurred after the window had closed.** On 6/17 the morning (window open) was dead chop — SPY pinned 750–751. The real move started at 11:04, the *minute after* the cutoff: a 4-signal bear setup that ran from ~749 down to an intraday low of 739.66 (−1.5%), VIX 16→18.7. The agent logged "all 4 bearish signals active… but entry closed" and watched the entire decline flat.

Note the git history: commit `c15c98d` (6/18) "extend entry window to 1pm ET" was an attempt to fix exactly this, landing during/after these sessions. **1pm is not far enough** — see Finding 2.

## Finding 2 — The current "extend to 13:00" fix lands in the worst possible spot

Running your own `shadow.mjs evaluate()` across window settings (est. option return, clamped −40%/+150%):

| minSignals | windowEnd | entries | avg est. return |
|---|---|---|---|
| 2 | 11:00 | 0 | — |
| 2 | 11:30 | 4 | −26% |
| 2 | **13:00** | 5 | **−29%** |
| 2 | 15:00 | 13 | +9% |
| 2 | 16:00 | 15 | +27% |

A 13:00 cutoff is the *worst* row: it opens just enough to catch the 11:04 head-fake (SPY bounced back to 750.6 over the next 30 min before the real breakdown) but still closes before the afternoon trend that paid. The edge only turns positive when the window extends into the afternoon (≥15:00). The `BOUNDS` cap on `entryWindowEnd` is `13:00`, so neither you nor the auto-tuner can currently reach the profitable region.

## Finding 3 — The shadow-test horizon hides trend-day payoff (meta-bug in the learning loop)

`evaluate()` scores a hypothetical entry by SPY's move **30 minutes later**, times delta, over premium. But your strategy is explicitly "let winners run to 150%+ on a trailing stop." Those are incompatible. Held toward the 3:40pm sweep instead of +30 min, the same after-11:00 puts on 6/17 look like this (intrinsic-only, conservative):

- 1:10pm put 750 @ $2.45 → ~+300%
- 1:44pm put 749 @ $1.92 → ~+358%
- 3:09pm put 746 @ $1.16 → ~+400%
- 2:06pm put 745 @ $3.19 → ~+50%

The 30-minute proxy scored most of these **negative**. So the auto-tuner is structurally biased against trend-following: it will keep voting "HOLD — not a clear improvement" on window extensions that are actually correct. Fixing the estimator matters as much as fixing the window — otherwise the loop learns the wrong lesson. Options: score to a trailing-stop simulation or to end-of-session, not a fixed 30-min snapshot; or evaluate multiple horizons (30/60/120 min + EOD) and weight toward the strategy's actual hold.

Honest caveat on Findings 2–3: these are estimates from the journal's own SPY prints over 2 usable days (6/17 was the only clean trend; 6/16 logs start mid-afternoon; 6/18 chopped). The direction is clear but the sample is tiny — treat as a strong hypothesis to forward-test, not a tuned parameter.

## Finding 4 — Confluence is starved by missing intraday data

VWAP and opening-range were frequently `na`/`unknown` (no intraday chart on the current data plan). When 2 of the 4 signals are unobservable, the ≥2-of-4 gate is nearly impossible to clear cleanly — so the agent leaned on "move" alone, and `minMovePct` 0.4% rarely triggered before midday. Either get intraday data (chart plan) so VWAP/OR/trend can actually fire, or make the gate degrade gracefully when inputs are missing rather than defaulting to WAIT. This, not the threshold value, is why so few in-window signals fired.

## Finding 5 — Signals are LLM-self-reported, which introduces avoidable errors

`signals`/`signalCount`/`direction` come from the model narrating, not from code. Consequences seen in the log:

- **Count bug:** 6/18 9:40 — `signals:[move,vwap,or_breakout,trend]` (4) but `signalCount:3`. The gate and the shadow-test both key off `signalCount`, so a miscount can flip a decision.
- **Sign bug:** same scan — `direction:"put"` with candidate `delta:+0.48` (a call's delta). A wrong-sign contract pick is a real execution risk.
- **Threshold drift:** narration cites 0.2% / 0.3% / 0.4% on different scans though the param is fixed at 0.4%.

Computing the four signals deterministically in code from price/VWAP/OR — and having the model only act on them — removes this whole class of error and makes the journal trustworthy for learning.

## Finding 6 — Liquidity/spread is loose for 0DTE

14 candidates carried bid/ask spreads of 1–3.3% of mid; spreads widened midday and on far/late strikes. All passed the documented 5% gate, but on a $1–2 option a 2–3% round-trip is real slippage. Consider tightening the gate (≈2–3%) or making fills/sizing spread-aware, especially late in the day.

## What we still can't evaluate

The agent never entered, so **every MANAGE/exit/trailing-stop path is untested** in this data. Given the strategy's whole edge is "let winners run," the exit logic deserves its own review once there are real fills.

## Suggested order of operations

1. Raise the `entryWindowEnd` `BOUNDS` ceiling beyond 13:00 and set the live value into the afternoon (e.g. 14:00–14:30), keeping the 3:45 hard close. *(safe knob + one bounds edit)*
2. Fix the shadow-test horizon to reflect the trailing-stop/hold exit before trusting any auto-tune. *(otherwise #1 gets rejected by the loop)*
3. Move signal computation into code; keep `signalCount == signals.length` and enforce delta sign = direction. *(kills Findings 5's bugs)*
4. Resolve the VWAP/OR data gap (chart plan or graceful degradation). *(unblocks in-window confluence)*
5. Tighten the spread gate / make sizing spread-aware.

Changes 1–3 touch live-money trading logic — I've left them as proposals rather than editing the algorithm. Happy to implement any of them on your go-ahead.

---

## Changes implemented (2026-06-19)

All five suggestions were applied. Risk levers (sizing, stops, the $400 cap, VIX band, 3:45 hard close, SPY-0DTE-only execution scope) were left untouched.

**1. Entry window extended.** `DEFAULT_PARAMS.entryWindowEnd` 13:00 → **14:00** (`shadow.mjs`, `server.js`); `BOUNDS.entryWindowEnd` ceiling 13:00 → **15:00** (`shadow.mjs`); the weekly-review proposal limit was raised to ≤15:00 (`review.mjs`). 14:00 default leaves 105 min to the hard close and respects the late-day theta tighten-up.

**2. Shadow-test made hold-aware.** `evaluate()` in `shadow.mjs` no longer scores a fixed 30-min forward move. It now walks the day's price path under the real exit model — hard stop, trailing stop (armed at +80%, tightened to 25% after 13:00 and 20% after 14:30), and EOD close. On the journal this flips the verdict: windowEnd 13:00 went from −29% to **+24%**, and 14:00 scores **+50% est. return / 78% est. win** (9 entries). The auto-tuner will no longer reject correct window extensions.

**3. Signals reconciled deterministically.** `reconcileScan()` in `vps-agent.mjs` enforces, on every journaled scan, `signalCount === signals.length` and candidate delta sign === direction (puts negative, calls positive), trusting the model's signal reads otherwise. Verified: it fixed the one bad record (6/18 9:40, count 3→4, delta +0.48→−0.48) and left the other 101 untouched. The `SYSTEM_PROMPT` was also tightened to state these consistency rules and the majority-vote/conflict logic explicitly.

**4. VWAP/OR graceful degradation.** `SYSTEM_PROMPT` now instructs the agent to derive VWAP and the 9:30–9:45 opening range from intraday bars (Robinhood `get_equity_historicals` or FMP `chart`/`technicalIndicators`) before declaring them unavailable, and to require ≥minSignals among *observable* signals when data is genuinely missing — never manufacturing confluence.

**5. Spread gate tightened.** Liquidity gate 5% → **3%** of mid, with explicit spread-aware strike/breakeven guidance.

### To take effect
Deploy to the VPS (`update-vps.sh` / git pull). Then open the dashboard **Strategy** tab: if `entryWindowEnd` shows as **Manual** or **Learned** (e.g. still 11:00/13:00), hit **Reset** on it so the new 14:00 baseline applies — a pinned override outranks the code default.

### Caveat
The shadow numbers rest on ~2 usable days (one clean trend day). They show the *direction* is right and the estimator is no longer biased against trend-following — they are not a tuned result. Forward-test before trusting the auto-tuner to promote anything.
