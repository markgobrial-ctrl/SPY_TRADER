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

# Download agent script from GitHub
curl -fsSL https://raw.githubusercontent.com/markgobrial-ctrl/SPY_TRADER/main/vps-agent.mjs \
  -o vps-agent.mjs
echo "  ✓ vps-agent.mjs downloaded"

# ── 4. Environment file ───────────────────────────────────────────────────────
if [ ! -f /root/spy-trader/.env ]; then
cat > /root/spy-trader/.env << 'EOF'
ANTHROPIC_API_KEY=PASTE_YOUR_KEY_HERE
RENDER_URL=https://spy-trader.onrender.com
PUSH_SECRET=PASTE_YOUR_PUSH_SECRET_HERE
ROBINHOOD_ACCOUNT=5UV19627
EOF
echo "  ✓ .env file created — edit it next"
else
  echo "  ✓ .env already exists, skipping"
fi

# ── 5. Cron job (every minute, logs to /root/spy-agent.log) ──────────────────
echo ""
echo "▶ Installing cron job..."
CRON_CMD="* * * * * cd /root/spy-trader && /usr/bin/node --env-file=.env vps-agent.mjs >> /root/spy-agent.log 2>&1"
# Remove old entry if exists, then add fresh
( crontab -l 2>/dev/null | grep -v "vps-agent" ; echo "$CRON_CMD" ) | crontab -
echo "  ✓ Cron job set (runs every minute)"

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
