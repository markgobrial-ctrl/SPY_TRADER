/**
 * rhApi.js — Direct Robinhood REST API client (no MCP, no 2FA)
 * Credentials come from env vars: ROBINHOOD_USERNAME, ROBINHOOD_PASSWORD
 * Token is cached in memory and refreshed when it expires.
 */

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

// ── Helpers ───────────────────────────────────────────────────────────────────

function fetchWithTimeout(url, opts = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  return fetch(url, { ...opts, signal: ctrl.signal }).finally(() => clearTimeout(timer));
}

// ── Auth ──────────────────────────────────────────────────────────────────────

// In-memory refresh token (seeded from env var, updated after each refresh)
let _refreshToken = process.env.ROBINHOOD_REFRESH_TOKEN || null;

export async function getRHToken() { return getToken(); }

async function getToken() {
  if (_token && Date.now() < _tokenExpiry) return _token;

  // 1. Try refresh token (long-lived, set once, never expires manually)
  if (_refreshToken) {
    return refreshAccessToken();
  }

  // 2. Fall back to pre-set access token from env (first boot before refresh kicks in)
  if (process.env.ROBINHOOD_TOKEN) {
    _token = process.env.ROBINHOOD_TOKEN;
    _tokenExpiry = Date.now() + 23 * 60 * 60 * 1000;
    return _token;
  }

  throw new Error(
    "No Robinhood credentials found. Run get-rh-token.mjs locally and set " +
    "ROBINHOOD_TOKEN and ROBINHOOD_REFRESH_TOKEN on Render."
  );
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
  // Update in-memory refresh token if Robinhood rotated it
  if (data.refresh_token) _refreshToken = data.refresh_token;
  return _token;
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────

export async function rhGet(url) {
  const token = await getToken();
  const fullUrl = url.startsWith("http") ? url : `${RH_BASE}${url}`;
  const resp = await fetchWithTimeout(fullUrl, {
    headers: { Authorization: `Bearer ${token}`, "User-Agent": UA },
  });
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
  // 1. Portfolio (buying power + total equity)
  const portfolioData = await rhGet("/portfolios/");
  const p = portfolioData.results?.[0] || {};
  const buying_power = parseFloat(p.withdrawable_amount || 0);
  const portfolio_value = parseFloat(
    p.extended_hours_equity || p.equity || p.market_value || 0
  );

  // 2. Open option positions (quantity > 0)
  const rawPositions = await rhGetAll("/options/positions/?nonzero=true");

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
