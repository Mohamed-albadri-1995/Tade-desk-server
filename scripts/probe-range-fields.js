#!/usr/bin/env node
/*
 * Does TradingView have a weekly high/low? And an all-time LOW?
 *
 * The card shows range bars — month, quarter, year — and a weekly one was
 * asked for. The month/quarter/year columns are already known good; a weekly
 * pair is not, and neither is `Low.All`. Guessing is not an option here,
 * because scan requests go out with `ignore_unknown_fields: true`: a name
 * TradingView does not recognise is silently dropped rather than rejected, so
 * a wrong guess shows up as an empty bar that looks like missing data instead
 * of a typo.
 *
 * So each candidate is probed on its own with `ignore_unknown_fields: false`,
 * which makes TradingView complain about names it does not know. A column that
 * answers here is real; anything else is not.
 *
 *   node scripts/probe-range-fields.js
 *
 * Run it from the server — it needs to reach scanner.tradingview.com.
 */

const axios = require('axios');

const URL = 'https://scanner.tradingview.com/america/scan?label-product=screener-stock';
const HEADERS = {
  'Content-Type': 'application/json',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  Origin: 'https://www.tradingview.com',
  Referer: 'https://www.tradingview.com/',
  Accept: 'application/json',
};

// Grouped so the output answers the two questions separately.
const GROUPS = [
  ['weekly high/low — the one we need', [
    'High.W', 'Low.W', 'High.1W', 'Low.1W', 'high|1W', 'low|1W',
    'High.5D', 'Low.5D', 'High.W|1W', 'Low.W|1W',
  ]],
  ['all-time — is there a low to pair with High.All?', [
    'High.All', 'Low.All', 'price_all_time_high', 'price_all_time_low',
  ]],
  ['already in use — these should all pass, as a sanity check', [
    'High.1M', 'Low.1M', 'High.3M', 'Low.3M',
    'price_52_week_high', 'price_52_week_low',
  ]],
];

// AAPL, so a column that exists but is always null is visible as such.
async function probe(field) {
  const body = {
    columns: ['name', field],
    filter: [{ left: 'name', operation: 'equal', right: 'AAPL' }],
    markets: ['america'],
    options: { lang: 'en' },
    range: [0, 1],
    ignore_unknown_fields: false,
  };
  try {
    const r = await axios.post(URL, body, { headers: HEADERS, timeout: 20000 });
    const row = ((r.data && r.data.data) || [])[0];
    const val = row ? row.d[1] : undefined;
    if (val == null) return { ok: true, empty: true };
    return { ok: true, val };
  } catch (e) {
    const body = e.response && e.response.data;
    return { ok: false, msg: typeof body === 'string' ? body.slice(0, 90)
      : body ? JSON.stringify(body).slice(0, 90) : e.message };
  }
}

(async () => {
  const good = [];
  for (const [title, fields] of GROUPS) {
    console.log(`\n${title}`);
    console.log('─'.repeat(title.length));
    for (const f of fields) {
      const r = await probe(f);
      if (r.ok && !r.empty) { good.push(f); console.log(`  YES  ${f.padEnd(20)} AAPL = ${r.val}`); }
      else if (r.ok)        { console.log(`  ~    ${f.padEnd(20)} column exists but is empty for AAPL`); }
      else                  { console.log(`  no   ${f.padEnd(20)} ${r.msg}`); }
      await new Promise(s => setTimeout(s, 400));
    }
  }
  console.log(`\nUsable: ${good.length ? good.join(', ') : 'none'}`);
  console.log('Paste this whole output back.');
})();
