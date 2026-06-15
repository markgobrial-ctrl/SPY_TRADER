/**
 * warmup.mjs — Pre-market Robinhood MCP auth warmup
 *
 * Runs at 9:00, 9:10, 9:20 AM ET (cron: 13:00, 13:10, 13:20 UTC Mon-Fri).
 * Makes a minimal Robinhood MCP call to keep the OAuth session warm so
 * the first trading scan at 9:35 AM finds auth already established.
 *
 * If auth fails (OAuth URL in output), pushes an alert to the dashboard
 * so the user knows to re-authenticate before market open.
 */

import { execFileSync } from "child_process";

const RENDER_URL = process.env.RENDER_URL?.replace(/\/$/, "");
const PUSH_SECRET = process.env.PUSH_SECRET;
const ACCOUNT_NUMBER = process.env.ROBINHOOD_ACCOUNT || "545721409";

function getETTime() {
  return new Date().toLocaleTimeString("en-US", {
    timeZone: "America/New_York",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
}

async function push(body) {
  if (!RENDER_URL) return;
  try {
    await fetch(`${RENDER_URL}/api/push`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-push-secret": PUSH_SECRET || "",
      },
      body: JSON.stringify(body),
    });
  } catch (e) {
    console.error("Push failed:", e.message);
  }
}

console.log(`[${getETTime()}] Warmup starting...`);

try {
  const { ANTHROPIC_API_KEY: _, ...env } = { ...process.env, HOME: "/root" };
  const output = execFileSync("claude", [
    "--model", "claude-sonnet-4-6",
    "--max-turns", "6",
    "-p", `Use the robinhood-trading MCP to check the buying power and portfolio value for account ${ACCOUNT_NUMBER}. Reply with a single JSON object: {"buyingPower": <number>, "portfolioValue": <number>}. No markdown.`,
  ], {
    env,
    timeout: 60 * 1000,
    encoding: "utf8",
  });

  const text = output.trim();

  // Detect OAuth required
  if (/https?:\/\/.*oauth|sign.?in.*required|needs?.auth/i.test(text) ||
      /claude\.ai\/oauth|agent\.robinhood/i.test(text)) {
    const urlMatch = text.match(/https?:\/\/[^\s"]+/);
    const authUrl = urlMatch ? urlMatch[0] : null;
    console.error(`[${getETTime()}] Warmup: Robinhood needs re-auth`);
    await push({
      type: "error",
      content: `⚠️ ROBINHOOD AUTH REQUIRED before market open!\n${authUrl ? `Open this URL:\n${authUrl}` : 'SSH into VPS and run: claude -p "check robinhood"'}`,
    });
    process.exit(1);
  }

  // Success — try to parse and push account data
  const match = text.match(/\{[\s\S]*?\}/);
  if (match) {
    try {
      const account = JSON.parse(match[0]);
      if (account.buyingPower !== undefined || account.portfolioValue !== undefined) {
        await push({ account: { accountNumber: ACCOUNT_NUMBER, ...account } });
        console.log(`[${getETTime()}] Warmup OK — auth is live. BP: $${account.buyingPower}`);
      }
    } catch {}
  }

  console.log(`[${getETTime()}] Warmup complete`);
} catch (err) {
  const msg = err.message || String(err);
  if (/oauth|auth|sign.?in/i.test(msg)) {
    await push({
      type: "error",
      content: `⚠️ ROBINHOOD AUTH REQUIRED before market open! SSH into VPS and run:\nclaude -p "check robinhood portfolio"\nThen complete the browser OAuth.`,
    });
  }
  console.error(`[${getETTime()}] Warmup error:`, msg);
  process.exit(1);
}
