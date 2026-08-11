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
  ['short float — why is Short % always a dash?', [
    'short_percentage_of_float', 'short_interest', 'shares_short',
    'short_ratio', 'days_to_cover', 'float_shares_percent_current_shares_outstanding',
    'short_percentage_of_shares_outstanding',
  ]],
  ['already in use — these should all pass, as a sanity check', [
    'High.1M', 'Low.1M', 'High.3M', 'Low.3M',
    'price_52_week_high', 'price_52_week_low',
  ]],
];

// Short float is the one field where "the column exists" is not the answer.
// TradingView may know the name and still have nothing in it for most US
// tickers, in which case the dash is correct and no amount of renaming fixes
// it. So the short-float names get sampled across several stocks rather than
// one, and the output says how many of them actually carried a value.
const SHORT_SAMPLE = ['AAPL', 'TSLA', 'GME', 'AMC', 'F', 'PLUG', 'RIOT'];

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

// How many of SHORT_SAMPLE actually carry a value for this column.
async function coverage(field) {
  const body = {
    columns: ['name', field],
    filter: [{ left: 'name', operation: 'in_range', right: SHORT_SAMPLE }],
    markets: ['america'],
    options: { lang: 'en' },
    range: [0, SHORT_SAMPLE.length],
    ignore_unknown_fields: false,
  };
  try {
    const r = await axios.post(URL, body, { headers: HEADERS, timeout: 20000 });
    const rows = (r.data && r.data.data) || [];
    const hits = rows.filter(x => x.d[1] != null);
    return { n: rows.length, hits: hits.length,
      example: hits[0] ? `${hits[0].d[0]}=${hits[0].d[1]}` : null };
  } catch {
    return null;
  }
}

(async () => {
  const good = [];
  for (const [title, fields] of GROUPS) {
    console.log(`\n${title}`);
    console.log('─'.repeat(title.length));
    const isShort = /short float/.test(title);
    for (const f of fields) {
      const r = await probe(f);
      const pad = f.padEnd(48);
      if (r.ok && !r.empty)      { good.push(f); console.log(`  YES  ${pad} AAPL = ${r.val}`); }
      else if (r.ok)             { console.log(`  ~    ${pad} column exists, empty for AAPL`); }
      else                       { console.log(`  no   ${pad} ${r.msg}`); }

      // For a column that exists at all, how widely is it populated? An empty
      // column and a missing column look the same on the card and need
      // opposite fixes.
      if (isShort && r.ok) {
        await new Promise(s => setTimeout(s, 400));
        const c = await coverage(f);
        if (c) console.log(`       └─ ${c.hits}/${c.n} of ${SHORT_SAMPLE.join(',')} have a value` +
          (c.example ? `  e.g. ${c.example}` : ''));
      }
      await new Promise(s => setTimeout(s, 400));
    }
  }
  console.log(`\nUsable: ${good.length ? good.join(', ') : 'none'}`);
  console.log('Paste this whole output back.');
})();
