/**
 * diag-accounts.mjs — one-off, READ-ONLY diagnostic.
 * Shows which Robinhood accounts this REST login can see, their buying power,
 * and which account each open option position belongs to — so we can scope the
 * data layer to the agentic account only. Places no orders, changes nothing.
 *
 * Run on the VPS:  cd /root/spy-trader && node diag-accounts.mjs
 * (loads .env itself, so no `source` needed)
 */
import { readFileSync } from "fs";
import { rhGet, rhGetAll } from "./rhApi.js";

(function loadEnv() {
  try {
    const txt = readFileSync(new URL("./.env", import.meta.url).pathname, "utf8");
    for (const line of txt.split("\n")) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (m && process.env[m[1]] === undefined) {
        let v = m[2];
        if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
        process.env[m[1]] = v;
      }
    }
  } catch {}
})();

const ACCT = process.env.ROBINHOOD_ACCOUNT || "545721409";
console.log("Configured ROBINHOOD_ACCOUNT (agentic):", ACCT, "\n");

try {
  const accts = await rhGet("/accounts/");
  console.log("Accounts visible to this login:");
  for (const a of (accts.results || [])) {
    console.log(`  number=${a.account_number}  type=${a.type}  brokerage_account_type=${a.brokerage_account_type || "?"}  buying_power=${a.buying_power}  url=${a.url}`);
  }
} catch (e) { console.log("  /accounts/ error:", e.message); }

try {
  const pfs = await rhGet("/portfolios/");
  console.log("\nPortfolios:");
  for (const p of (pfs.results || [])) {
    console.log(`  account=${p.account}  equity=${p.equity}  ext_hours_equity=${p.extended_hours_equity}  withdrawable=${p.withdrawable_amount}`);
  }
} catch (e) { console.log("  /portfolios/ error:", e.message); }

try {
  const pos = await rhGetAll("/options/positions/?nonzero=true");
  console.log("\nOpen option positions (which account each belongs to):");
  for (const p of pos) {
    console.log(`  ${p.chain_symbol}  type=${p.type}  qty=${p.quantity}  account=${p.account}`);
  }
} catch (e) { console.log("  /options/positions/ error:", e.message); }

console.log("\nDone — paste this whole output back.");
