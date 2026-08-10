#!/usr/bin/env node
/*
 * Is short interest available anywhere we can already reach?
 *
 * TradingView's scanner is settled: seven column names were probed against
 * seven stocks — including GME and AMC, where short interest is the entire
 * story — and every one came back empty. The names are accepted, the data is
 * not served. So the dash on the card was never a bug in the mapping, and no
 * amount of renaming the column fixes it.
 *
 * That leaves the other source this tool already has a key for. Finnhub serves
 * short interest, but on paid plans; a free key returns 401 or 403 on those
 * endpoints. Which one applies depends on the key, so it is checked rather than
 * guessed:
 *
 *   node scripts/probe-short-interest.js
 *
 * Reads the same key the news pipeline uses — settings.finnhubApiKey, or
 * FINNHUB_API_KEY from the environment.
 */

const axios = require('axios');

function apiKey() {
  try {
    const db = require('../src/db');
    const row = db.prepare("SELECT value FROM settings WHERE key = 'finnhubApiKey'").get();
    if (row && row.value) return row.value;
  } catch { /* fall through to the environment */ }
  return process.env.FINNHUB_API_KEY || '';
}

const TICKERS = ['GME', 'AMC', 'AAPL'];

async function tryEndpoint(name, url, pick) {
  try {
    const r = await axios.get(url, { timeout: 15000 });
    const val = pick(r.data);
    if (val == null) return { name, status: 'empty', note: 'answered, no short-interest field' };
    return { name, status: 'ok', val };
  } catch (e) {
    const code = e.response ? e.response.status : null;
    return {
      name,
      status: code === 401 || code === 403 ? 'paid' : 'error',
      note: code ? `HTTP ${code}` : e.message,
    };
  }
}

(async () => {
  const key = apiKey();
  if (!key) {
    console.log('No Finnhub key found (settings.finnhubApiKey / FINNHUB_API_KEY).');
    console.log('That is the answer for now: no key, no short interest.');
    return;
  }
  console.log(`Using a Finnhub key ending ...${key.slice(-4)}\n`);

  for (const t of TICKERS) {
    console.log(t);
    console.log('─'.repeat(t.length));
    const results = [
      await tryEndpoint('basic financials (metric=all)',
        `https://finnhub.io/api/v1/stock/metric?symbol=${t}&metric=all&token=${key}`,
        d => {
          const m = (d && d.metric) || {};
          const hit = Object.keys(m).find(k => /short/i.test(k));
          return hit ? `${hit} = ${m[hit]}` : null;
        }),
      await tryEndpoint('short interest (premium)',
        `https://finnhub.io/api/v1/stock/short-interest?symbol=${t}&token=${key}`,
        d => (d && d.data && d.data[0]) ? JSON.stringify(d.data[0]).slice(0, 120) : null),
    ];
    for (const r of results) {
      const label = r.name.padEnd(32);
      if (r.status === 'ok')        console.log(`  YES   ${label} ${r.val}`);
      else if (r.status === 'paid') console.log(`  PAID  ${label} ${r.note} — not on this plan`);
      else if (r.status === 'empty')console.log(`  ~     ${label} ${r.note}`);
      else                          console.log(`  no    ${label} ${r.note}`);
    }
    console.log('');
    await new Promise(s => setTimeout(s, 1200));   // free tier is rate limited
  }
  console.log('Paste this output back. If everything says PAID, short interest');
  console.log('is not reachable from here and the card should stop pretending.');
})();
