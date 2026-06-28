# SPY 0DTE Agent — Trade Review (Jun 15–26, 2026)

Scope: the agent's live trading record since it started filling orders, reconstructed from the
Robinhood order history (account 545721409 "Agentic"), cross-checked against the current code.
This is the first review with **real fills** — the Jun 19 review had zero trades to judge.

## Bottom line

The agent is now trading, and it is losing money. Across **22 SPY 0DTE round-trips over 6
sessions** it realized **−$978**, taking the agentic account from a $2,000 baseline to
**$1,021.52** (now all cash, flat — no overnight risk). Win rate **27%** (6 of 22), with average
win **+$102** and average loss **−$99** — a roughly 1:1 payoff at a 27% hit rate, which is about
**−$45 of expected value per trade**. That is not a tuning problem; it is a structural one.

The single root cause: **every risk and exit rule lives in the LLM's prompt as advice, and is
"enforced" by a scan that runs only every ~10 minutes with no resting orders at the broker.**
0DTE gamma moves faster than that loop, so stops get blown through, winners get cut, and the
"one or two trades a day" discipline is ignored. The good news is the fixes are concrete and
mostly mechanical.

Daily realized P&L (SPY agentic):

| Day | Trades | P&L |
|---|---|---|
| Mon 6/15 | 1 | **+$224** |
| Mon 6/22 | 2 | −$264 |
| Tue 6/23 | 7 | **−$471** |
| Wed 6/24 | 5 | −$407 |
| Thu 6/25 | 4 | −$242 |
| Fri 6/26 | 3 | **+$182** |
| **Total** | **22** | **−$978** |

## What's working (don't break these)

- **The safety scope held.** The account also contains user-placed GOOGL and UNH options. Across
  all 51 agentic orders, the bot never touched a non-SPY or non-0DTE position — exactly as the
  EXECUTION SCOPE guardrail intends. That guardrail is doing its job.
- **No overnight exposure.** Every position is same-day expiry and the book is flat at the close.
- **The deterministic snapshot/signal engine got built** (`market.mjs`), which is the right
  direction for fixing the LLM-self-reported signal bugs flagged on Jun 19 — see Finding 6 for the
  catch.

## Finding 1 — Negative expectancy: the payoff is symmetric, the win rate isn't (highest impact)

A directional 0DTE strategy survives one of two ways: a high hit rate, or asymmetric winners that
pay for many small losses. This book has **neither**. Win rate 27%, average win +$102 vs average
loss −$99. To break even at a 27% hit rate the average winner needs to be ~2.7× the average loser
(≈ +$270, not +$102); to break even at this ~1:1 payoff the win rate needs to be ~50%. The
strategy is currently far from both lines at once, which is why the equity curve is a near-straight
bleed. Findings 2–4 are the three mechanisms producing it.

## Finding 2 — Over-trading: the frequency limits are prose, not code

The README says "one trade/day unless the first closes profitably." The system prompt softens this
to "stop after 2 consecutive losing trades; after your first profitable close take at most one
more." **Neither is enforced anywhere in code** — both are sentences in the LLM prompt, and the
model ignored them:

- 6/23 outcome sequence: **W(+149), then L, L, L, L, L, L.** The first trade was a winning close,
  so the bot's own rule said "take at most one more." It took six more, all losers, turning a green
  start into the worst day of the sample (−$471).
- 6/23–6/26 averaged **5 entries/day** (7, 5, 4, 3) against a stated cap of one or two.

Every extra 0DTE round-trip also pays the spread tax twice. With ~$249 average premium and the
3% liquidity gate, that is roughly $7–15 of friction per trade — call it $150–250 of pure drag
across 22 trades, before being right or wrong about direction.

## Finding 3 — The stop isn't a stop

Documented stop is 40% of premium (a manual change to 30% was requested in the logs). Actual
losses include **−67%, −61%, −58%, −57%, −48%, −46%**. The reason is mechanical: **across all 70
orders, not one carries a `stop_price`.** There is no resting stop order at the broker. The stop is
"check on the next scan and sell if it's past the line," and scans run every ~10 minutes
(`scanInterval: 10`). A 0DTE option can travel from −30% to −70% inside one 10-minute gap, so the
soft stop routinely fills far below its level. A 40% stop you actually realize at 65% is a 40%
strategy on paper and a 65% strategy in the account.

## Finding 4 — Winners are cut before they can run

The whole edge is supposed to be "let winners run to 150%+ on a trailing stop." In practice the
winners are +13%, +25%, +39%, +48% — small. Only once in the sample did a winner reach the target
zone (the 6/15 trade, +140%). Same root cause as Finding 3: the trailing stop is monitored on the
slow loop with no resting order, so the agent never catches the intra-scan high-water mark and
banks a small gain instead. Symmetric ~1:1 winners are the direct, measurable result.

## Finding 5 — The daily loss breaker exists but was effectively off

`server.js` has a date-guarded daily-loss circuit breaker, but it keys off
`strategy.params.dailyLossLimit`, which is **0 (disabled)** in the stored config. Modeled against
the actual days, a **−$200/day** limit would have halted trading early on **6/22, 6/23, 6/24, and
6/25** — four of the five losing days, and specifically the two −$400 days. This is the highest
safety-to-effort ratio on the list: one number, already wired to a breaker. (One caveat to verify:
the breaker depends on `realizedToday` updating promptly as closes are reconciled — on 6/23 and
6/24 the day ran to −$400+ uninterrupted, so confirm that accounting fires intraday and not in a
lagging batch.)

## Finding 6 — Likely still running LLM-narrated signals (FAST_PATH is off by default)

The deterministic engine is gated behind `FAST_PATH === "1"` and falls back to the legacy
LLM+MCP scan otherwise. If `FAST_PATH=1` isn't set in the VPS env, the bot is still choosing
direction by model narration — the exact path the Jun 19 review flagged for miscounted signals and
wrong-sign contracts. The 6/23 tape is consistent with that: four calls (9:44–10:27), flip to two
puts (11:17–11:22), flip back to a call (12:05) — direction whipsaw in chop. Worth confirming
which path actually ran live; if it's the legacy one, the signal-hygiene work isn't in effect yet.

## Finding 7 — Sizing and rules have drifted from the docs

The README still says "1 contract standard, 2 on conviction, max $400/trade, 40% stop." The code
now sizes risk-based and **clamps to `maxContracts`, which a manual change bumped to 3**, and two
entries (6/24 $440, 6/26 $427) **exceeded the $400 outlay cap**. On a ~$1,000 account, 0DTE at 2–3
contracts is large. While expectancy is negative, larger size just loses faster. Pick one source of
truth for the rules — right now the README, the prompt, and the live params disagree, and so does
the bot's behavior.

## Finding 8 — The auto-tuner can't fix this

`review.mjs` is only allowed to propose four "safe" entry keys (`entryWindowEnd`, `minSignals`,
`deltaLow/High`) and needs ≥25 evaluated entries before it promotes anything. The actual damage is
in **risk and exit execution**, which the tuner is structurally forbidden from touching. Don't wait
for the learning loop to repair the drawdown — it is pointed at the wrong levers by design.

## Suggested order of operations

1. **Stop the bleed in code, not prose.** Set `dailyLossLimit` to ~$150–200 and confirm the breaker
   fires intraday (Finding 5). Add a server-side hard cap of ≤2 entries/day plus "halt after 2
   consecutive losses," enforced in `/api/pending` — not in the prompt (Finding 2). Drop
   `maxContracts` to 1 until expectancy is positive (Finding 7). *These are config + a small server
   guard; they don't touch strategy.*
2. **Make stops and trails real** (Findings 3–4). Either place a resting stop (or stop-limit) order
   at entry, or — simpler — when any position is open, drop the scan interval to 30–60s so the
   monitored stop/trail can actually track a 0DTE move. A soft stop on a 10-minute loop is the
   single biggest execution leak.
3. **Confirm `FAST_PATH=1` is live** (Finding 6), so direction comes from `market.mjs` signals, not
   model narration. If it isn't on, turn it on and re-watch the churn.
4. **Re-baseline the rules** in one place (README = code = prompt) and forward-test on small size
   before trusting any of it again.
5. Only after 1–4 are stable, let the auto-tuner resume proposing entry-window/confluence tweaks.

## Addendum — does "take small wins early" beat "let winners run"? (revises Findings 1 & 4)

Prompted by the question "weren't many of these green at some point?" — yes, and it changes the
prescription. I reconstructed each option's intraday path with Black-Scholes from 1-minute SPY bars
(IV back-solved from the entry premium) and measured the **maximum favorable excursion** each trade
reached before its actual exit:

| Peak unrealized gain reached | Trades |
|---|---|
| ≥ +10% | 21 / 22 |
| ≥ +20% | 17 / 22 |
| ≥ +30% | 16 / 22 |
| ≥ +50% | 12 / 22 |
| median peak | **+59%** |

Almost every entry spiked green and then gave it back — the equity curve shows it as a small bump
at each buy followed by the fade. Even the −67% disaster (6/22 call) peaked at +72% first; the −61%
(6/24 call) peaked +46%. **The entries find a move; the exits give it all back.**

Backtesting a simple resting-limit take-profit + hard stop over the 22 trades (net of a 2% spread
haircut; intrabar assumes the stop fills before the target — the conservative direction):

| Rule | Net P&L | Wins |
|---|---|---|
| **Realized (what happened)** | **−$978** | 6/22 |
| +15% target / −25% stop | **+$422** | 20/22 |
| +20% / −25% | +$275 | 16/22 |
| +30% / −25% | +$347 | 14/22 |
| +50% / −25% | +$96 | 10/22 |

Every tight-target rule flips the week from −$978 to clearly positive, and it survives dropping the
6/15 outlier (+15%/−25% on the other 21 days = +$443). The decomposition is the punchline:

- **Take-profit only (+20%, no stop): +$167** — just harvesting the spike flips it positive.
- **Stop only (−25%, no target): −$530**; stop only (−40%): −$796 — cutting losses alone does *not*
  save it.

So the dominant lever is the **take-profit, not the stop** — the opposite of "let winners run to
150%." These are short-lived momentum pops in a mean-reverting June tape; the edge lasts minutes,
then theta and reversal erase it. **Revised recommendation:** drop `targetPct` from 150 to ~20–30,
exit via a resting limit order placed at entry (not a monitored trailing stop), keep a real stop as
secondary protection. Capturing a +20% spike that lasts ~4 minutes is impossible on a 10-minute
monitored loop — so this still depends on the resting-order / faster-cadence fix from Finding 2.

Honest limits on this: option paths are *reconstructed* (BS, constant IV) from underlying bars, not
real option ticks; a resting limit at +20% should fill at least as well as the model assumes, but
IV shifts and fills add noise. Sample is 22 trades in one low-trend regime — on a genuine trend day
a tight target caps a runner (6/15 would have made far more held). The grid is broad (+15 to +40 all
strongly positive), so this isn't a knife-edge fit, but forward-test on small size before trusting it.

## Follow-up analysis (Jun 28): stop, take-profit & time-of-day

Tested on the same 22-trade tape (in-sample, one mean-reverting week — treat as hypotheses):

- **Is −40% the right stop?** It's now nearly irrelevant. With the +25% resting take-profit, 15 of 22
  trades hit the target before any stop mattered; sweeping the stop −20%→−50% moves the week's P&L in a
  noisy $185–$367 band with no clean optimum. −40% is a fine (slightly loose) backstop; ~25–30% is
  marginally better in-sample but that's noise. Don't go below ~25% — watcher latency + whipsaw-out.

- **Take-profit level — fixed beats trailing, decisively.** Flat +15% was best in-sample (+$383, 20/22
  win) but is spread- and boundary-fragile (the +15-vs-+20 gap rests on 3–4 trades' exact peaks); +20–25%
  is the robust zone. **Trailing the winner FAILS here**: arm+30/trail25 = +$62, arm+40/trail30 = −$94,
  versus +$185–383 for fixed targets. In this regime you bank the spike, you don't ride it. Scale-out is
  also impossible at 1 contract. Decision: keep a flat take-profit in +15–25 (held at +25); let real fills
  settle the exact number rather than tuning on one week.

- **Time of day is the most durable signal.** Mean favorable excursion by entry window: 9:35–10:00 **+103%**,
  10:00–11:00 ~+67%, 11:00–11:30 **+30%** (worst, only losing bucket), 11:30–12:30 +42%. The open has ~3×
  the move of late morning. Best used for ENTRY selection (concentrate at the open; be picky 11:00–12:30),
  not a multi-tier exit — tiers added only ~$40, within noise. Shipped as prompt guidance, not a hard cap.

- **Over-trading, revisited.** Under disciplined exits the 2nd+ trades of the day were net positive (+$140
  vs +$45 for first trades), so a hard daily-trade cap isn't warranted — the −$978 was give-back, not
  frequency. (Calls vs puts, +$6 vs +$178, is just that week's downward drift on n=6 — noise, ignore.)

- **Sizing is the real growth governor.** Long-run growth is geometric; with an edge estimated from one
  week, stay at 1 contract (already enforced below $1,500 equity) and scale only as the edge confirms
  (fractional Kelly). Over-sizing a noisy edge is the main risk to compounding.

## Caveats

Six sessions and 22 trades is a small sample, and one of them (6/15) sits two weeks before the
cluster. The −$978 is computed directly from fills (closing proceeds minus opening cost per
contract) and reconciles to the account drop within a few dollars, so the magnitude is solid; the
per-trade *causes* (slow-loop stops, prose-only limits) are strong inferences from the order
timestamps and the code, not certainties. Treat Findings 2–5 as high-confidence and ship the
code-enforced guards; treat any entry-signal tuning as forward-test-first.
