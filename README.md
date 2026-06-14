# SPY 0DTE Agent — Server

Autonomous 0DTE SPY options trading agent. Runs on Render, monitored from your Android via mobile web dashboard.

## Architecture

```
Render (Node.js)
  └── Express server
       ├── Cron job (every N mins, market hours only)
       │    └── Calls Anthropic API + Robinhood MCP
       ├── SSE endpoint (live log stream to dashboard)
       └── REST API (enable/disable, manual scan, emergency stop)

Mobile browser (Android)
  └── public/index.html (served by Express)
       ├── Live log feed via SSE
       ├── Auto mode toggle
       └── Emergency stop button
```

## Deploy to Render

### 1. Push to GitHub
```bash
git init
git add .
git commit -m "initial"
git remote add origin https://github.com/YOUR_USERNAME/spy-0dte-agent.git
git push -u origin main
```

### 2. Create Render Web Service
1. Go to https://render.com → New → Web Service
2. Connect your GitHub repo
3. Settings:
   - **Environment:** Node
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Instance Type:** Starter ($7/mo) — needed for persistent disk

### 3. Add Environment Variables in Render
Under your service → Environment:
```
ANTHROPIC_API_KEY   = your_key_here
ROBINHOOD_ACCOUNT   = 5UV19627
```

### 4. Add Persistent Disk (important)
Under your service → Disks → Add Disk:
- **Name:** data
- **Mount Path:** /opt/render/project/src/data
- **Size:** 1 GB

This keeps trade logs and conversation history across restarts.

Update the db path in server.js if needed:
```js
const db = new Low(new JSONFile("/opt/render/project/src/data/db.json"), {...})
```

### 5. Open on Android
Once deployed, Render gives you a URL like:
`https://spy-0dte-agent.onrender.com`

On Android Chrome:
1. Open the URL
2. Tap the 3-dot menu → "Add to Home screen"
3. It installs like an app

## Usage

- **Enable Auto Mode** — agent scans on your chosen interval during market hours (9:35–11 AM ET for new trades)
- **Scan Now** — trigger a manual scan anytime
- **Positions** — see open SPY options and P&L
- **Close All** — emergency close all positions
- **🛑 E-STOP** — disables auto mode immediately

## Strategy (baked into agent)
- Trade window: 9:35–11:00 AM ET only
- Instruments: SPY 0DTE calls and puts only (no spreads)
- VIX filter: 16–35
- Momentum filter: SPY >0.4% from open
- Size: 1 contract standard, 2 on highest conviction
- Max outlay: $400/trade
- Stop loss: 40% of premium
- Target: 150%+, let winners run

## Local Development
```bash
npm install
cp .env.example .env
# fill in ANTHROPIC_API_KEY
npm run dev
# open http://localhost:3000
```
