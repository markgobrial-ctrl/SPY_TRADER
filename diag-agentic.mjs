/**
 * diag-agentic.mjs — one-off, READ-ONLY probe.
 * Tests whether the agentic account (545721409) is reachable via the standard
 * Robinhood REST API with the current login, or only via the agent/MCP product.
 * Places no orders, changes nothing.
 *
 * Run on the VPS:  cd /root/spy-trader && node diag-agentic.mjs
 */
import { readFileSync } from "fs";
import { rhGet } from "./rhApi.js";

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

const AG = process.env.ROBINHOOD_ACCOUNT || "545721409";
console.log("Probing agentic account:", AG, "\n");

const probes = [
  `/accounts/${AG}/`,
  `/accounts/?account_numbers=${AG}`,
  `/portfolios/?account_numbers=${AG}`,
  `/options/positions/?nonzero=true&account_numbers=${AG}`,
];

for (const url of probes) {
  try {
    const r = await rhGet(url);
    const preview = JSON.stringify(r);
    console.log(`OK   ${url}`);
    console.log(`     ${preview.slice(0, 400)}${preview.length > 400 ? " …" : ""}\n`);
  } catch (e) {
    console.log(`ERR  ${url}`);
    console.log(`     ${e.message}\n`);
  }
}

console.log("Done — paste the whole output back.");
