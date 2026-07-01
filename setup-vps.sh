#!/bin/bash
# SPY Trader VPS Setup — run once on a fresh Ubuntu 22.04 server
# Usage: curl -fsSL https://raw.githubusercontent.com/markgobrial-ctrl/SPY_TRADER/main/setup-vps.sh | bash
set -e

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  SPY Trader VPS Setup"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# ── 1. Node.js 20 ─────────────────────────────────────────────────────────────
echo ""
echo "▶ Installing Node.js 20..."
curl -fsSL https://deb.nodesource.com/setup_20.x | bash - > /dev/null 2>&1
apt-get install -y nodejs > /dev/null 2>&1
echo "  ✓ Node $(node -v)"

# ── 2. Claude Code ────────────────────────────────────────────────────────────
echo ""
echo "▶ Installing Claude Code..."
npm install -g @anthropic-ai/claude-code > /dev/null 2>&1
echo "  ✓ Claude Code $(claude --version 2>/dev/null || echo 'installed')"

# ── 3. Project directory ──────────────────────────────────────────────────────
echo ""
echo "▶ Setting up /root/spy-trader..."
mkdir -p /root/spy-trader
cd /root/spy-trader

# Download agent scripts from GitHub
curl -fsSL https://raw.githubusercontent.com/markgobrial-ctrl/SPY_TRADER/main/vps-agent.mjs \
  -o vps-agent.mjs
echo "  ✓ vps-agent.mjs downloaded"

curl -fsSL https://raw.githubusercontent.com/markgobrial-ctrl/SPY_TRADER/main/warmup.mjs \
  -o warmup.mjs
echo "  ✓ warmup.mjs downloaded"

# ── 4. Environment file ───────────────────────────────────────────────────────
if [ ! -f /root/spy-trader/.env ]; then
cat > /root/spy-trader/.env << 'EOF'
ANTHROPIC_API_KEY=PASTE_YOUR_KEY_HERE
RENDER_URL=https://spy-trader.onrender.com
PUSH_SECRET=PASTE_YOUR_PUSH_SECRET_HERE
ROBINHOOD_ACCOUNT=545721409
# FAST_PATH=1 gathers market data in code and only wakes Claude for actionable
# entries — cuts Claude usage ~90%. Needs FMP_API_KEY + RH tokens (get-rh-token.mjs).
FAST_PATH=1
FMP_API_KEY=PASTE_YOUR_FMP_KEY_HERE
ROBINHOOD_TOKEN=RUN_get-rh-token.mjs
ROBINHOOD_REFRESH_TOKEN=RUN_get-rh-token.mjs
EOF
echo "  ✓ .env file created — edit it next"
else
  echo "  ✓ .env already exists, skipping"
fi

# ── 5. Cron job (every minute, logs to /root/spy-agent.log) ──────────────────
echo ""
echo "▶ Installing cron jobs..."
CRON_CMD="* * * * * cd /root/spy-trader && /usr/bin/node --env-file=.env vps-agent.mjs >> /root/spy-agent.log 2>&1"
# Pre-market auth warmup at 9:00/9:10/9:20/9:30/9:34 AM ET (Mon–Fri). The last two
# runs sit right before the 9:35 open so the OAuth session is fresh for the first
# scan — a 15-min gap (old 9:20 → 9:35) let the token lapse and blocked entries.
# Note: cron uses UTC; these times assume US Eastern Daylight Time (UTC-4).
WARMUP_CMD="0,10,20,30,34 13 * * 1-5 cd /root/spy-trader && /usr/bin/node --env-file=.env warmup.mjs >> /root/spy-warmup.log 2>&1"
# Weekly performance review — Sunday 10:00 AM ET (14:00 UTC during EDT).
REVIEW_CMD="0 14 * * 0 cd /root/spy-trader && /usr/bin/node --env-file=.env review.mjs >> /root/spy-trader/review.log 2>&1"
# Fast stop-watcher — every minute during RTH (UTC 13–20 ≈ 9am–4:59pm ET, Mon–Fri).
# Self-guards market hours; runs a ~55s internal loop so the effective cadence is ~30s.
# Off unless WATCHER=1 in .env; only places orders when WATCHER_ARMED=1 (else dry-run).
WATCH_CMD="* 13-20 * * 1-5 cd /root/spy-trader && /usr/bin/node --env-file=.env watch.mjs >> /root/spy-watch.log 2>&1"
# Remove old entries if they exist, then add fresh
( crontab -l 2>/dev/null | grep -v "vps-agent" | grep -v "warmup" | grep -v "review.mjs" | grep -v "watch.mjs" ; echo "$CRON_CMD" ; echo "$WARMUP_CMD" ; echo "$REVIEW_CMD" ; echo "$WATCH_CMD" ) | crontab -
echo "  ✓ Agent cron set (runs every minute)"
echo "  ✓ Warmup cron set (9:00/9:10/9:20/9:30/9:34 AM ET, Mon–Fri)"
echo "  ✓ Weekly review cron set (Sun 10:00 AM ET)"
echo "  ✓ Stop-watcher cron set (every minute during RTH; off until WATCHER=1)"

# ── 6. Configure MCP servers ──────────────────────────────────────────────────
echo ""
echo "▶ Configuring MCP servers for Claude Code..."
# FMP (no auth needed)
claude mcp add fmp --transport http https://financialmodelingprep.com/mcp 2>/dev/null || true
echo "  ✓ FMP MCP added"

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Setup complete! Two steps left:"
echo ""
echo "  1. Edit your credentials:"
echo "     nano /root/spy-trader/.env"
echo "     (fill in ANTHROPIC_API_KEY and PUSH_SECRET)"
echo ""
echo "  2. Connect Robinhood (one-time auth):"
echo "     ANTHROPIC_API_KEY=\$(grep ANTHROPIC_API_KEY /root/spy-trader/.env | cut -d= -f2) \\"
echo "     claude mcp add robinhood-trading --transport http https://agent.robinhood.com/mcp/trading"
echo ""
echo "  After those two steps, the agent runs automatically"
echo "  during market hours every 10 minutes."
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
