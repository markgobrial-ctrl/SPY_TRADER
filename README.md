# SPY 0DTE Agent

Autonomous 0DTE SPY options trading agent, monitored from your phone via a mobile web dashboard.

> ⚠️ **Real-money trading.** This software places live options orders autonomously. 0DTE options are extremely high risk and can go to zero in minutes. Use only risk capital, understand the strategy below, and keep the emergency stop within reach.

## Architecture

The system is split across two runtimes that talk over a small HTTP API:

```
VPS (Ubuntu, cron every minute)              Render (Node.js / Express)
  vps-agent.mjs                                server.js
   ├── polls Render /api/pending  ◄──────────  ├── stores state in data/db.json (lowdb)
   │     (enabled? interval? queued action)    ├── /api/pending  → hands the VPS its next action
   ├── runs Claude Code + Robinhood MCP        ├── /api/push     ← receives logs/trades/account
   │     to scan and place trades              ├── /api/stream   → live SSE feed to the dashboard
   └── pushes results to Render /api/push  ──►  └── serves index.html (mobile dashboard)
  warmup.mjs (pre-market, keeps MCP auth warm)
```

Key point: **Render does not run the trading loop.** It's a thin state store + dashboard. The
VPS owns the cron schedule, talks to Claude Code and the Robinhood MCP, and pushes results back.
The two share a `PUSH_SECRET` so only your VPS can post to `/api/push` and read `/api/pending`.

## Components

| File | Runs on | Purpose |
|------|---------|---------|
| `server.js` | Render | Express dashboard, state store, SSE feed, push/pending API |
| `index.html` | Browser | Mobile dashboard (log feed, auto toggle, account, e-stop) |
| `vps-agent.mjs` | VPS (cron, every minute) | Decides if a scan is due, drives Claude Code + Robinhood MCP, pushes results |
| `warmup.mjs` | VPS (cron, pre-market) | Keeps the Robinhood MCP OAuth session warm before 9:35 AM |
| `setup-vps.sh` | VPS (once) | Installs Node, Claude Code, scripts, and cron jobs |
| `rhApi.js`, `get-rh-token.mjs` | — | Legacy direct-REST Robinhood path, **not used** by the current MCP design (kept for reference) |

## Deploy the dashboard to Render

1. Push this repo to GitHub.
2. Render → New → Web Service → connect the repo.
   - **Environment:** Node
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Instance Type:** Starter ($7/mo) — required for a persistent disk
3. Add a persistent disk so logs/trades survive restarts:
   - **Mount Path:** `/opt/render/project/src/data`
   - **Size:** 1 GB

   The DB path in `server.js` is `data/db.json` relative to the project, which resolves to the
   mount above on Render.
4. Set environment variables (Render → Environment):
   ```
   PUSH_SECRET        = <long random string, must match the VPS>
   ROBINHOOD_ACCOUNT  = 545721409
   DASHBOARD_PASSWORD = <optional, protects the dashboard with Basic Auth>
   ```
5. Open the Render URL on your phone and "Add to Home screen" for an app-like shortcut.

## Set up the VPS agent

On a fresh Ubuntu 22.04 server:

```bash
curl -fsSL https://raw.githubusercontent.com/markgobrial-ctrl/SPY_TRADER/main/setup-vps.sh | bash
```

This installs Node 20, Claude Code, downloads `vps-agent.mjs` + `warmup.mjs`, and installs the
cron jobs. Then finish two manual steps it prints:

1. Edit `/root/spy-trader/.env` — set `ANTHROPIC_API_KEY` and `PUSH_SECRET` (same value as Render),
   confirm `RENDER_URL` and `ROBINHOOD_ACCOUNT`.
2. Connect Robinhood once (browser OAuth):
   ```bash
   claude mcp add robinhood-trading --transport http https://agent.robinhood.com/mcp/trading
   ```

Cron then runs the agent every minute (it self-limits to your chosen scan interval during market
hours) and warms auth at 9:00/9:10/9:20 AM ET.

## Usage (dashboard)

- **Auto Trading toggle** — agent scans on your chosen interval during market hours
- **Scan Now** — trigger a manual scan immediately
- **Positions / Account** — request a fresh snapshot from the agent
- **Close All** — queue an emergency close of all positions
- **⛔ Stop** — disable auto mode immediately

## Strategy (baked into the agent)

- Trade window: 9:35 AM–2:00 PM ET (`entryWindowEnd`, manage-only after; close all by 3:45 PM ET)
- Instruments: SPY 0DTE calls and puts only — directional, no spreads
- VIX filter: 16–35
- Momentum filter: SPY > 0.4% from open
- Size: risk-based, clamped to `maxContracts` (default 2); max $400/trade
- Stop loss: 40% of premium · Take-profit: a resting limit at **+25%** (`targetPct`), placed at entry — these 0DTE pops mean-revert, so bank the spike rather than holding for a moonshot (see `LOG_REVIEW_2026-06-28.md`)
- One trade/day unless the first closes profitably

## Fast stop-watcher (hard-stop backstop)

The agent places a resting take-profit limit at entry (captures the upside spike between scans).
`watch.mjs` is the matching downside: a lightweight, **code-only** loop (no LLM) that checks open
SPY 0DTE positions every ~30s and flattens one whose premium has fallen past the hard stop — the
thing a slow scan loop misses (see `LOG_REVIEW_2026-06-28.md` for why a monitored-only stop blew
through to −60%+).

It is **off by default**, behind two gates:

- `WATCHER=1` — enable it at all (otherwise it exits immediately).
- `WATCHER_ARMED=1` — place real orders. Unset/`0` = **dry-run**: it logs exactly what it *would*
  do (`[DRY-RUN] … would cancel resting take-profit and sell-to-close …`) without touching the account.

Other safety properties: SPY 0DTE only; agentic account only; respects the dashboard e-stop (if the
agent is disabled it stands down, so it never fights manual control); cancels the resting take-profit
before closing so there is never more than one live sell on a contract; and because this is a cash,
level-2 account, a stray extra sell would be a forbidden naked short and is rejected by the broker
rather than leaving you short. It uses the **direct Robinhood REST API** (`rhApi.js`), so the VPS
`.env` needs `ROBINHOOD_TOKEN` / `ROBINHOOD_REFRESH_TOKEN` (generate with `node get-rh-token.mjs`).

### Arming it (in order — do not skip the dry-run)

1. Deploy: `bash update-vps.sh`. On an existing VPS, add the cron once:
   ```
   ( crontab -l; echo '* 13-20 * * 1-5 cd /root/spy-trader && /usr/bin/node --env-file=.env watch.mjs >> /root/spy-watch.log 2>&1' ) | crontab -
   ```
2. Set `WATCHER=1` and **leave `WATCHER_ARMED` unset** (dry-run). Watch `/root/spy-watch.log` for a
   session that has a live position — confirm it sees the position and prints sane "would
   cancel/close" lines at the right stop level.
3. Once the dry-run looks correct, validate the live order path **once** under supervision: set
   `WATCHER_ARMED=1`, watch the first real stop-out (or hand-test a single-contract close), and
   confirm the cancel-then-close fills cleanly. Only then leave it armed.

## Local development

```bash
npm install
cp .env.example .env   # fill in PUSH_SECRET etc.
npm run dev            # http://localhost:3000
```

Locally you'll see the dashboard; trading only happens when a configured VPS agent is pushing to
the same store.
