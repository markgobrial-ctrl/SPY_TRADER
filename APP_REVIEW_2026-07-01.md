# App Review — Profitability Levers (Jul 1, 2026)

Grounded in live broker data (account 545721409) since the Jun 28 review, plus a full read of
`vps-agent.mjs`, `market.mjs`, `watch.mjs`, `shadow.mjs`, `server.js`.

## Forward-test results since the exit fixes (6/29–7/1)

| Day | Closing trades | Realized P&L |
|---|---|---|
| Mon 6/29 | 6 | −$84 |
| Tue 6/30 | 12 | −$119 |
| Wed 7/1 | 3 | **+$38** |
| **Total** | **21** | **−$165** |

Expectancy improved from **−$45/trade** (pre-fix) to **≈ −$8/trade**. The exits are largely fixed —
7/1 shows the intended shape: two winners banked (+$92 at +23%, +$36 at +12%), one stop cut at −30%.
The residual bleed is **churn**: too many entries, each paying the spread twice. That is now the
main profitability lever, and it's fixable in code.

## Finding 1 — Frequency & concurrency rules still live only in the prompt (highest impact)

The Jun 28 review flagged this; the broker record shows it's still happening:

- **7/1, two positions at once + outlay breach:** agentic BTO 2× 745C at 14:12 UTC ($398) and
  agentic BTO 2× 746C at 14:18 UTC ($308) — $706 concurrent outlay vs the $400 `maxOutlay`, and an
  opposing-position rule that assumes one position at a time.
- **6/30, duplicate entry:** agentic BTO 744C at 14:03 and again at 14:08 — same strike, 5 minutes
  apart.
- **6/30, ~6 round trips** against a "one trade/day unless the first closes green" rule.

**Fix (code, not prose):** in `runScanFast`'s `actionable` gate, treat a *working buy order* as a
position (it currently only checks filled positions), cap entries/day (e.g. 2), and halt after 2
consecutive red closes (readable from the day's reconciled closes). The LLM never gets woken → the
rule cannot be ignored.

## Finding 2 — Unfilled entry orders are invisible

Root cause of Finding 1's double-position: the 7/1 745C limit order sat **20 minutes unfilled**
(placed 14:12, filled 14:32). During that window the snapshot showed "flat," so the agent entered
again. A marketable limit that hasn't filled in ~60–90s is mispriced — cancel and repost or walk
away; never leave a GFD buy limit resting while scans continue.

## Finding 3 — The prompt contradicts itself on resting take-profits (real order-flow risk)

- Step 6 + HARD RULES: "do NOT place any resting take-profit … it blocks the code watcher."
- Step 8: "confirm its resting take-profit limit is still working — **if it's missing, re-place it**."
- `buildFastInstruction` line ~501: "resting +take-profit placed at entry."

Step 6 was updated for the watcher redesign; Step 8 and the fast-instruction text were not. One
LLM scan that follows Step 8 re-creates exactly the blocked-close failure the redesign eliminated.
Delete the stale text.

## Finding 4 — Midday entries keep paying the documented tax

Your own analysis (Jun 28): 11:00–12:30 ET is the dead zone. Today's only loser was entered at
**12:19 ET** and gave back the morning's gains (−$90). The time-of-day preference is prose in the
prompt. **Fix:** hard gate in code — full-size entries 9:35–11:00; after that require 3 agreeing
signals (or simply don't wake the LLM).

## Finding 5 — The daily loss breaker exists but is disabled

`dailyLossLimit: 0` (off) in both `shadow.mjs` defaults and `server.js`. The enforcement path is
built and tested (`server.js:167–177`). One bad regime day (6/23 was −$471) erases weeks. Set it to
~$150 (≈3 full stops at current sizing) — this is the cheap insurance you already wrote.

## Finding 6 — Churn is the remaining cost line

21 round trips in 3 days ≈ $100–200 of spread friction on a ~$2,000 account. Findings 1, 2, and 4
are all the same lever: **fewer, better entries.** At ~2 quality entries/day the same signal set
with the current exits plausibly crosses into positive expectancy — that's the test to run.

## What's working — don't touch

- Watcher exits (stop / stall / EOD) are doing their job post-`STALL_ARM` fix; 7/1 is the proof.
- Safety scope has never been violated (no non-SPY, non-0DTE order ever placed by the agent).
- `market.mjs` deterministic signals + FAST_PATH gating (cost + consistency win).
- Close reconciliation via REST (no more LLM burn for bookkeeping).

## Ranked actions

1. Code-enforce entry caps: working-order check, max 2 entries/day, halt after 2 reds (Findings 1–2).
2. Delete the Step 8 / fast-instruction resting-TP text (Finding 3) — 5-minute fix, real risk.
3. Cancel-or-repost unfilled entry limits after 60–90s (Finding 2).
4. Hard midday gate (Finding 4).
5. Set `dailyLossLimit` ≈ $150 (Finding 5).
6. Then let the forward test run 1–2 weeks untouched. If expectancy is still negative at ~2
   trades/day, the vehicle pilot from the Jun 28 review (3× ETF or 1–3 DTE, same signals) becomes
   the next move — the signals keep showing short-term momentum content; 0DTE friction may simply
   be too expensive for it.

*Engineering review, not financial advice — 3 days / 21 trades is still a small sample.*
