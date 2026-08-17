const db = require('../db');
const { toETTime, toETIso } = require('../utils/time');

const BASE = 'https://data.alpaca.markets/v2/stocks';

function getAccountBaseUrl() {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'alpacaAccountUrl'").get();
  const raw = row?.value || '';
  // Default to paper trading so live money isn't accidentally queried.
  return raw.trim() || 'https://paper-api.alpaca.markets';
}

function getCredentials() {
  // Primary: an enabled Alpaca broker profile. This is the modern path
  // and the one the UI now steers users toward, so it wins when it
  // exists — otherwise a stale settings-based key silently kept
  // shadowing the fresh broker-profile one and producing 401s.
  const profile = db.prepare(`
    SELECT config FROM trading_brokers
     WHERE type = 'alpaca' AND enabled = 1
     ORDER BY is_default DESC, created_at ASC
     LIMIT 1
  `).get();
  if (profile) {
    let cfg = {};
    try { cfg = JSON.parse(profile.config || '{}'); } catch { /* ignore */ }
    if (cfg.key && cfg.secret) {
      return { key: cfg.key, secret: cfg.secret };
    }
  }
  // Legacy fallback: settings-based creds.
  const rows = db.prepare("SELECT key, value FROM settings WHERE key IN ('alpacaApiKey','alpacaApiSecret')").all();
  const creds = {};
  for (const r of rows) creds[r.key] = r.value;
  if (creds.alpacaApiKey && creds.alpacaApiSecret) {
    return { key: creds.alpacaApiKey, secret: creds.alpacaApiSecret };
  }
  throw new Error('Alpaca credentials not set — configure an Alpaca broker profile, or add them in Settings > API Keys');
}

function authHeaders() {
  const { key, secret } = getCredentials();
  return {
    'APCA-API-KEY-ID': key,
    'APCA-API-SECRET-KEY': secret,
    'Content-Type': 'application/json',
  };
}

/**
 * Which market-data feed to request. Same precedence as getCredentials:
 * active Alpaca broker profile's `feed` field, then legacy setting,
 * then default 'iex' (the free tier that works without a subscription).
 */
function getFeed() {
  const profile = db.prepare(`
    SELECT config FROM trading_brokers
     WHERE type = 'alpaca' AND enabled = 1
     ORDER BY is_default DESC, created_at ASC
     LIMIT 1
  `).get();
  if (profile) {
    let cfg = {};
    try { cfg = JSON.parse(profile.config || '{}'); } catch { /* ignore */ }
    if (cfg.feed) return String(cfg.feed).toLowerCase();
  }
  const row = db.prepare("SELECT value FROM settings WHERE key = 'alpacaMarketFeed'").get();
  return String(row?.value || 'iex').toLowerCase();
}

// Fetch all pages for a bars request, returns { TICKER: [{t,o,h,l,c,v}] }
async function fetchAllPages(url, params) {
  const result = {};
  let pageToken = null;

  do {
    const qs = new URLSearchParams(params);
    if (pageToken) qs.set('page_token', pageToken);
    const res = await fetch(`${url}?${qs}`, { headers: authHeaders() });
    if (!res.ok) {
      const body = await res.text();
      // Common failure modes get plain-language hints. Everything else
      // falls through with the raw body attached for debugging.
      let hint = '';
      if (res.status === 401)      hint = ' — credentials rejected. Check the Alpaca broker profile (Brokers tab) has a valid paper API key + secret.';
      else if (res.status === 402) hint = ' — subscription required. SIP feed needs a paid Alpaca subscription; switch to IEX in Trading Settings.';
      else if (res.status === 403) hint = ' — forbidden. The key may lack market-data access for the requested feed.';
      throw new Error(`Alpaca API error ${res.status}${hint}\n${body}`);
    }
    const data = await res.json();
    for (const [ticker, bars] of Object.entries(data.bars || {})) {
      if (!result[ticker]) result[ticker] = [];
      result[ticker].push(...bars);
    }
    pageToken = data.next_page_token || null;
  } while (pageToken);

  return result;
}

// Fetch 1-min intraday bars for date (ET date string e.g. '2024-01-15')
// Returns { TICKER: [{t, o, h, l, c, v, etTime}] } where etTime is 'HH:MM'
async function fetchIntradayBars(tickers, date) {
  const raw = await fetchAllPages(`${BASE}/bars`, {
    symbols: tickers.join(','),
    timeframe: '1Min',
    start: toETIso(date, '09:30'),
    end:   toETIso(date, '16:00'),
    limit: 10000,
    adjustment: 'raw',
    feed: getFeed(),
  });

  // Annotate each bar with its ET time string for easy lookup
  const out = {};
  for (const [ticker, bars] of Object.entries(raw)) {
    out[ticker] = bars.map(b => ({
      ...b,
      etTime: toETTime(new Date(b.t).getTime()),
    }));
  }
  return out;
}

// Fetch daily bars for tickers, strictly before beforeDate (ET date string)
// Returns { TICKER: [{t, o, h, l, c}] } — up to 20 calendar days back (guarantees 14+ trading days)
async function fetchDailyBars(tickers, beforeDate) {
  // Go back 30 calendar days to be safe across holidays
  const endDate = new Date(`${beforeDate}T00:00:00-05:00`);
  endDate.setDate(endDate.getDate() - 1); // day before
  const startDate = new Date(endDate);
  startDate.setDate(startDate.getDate() - 29);

  const fmt = d => d.toISOString().slice(0, 10);

  return fetchAllPages(`${BASE}/bars`, {
    symbols: tickers.join(','),
    timeframe: '1Day',
    start: fmt(startDate),
    end: fmt(endDate),
    limit: 1000,
    adjustment: 'raw',
    feed: getFeed(),
  });
}

// Compute ATR14 from an array of daily bars (at least 15 bars needed for 14 TRs)
function computeATR14(bars) {
  if (!bars || bars.length < 2) return null;
  const trs = [];
  for (let i = 1; i < bars.length; i++) {
    const cur = bars[i];
    const prev = bars[i - 1];
    const tr = Math.max(
      cur.h - cur.l,
      Math.abs(cur.h - prev.c),
      Math.abs(cur.l - prev.c)
    );
    trs.push(tr);
  }
  // Take the last 14 TRs
  const last14 = trs.slice(-14);
  if (last14.length < 14) return null;
  return last14.reduce((a, b) => a + b, 0) / 14;
}

/**
 * Fetch account snapshot from Alpaca (used to source live equity for
 * sizing calculations, per the trading plan).
 *
 * Returns the raw Alpaca account object, or throws if credentials or the
 * request fail. Callers are expected to cache — this is a network call.
 */
async function fetchAccount() {
  const url = `${getAccountBaseUrl()}/v2/account`;
  const res = await fetch(url, { headers: authHeaders() });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Alpaca account fetch ${res.status}: ${body.slice(0, 200)}`);
  }
  return res.json();
}

/**
 * Convenience wrapper — returns just the equity as a number, or null
 * if the call fails or the field is missing.
 */
async function fetchAccountEquity() {
  try {
    const acct = await fetchAccount();
    const eq = parseFloat(acct?.equity);
    return Number.isFinite(eq) ? eq : null;
  } catch (err) {
    return null;
  }
}

/*
 * CAN THIS BE SOLD SHORT?
 *
 * Alpaca refuses a short in the most expensive possible way: the order is
 * accepted by the bridge, POSTed, and comes back later as an email —
 *
 *     From Alpaca: asset "STKH" cannot be sold short
 *
 * By then the alert has been marked sent, the position does not exist, and the
 * only record is in an inbox. Most of what these screeners find is a small cap
 * that is not easy to borrow, so this is the normal case for shorts and not an
 * edge one.
 *
 * `shortable` is whether the broker will take the order at all; `easy_to_borrow`
 * is whether there is inventory without a locate. Both are reported: refusing on
 * `shortable` alone is the honest line, and the second is worth saying out loud.
 *
 * Cached for the session: a symbol's borrow status does not change inside a
 * morning, and this sits in the path of a market order at a fixed minute.
 */
const _assetCache = new Map();

async function fetchAsset(symbol) {
  const sym = String(symbol || '').trim().toUpperCase();
  if (!sym) return null;
  const hit = _assetCache.get(sym);
  if (hit && Date.now() - hit.at < 6 * 60 * 60 * 1000) return hit.asset;
  const url = `${getAccountBaseUrl()}/v2/assets/${encodeURIComponent(sym)}`;
  const res = await fetch(url, { headers: authHeaders() });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Alpaca asset ${sym} ${res.status}: ${body.slice(0, 200)}`);
  }
  const asset = await res.json();
  _assetCache.set(sym, { at: Date.now(), asset });
  return asset;
}

/**
 * `{ ok, shortable, easyToBorrow, reason }` — or `{ ok: true, checked: false }`
 * when the question could not be asked.
 *
 * A check that cannot run must NOT block the order. No credentials, a network
 * blip or a symbol Alpaca does not list would otherwise silently stop every
 * short on the box, which is a far worse failure than the emails this exists to
 * prevent. Unknown means send it and let the broker answer.
 */
async function checkShortable(symbol) {
  try {
    const a = await fetchAsset(symbol);
    if (!a) return { ok: true, checked: false, reason: 'no answer from Alpaca' };
    const shortable = a.shortable === true;
    return {
      ok: shortable,
      checked: true,
      shortable,
      easyToBorrow: a.easy_to_borrow === true,
      reason: shortable ? null
        : `Alpaca will not short ${String(symbol).toUpperCase()} — the asset is not shortable`,
    };
  } catch (err) {
    return { ok: true, checked: false, reason: err.message };
  }
}

module.exports = {
  fetchIntradayBars,
  fetchAsset,
  checkShortable,
  fetchDailyBars,
  computeATR14,
  fetchAccount,
  fetchAccountEquity,
  getAccountBaseUrl,
  // Exported because a caller computing VWAP has to know which feed produced
  // the volume. IEX is a few percent of the consolidated tape, so a VWAP built
  // from it is not the VWAP anyone else is looking at — and in the T2 setup the
  // VWAP is the stop, so that is a difference with money on it.
  getFeed,
};
