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

let _token = null;
let _tokenExpiry = 0;

// ── Auth ──────────────────────────────────────────────────────────────────────

async function getToken() {
  if (_token && Date.now() < _tokenExpiry) return _token;

  const resp = await fetch(`${RH_BASE}/oauth2/token/`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": UA },
    body: JSON.stringify({
      username: process.env.ROBINHOOD_USERNAME,
      password: process.env.ROBINHOOD_PASSWORD,
      grant_type: "password",
      client_id: CLIENT_ID,
      expires_in: 86400,
      scope: "internal",
      device_token: DEVICE_TOKEN,
    }),
  });

  const data = await resp.json();

  if (data.mfa_required) {
    throw new Error(
      "Robinhood requires MFA but no ROBINHOOD_MFA_SECRET is configured. " +
      "Enable MFA support or disable MFA on your Robinhood account."
    );
  }

  if (!data.access_token) {
    throw new Error(`Robinhood auth failed: ${JSON.stringify(data)}`);
  }

  _token = data.access_token;
  // Expire 5 minutes early to be safe
  _tokenExpiry = Date.now() + (data.expires_in - 300) * 1000;
  return _token;
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────

async function rhGet(url) {
  const token = await getToken();
  const fullUrl = url.startsWith("http") ? url : `${RH_BASE}${url}`;
  const resp = await fetch(fullUrl, {
    headers: { Authorization: `Bearer ${token}`, "User-Agent": UA },
  });
  if (!resp.ok) {
    throw new Error(`Robinhood API error ${resp.status} on ${fullUrl}`);
  }
  return resp.json();
}

// Paginate through all results if Robinhood paginates
async function rhGetAll(url) {
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

          const avg_cost = parseFloat(pos.average_price || 0);
          const current_price = parseFloat(
            quote.adjusted_mark_price || quote.mark_price || 0
          );
          const qty = parseFloat(pos.quantity || 0);
          const pnl_pct =
            avg_cost > 0
              ? Math.round(((current_price - avg_cost) / avg_cost) * 1000) / 10
              : 0;

          return {
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
