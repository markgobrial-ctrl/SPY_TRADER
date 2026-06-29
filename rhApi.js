/**
 * rhApi.js — Direct Robinhood REST API client (no MCP, no 2FA)
 * Credentials come from env vars: ROBINHOOD_USERNAME, ROBINHOOD_PASSWORD
 * Token is cached in memory and refreshed when it expires.
 */

import { readFileSync, writeFileSync, existsSync } from "fs";

const RH_BASE = "https://api.robinhood.com";
// Standard Robinhood iOS client_id (public knowledge, used by all unofficial clients)
const CLIENT_ID = "c82SH0WZOsabOXGP2sxqcj34FxkvfnWRZBKlBjFS";
// Consistent device token (avoids Robinhood flagging us as a new device every restart)
const DEVICE_TOKEN =
  process.env.ROBINHOOD_DEVICE_TOKEN || "a3244b17-5aab-4c8e-9e4d-2b4f3a8ecb4a";

const UA = "Robinhood/823 (iPhone; iOS 7.1.2; Scale/2.00)";
const TIMEOUT_MS = 12000; // 12s max per request

let _token = null;
let _tokenExpiry = 0;
let _envSeedTried = false; // env access-token seed is one-shot (don't re-seed a token that just 401'd)

// Persist token state so it survives across fresh per-invocation processes (cron,
// repeated CLI runs). Robinhood ROTATES the refresh token on every refresh
// (single-use); without persistence the rotated token is lost and the next
// process reuses the dead one → "invalid_grant". The store keeps the latest
// access token (reused until it expires) and the latest refresh token.
const TOKEN_STORE = process.env.RH_TOKEN_STORE || new URL("./.rh-token.json", import.meta.url).pathname;
function loadStore() {
  try { return existsSync(TOKEN_STORE) ? JSON.parse(readFileSync(TOKEN_STORE, "utf8")) : {}; }
  catch { return {}; }
}
function saveStore(s) {
  try { writeFileSync(TOKEN_STORE, JSON.stringify(s), { mode: 0o600 }); } catch { /* best-effort */ }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function fetchWithTimeout(url, opts = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  return fetch(url, { ...opts, signal: ctrl.signal }).finally(() => clearTimeout(timer));
}

// ── Auth ──────────────────────────────────────────────────────────────────────

// In-memory refresh token (seeded from env var, updated after each refresh)
let _refreshToken = null; // seeded from env at call time in getToken() so dotenv-loaded creds are picked up

export async function getRHToken() { return getToken(); }

async function getToken() {
  // In-memory fast path (within a single process).
  if (_token && Date.now() < _tokenExpiry) return _token;

  // Seed the refresh token from env on first use (call-time so a dotenv-loaded
  // value is picked up); the persisted store below overrides it if newer.
  if (!_refreshToken) _refreshToken = process.env.ROBINHOOD_REFRESH_TOKEN || null;

  // Reuse a still-valid access token from the persisted store — avoids hitting the
  // refresh endpoint (and rotating the single-use refresh token) on every run.
  const store = loadStore();
  if (store.access_token && store.expiry && Date.now() < store.expiry - 60_000) {
    _token = store.access_token;
    _tokenExpiry = store.expiry;
    if (store.refresh_token) _refreshToken = store.refresh_token;
    return _token;
  }
  // Always prefer the freshest refresh token: the rotated one in the store over
  // the env seed (which is only the first-boot value).
  if (store.refresh_token) _refreshToken = store.refresh_token;

  // Prefer a valid access token (env seed on first boot) over refreshing — this
  // avoids rotating the refresh token until the access token actually expires.
  // A stale seed self-heals via the 401 retry in rhGet().
  if (!store.access_token && !_envSeedTried && process.env.ROBINHOOD_TOKEN) {
    _envSeedTried = true; // one-shot: if this seed 401s, the retry refreshes instead of re-seeding
    _token = process.env.ROBINHOOD_TOKEN;
    _tokenExpiry = Date.now() + 23 * 60 * 60 * 1000;
    saveStore({ access_token: _token, expiry: _tokenExpiry, refresh_token: _refreshToken || null });
    return _token;
  }

  if (_refreshToken) return refreshAccessToken();

  throw new Error(
    "No Robinhood credentials found. Run get-rh-token.mjs and set " +
    "ROBINHOOD_TOKEN and ROBINHOOD_REFRESH_TOKEN in the VPS .env."
  );
}

// Drop the current access token (memory + store) so the next call refreshes.
function invalidateToken() {
  _token = null;
  _tokenExpiry = 0;
  const s = loadStore();
  delete s.access_token;
  delete s.expiry;
  saveStore(s);
}

async function refreshAccessToken() {
  const resp = await fetchWithTimeout(`${RH_BASE}/oauth2/token/`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": UA },
    body: JSON.stringify({
      grant_type: "refresh_token",
      refresh_token: _refreshToken,
      client_id: CLIENT_ID,
      scope: "internal",
      device_token: DEVICE_TOKEN,
    }),
  });

  const data = await resp.json();

  if (!data.access_token) {
    throw new Error(
      `Robinhood token refresh failed: ${JSON.stringify(data)}. ` +
      "Re-run get-rh-token.mjs and update ROBINHOOD_REFRESH_TOKEN on Render."
    );
  }

  _token = data.access_token;
  _tokenExpiry = Date.now() + (data.expires_in - 300) * 1000;
  // Robinhood rotates the refresh token on every refresh — keep the new one and
  // persist it (plus the fresh access token) so the next process doesn't reuse a
  // dead refresh token.
  if (data.refresh_token) _refreshToken = data.refresh_token;
  saveStore({ access_token: _token, expiry: _tokenExpiry, refresh_token: _refreshToken || null });
  return _token;
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────

export async function rhGet(url, _retry = true) {
  const token = await getToken();
  const fullUrl = url.startsWith("http") ? url : `${RH_BASE}${url}`;
  const resp = await fetchWithTimeout(fullUrl, {
    headers: { Authorization: `Bearer ${token}`, "User-Agent": UA },
  });
  // Access token died early (e.g. a stale env seed) — drop it and refresh once.
  if (resp.status === 401 && _retry) {
    invalidateToken();
    return rhGet(url, false); // getToken() will refresh via the refresh token
  }
  if (!resp.ok) {
    throw new Error(`Robinhood API error ${resp.status} on ${fullUrl}`);
  }
  return resp.json();
}

// Paginate through all results if Robinhood paginates
export async function rhGetAll(url) {
  const results = [];
  let next = url;
  while (next) {
    const page = await rhGet(next);
    results.push(...(page.results || []));
    next = page.next || null;
  }
  return results;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Returns { buying_power, portfolio_value, positions }
 * positions: [{ type, strike, expiry, qty, avg_cost, current_price, pnl_pct }]
 */
export async function getAccountData() {
  // SCOPE EVERYTHING to the agentic account. This REST login also exposes the
  // user's PERSONAL account (with unrelated SPY + CRM holdings), and the unscoped
  // list endpoints return that account first — the wrong-account bug. The agentic
  // account is reachable directly by number even though it isn't in /accounts/'s
  // default list (/accounts/{n}/ works; the ?account_numbers= filter on /accounts/
  // returns empty, so we use the direct path there).
  const ACCT = process.env.ROBINHOOD_ACCOUNT || "545721409";

  // 1a. Buying power from the agentic ACCOUNT object (cash account → available cash).
  let buying_power = 0;
  try {
    const acct = await rhGet(`/accounts/${ACCT}/`);
    buying_power = parseFloat(
      acct.buying_power ?? acct.cash_available_for_withdrawal ?? acct.portfolio_cash ?? acct.cash ?? 0
    ) || 0;
  } catch {}

  // 1b. Portfolio equity for the agentic account.
  let portfolio_value = 0;
  try {
    const portfolioData = await rhGet(`/portfolios/?account_numbers=${ACCT}`);
    const p = (portfolioData.results || [])[0] || {};
    portfolio_value = parseFloat(p.extended_hours_equity || p.equity || p.market_value || 0) || 0;
    if (!buying_power) buying_power = parseFloat(p.withdrawable_amount || 0) || 0;
  } catch {}

  // 2. Open option positions for the AGENTIC account only.
  const rawPositions = await rhGetAll(`/options/positions/?nonzero=true&account_numbers=${ACCT}`);

  // 3. Enrich each position with instrument details + current market price
  const positions = (
    await Promise.all(
      rawPositions.map(async (pos) => {
        try {
          const instrumentUrl = pos.option; // URL like https://api.robinhood.com/options/instruments/{id}/
          const optionId = instrumentUrl.replace(/\/$/, "").split("/").pop();

          const [instrument, quote] = await Promise.all([
            rhGet(instrumentUrl),
            rhGet(`/marketdata/options/${optionId}/`),
          ]);

          // Robinhood's average_price is per CONTRACT (price/share × multiplier),
          // but the option mark_price is per SHARE — normalize avg to per-share so
          // the two are comparable and pnl_pct is correct. (Sanity check: a 4-lot
          // 0DTE call in a ~$2k account only fits if average_price is per-contract.)
          const multiplier = parseFloat(pos.trade_value_multiplier || 100) || 100;
          const avg_cost = parseFloat(pos.average_price || 0) / multiplier;
          const current_price = parseFloat(
            quote.adjusted_mark_price || quote.mark_price || 0
          );
          const qty = parseFloat(pos.quantity || 0);
          const pnl_pct =
            avg_cost > 0
              ? Math.round(((current_price - avg_cost) / avg_cost) * 1000) / 10
              : 0;

          return {
            symbol: instrument.chain_symbol, // underlying ticker, e.g. "SPY"
            type: instrument.type, // "call" or "put"
            strike: parseFloat(instrument.strike_price),
            expiry: instrument.expiration_date,
            qty,
            avg_cost,
            current_price,
            pnl_pct,
          };
        } catch {
          return null; // skip positions we can't enrich
        }
      })
    )
  ).filter(Boolean);

  return { buying_power, portfolio_value, positions };
}

// ── WRITE helpers (orders) — used ONLY by the armed stop-watcher (watch.mjs) ────
// These place/cancel REAL orders. They run only when watch.mjs is ARMED
// (WATCHER_ARMED=1, DRY_RUN off). The order payload follows Robinhood's options
// order API; VALIDATE it with ONE supervised live close before trusting it
// autonomously (see the "Arming the watcher" steps in README).
const ACCT = () => process.env.ROBINHOOD_ACCOUNT || "545721409";

export async function rhPost(url, body, _retry = true) {
  const token = await getToken();
  const fullUrl = url.startsWith("http") ? url : `${RH_BASE}${url}`;
  const resp = await fetchWithTimeout(fullUrl, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "User-Agent": UA, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (resp.status === 401 && _retry) { invalidateToken(); return rhPost(url, body, false); }
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(`Robinhood POST ${resp.status} on ${fullUrl}: ${JSON.stringify(data).slice(0, 300)}`);
  return data;
}

// Latest SPY last-trade price (one quote) — for the watcher's momentum-stall tracking.
export async function getSpyPrice() {
  const q = await rhGet("/quotes/SPY/");
  return parseFloat(q.last_trade_price ?? q.last_extended_hours_trade_price ?? 0) || null;
}

// Open SPY 0DTE LONG positions for the agentic account, enriched with the option
// instrument id + live bid/ask/mark and pnl_pct. `todayET` is "YYYY-MM-DD" in ET.
export async function getOpenSpyOdtePositions(todayET) {
  const raw = await rhGetAll(`/options/positions/?nonzero=true&account_numbers=${ACCT()}`);
  const out = [];
  for (const pos of raw) {
    try {
      const instrumentUrl = pos.option;
      const optionId = instrumentUrl.replace(/\/$/, "").split("/").pop();
      const [instrument, quote] = await Promise.all([
        rhGet(instrumentUrl),
        rhGet(`/marketdata/options/${optionId}/`),
      ]);
      if (instrument.chain_symbol !== "SPY") continue;       // SPY only
      if (instrument.expiration_date !== todayET) continue;  // 0DTE only
      const qty = parseFloat(pos.quantity || 0);
      if (!(qty > 0)) continue;                              // open long only
      const multiplier = parseFloat(pos.trade_value_multiplier || 100) || 100;
      const avg_cost = parseFloat(pos.average_price || 0) / multiplier;
      const mark = parseFloat(quote.adjusted_mark_price || quote.mark_price || 0);
      const bid = parseFloat(quote.bid_price || 0);
      const ask = parseFloat(quote.ask_price || 0);
      const pnl_pct = avg_cost > 0 ? ((mark - avg_cost) / avg_cost) * 100 : 0;
      out.push({ option_id: optionId, instrumentUrl, type: instrument.type, strike: parseFloat(instrument.strike_price), expiry: instrument.expiration_date, qty, avg_cost, mark, bid, ask, pnl_pct });
    } catch { /* skip positions we can't enrich */ }
  }
  return out;
}

// Open (cancellable) SELL orders for an option_id — i.e. the resting take-profit.
export async function findRestingSellOrders(optionId) {
  const orders = await rhGetAll(`/options/orders/?account_numbers=${ACCT()}`);
  return (orders || []).filter((o) =>
    ["queued", "confirmed", "unconfirmed", "partially_filled", "new"].includes(o.state) &&
    (o.legs || []).some((l) => (l.option || "").includes(optionId) && l.side === "sell")
  );
}

export async function cancelOptionOrder(order) {
  if (!order.cancel) throw new Error(`order ${order.id} not cancellable (state=${order.state})`);
  return rhPost(order.cancel, {});
}

// Sell-to-close a long option as a marketable limit (priced at/under the bid to fill fast).
export async function sellToCloseLimit({ optionId, instrumentUrl, qty, limitPrice, refId }) {
  const body = {
    account: `${RH_BASE}/accounts/${ACCT()}/`,
    direction: "credit",
    legs: [{ position_effect: "close", side: "sell", option: instrumentUrl || `${RH_BASE}/options/instruments/${optionId}/`, ratio_quantity: 1 }],
    price: String(limitPrice),
    type: "limit",
    time_in_force: "gfd",
    trigger: "immediate",
    quantity: String(qty),
    ref_id: refId,
    override_day_trade_checks: true, // a protective CLOSE must never be blocked
    override_dtbp_checks: true,
  };
  return rhPost(`/options/orders/`, body);
}
