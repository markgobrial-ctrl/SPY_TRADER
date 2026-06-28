# Extensive Review — Strategy, Logic, Vehicle & UI

**2026-06-28 · posture: aggressive growth (blow-up accepted) · the vehicle itself is challenged**

Account (agentic SPY 0DTE): $2,000 → **$1,021 (−49%)** in one week. Broker-confirmed realized P&L:
bot **−$978** (6/22–26), your manual GOOGL/UNH **−$65**, **fees ≈ $0**. So the cost drag is *spread*,
not commissions — that matters for what's worth fixing.

## 1. Vehicle verdict — is 0DTE directional even viable?

The uncomfortable math: buying a 0DTE option means paying for the day's *expected* move (the market
maker already priced it) plus the spread plus theta. The structural edge is against the buyer; you
only win if your timing beats all three often enough. A −54% week at a 27% raw win rate is what
negative edge looks like.

**But the entries are not the problem.** 21 of 22 trades went green (median peak **+59%**); the loss
was ~100% *give-back*. That means the entry signal carries real short-term momentum content and the
system was bleeding on **exits**, which we've now fixed. Honest read: **plausibly positive-edge
entries that were wrapped in broken exits** — not proven, but not hopeless. (22 trades, one
mean-reverting week — a hypothesis, not a result.)

**The single biggest lever the vehicle offers:** run the *same signal* on an instrument that doesn't
decay to zero in minutes.
- **3× ETF intraday (SPXL/UPRO/TQQQ)** — captures the directional move, no theta, no expiry cliff,
  far tighter spreads. Less lottery convexity, vastly more survivable. For a momentum bot this is
  arguably *strictly better* risk-adjusted, and "survive to compound" *is* max growth.
- **1–3 DTE options** — keep convexity, gentler theta, tighter spreads, room for the thesis to work.
- Keep a small **0DTE lottery sleeve** only for the fat tail, if you want the convexity.

**Recommendation:** pilot the existing signals on a 3× ETF (or 1–3 DTE) at 1 unit, in parallel with
0DTE, and compare drawdown-adjusted. If it matches or beats 0DTE with a shallower curve, migrate the
core there and keep 0DTE as a satellite. Highest-EV change on the table.

## 2. Edge & methodology

- **Signals are thinner than they look.** 4 inputs, `minSignals=2`. `vwap` was a 0.03% rounding-error
  trigger (just fixed → 0.10% + bar-confirmation). `or_breakout` has no buffer — a 1¢ poke fires it
  (add ~0.05%). `trend` is a coarse 6-bar read. Tightening inputs beats adding inputs.
- **Concentrate at the open.** 9:35–10:30 had ~3× the favorable move of late morning (shipped as
  guidance). The 11:00–12:30 lull is where the edge dies — be willing to pass.
- **Exit:** fixed take-profit in +15–25% (shipped +25). Trailing/scale-out were refuted on your tape;
  let live fills pick the exact number.
- **Spread is the real cost** (fees are ~$0). Tighten the liquidity gate 3%→2%, ATM only, favor the
  liquid open — at a +20% target a 3% round-trip eats a third of the edge.
- **Data ceiling:** 5-min bars cap VWAP/opening-range precision; 1-min bars are the biggest data
  upgrade if you keep pushing this.
- **Auto-tuner is mostly inert** (4 keys, needs ≥25 entries, off by default) — don't expect it to find
  edge.

## 3. Risk & sizing (aggressive posture, honest math)

- You've accepted blow-up risk — fine — but the one place it's *pure value destruction* (not upside)
  is **uncapped daily loss**: one bad regime day (6/23 was −$471) round-trips weeks of gains, and you
  can't compound from a hole. The watcher caps *per-trade*; nothing caps *per-day*. Suggest a soft
  **"halt after 3 consecutive reds"** (behavioral, not the $ breaker you dislike).
- **Growth ladder:** define explicit scaling (e.g., +1 contract per +$750 equity) **but gate it on a
  confirmed edge** (≥20 fills, >55% win, positive expectancy). Scaling into the current unproven edge
  is precisely how −54% repeats. Below $1,500 the code already forces 1 contract, so you're correctly
  at 1 now.

## 4. P&L accounting (correctness)

- `recordClose` dedupes by order id and resets `realizedToday` per ET day — sound.
- **Win = `pnl>0` counts scratches as wins**, so win-rate alone flatters this strategy. Track avg win,
  avg loss, **profit factor**, and **expectancy/trade** instead.
- `realizedToday` only updates on the VPS ~15-min close-reconcile, so any *day-level* control built on
  it lags — another reason the per-position watcher is the real-time control.

## 5. UI (decision-grade gaps)

The dashboard is genuinely good (Home / Activity / Strategy / Trades, editable levers, change history,
proposals). What's missing to actually *manage edge*:
- **Expectancy panel:** avg win, avg loss, profit factor, $/trade — not just win rate.
- **Give-back per trade:** entry % → peak % → exit %. This single view diagnoses the whole strategy
  (are you harvesting near target, or leaking?).
- **Equity curve + max drawdown** (today you only see one P&L number).
- **Watcher status:** armed? last fire? (the new stop is invisible in the UI).
- **Per-scan "why":** the firing signals + decision (FAST_PATH already journals this — surface it).
- Show the **live take-profit target and FAST_PATH state** on the Strategy tab.

## 6. Ranked roadmap (impact × effort, growth-weighted)

1. **Forward-test the shipped exit ~1–2 weeks at 1 contract** — the edge is unproven; this gates
   everything else. (Daily post-close review already scheduled.)
2. **Pilot the signals on a 3× ETF or 1–3 DTE** — biggest survivability/growth lever.
3. **Deploy the staged `market.mjs` fixes** (vwap + stale-bars) after a few clean forward-test days.
4. **UI: add expectancy + give-back + equity curve + watcher status.**
5. **Edge-gated sizing ladder** + soft "halt after 3 reds."
6. Spread gate → 2%; `or_breakout` buffer; (later) 1-min data.

**Caveat:** 22 trades, one regime. Every figure here is a hypothesis until the forward-test produces
real fills under the new exit logic. Prove the edge small before you size into it — that's the only
path by which "aggressive growth" actually compounds instead of zeroing.
