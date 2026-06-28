#!/bin/bash
# Update the VPS agent to the latest committed version from GitHub.
# Usage:  bash /root/spy-trader/update-vps.sh
# Safe to re-run. Does not touch .env, data/, or node_modules (all gitignored).
set -e

cd /root/spy-trader

echo "▶ Fetching latest from GitHub…"
git fetch origin
git reset --hard origin/main

echo "▶ Checking scripts parse…"
node --check vps-agent.mjs
node --check warmup.mjs
node --check watch.mjs

echo "✓ Updated to $(git rev-parse --short HEAD) — $(git log -1 --pretty=%s)"
echo "  Cron runs the new files automatically on the next minute. No restart needed."
