#!/usr/bin/env node
/*
 * Check that every column the builder offers is a column TradingView actually
 * knows about.
 *
 * This matters more than it looks. Scan requests are sent with
 * `ignore_unknown_fields: true`, so a misspelled column is not rejected — the
 * filter is silently dropped and the screener quietly returns a wider set than
 * it claims to. A CANSLIM screener missing its earnings filter would return
 * every stock at a 52-week high and look like it was working.
 *
 * So each field is probed on its own with `ignore_unknown_fields: false`, which
 * makes TradingView complain about names it does not recognise.
 *
 *   node scripts/verify-tv-fields.js            every field
 *   node scripts/verify-tv-fields.js --new      only the fundamentals
 */

const axios = require('axios');
const { FIELDS } = require('../src/sideA/screenerStore');

const URL = 'https://scanner.tradingview.com/america/scan?label-product=screener-stock';
const HEADERS = {
  'Content-Type': 'application/json',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  Origin: 'https://www.tradingview.com',
  Referer: 'https://www.tradingview.com/',
  Accept: 'application/json',
};

// Names that only exist as fundamentals — the ones worth checking after a
// change, since the technical columns have been in use for months.
const NEW_ONLY = /^(earnings_per_share|total_revenue|return_on_equity|total_shares_outstanding|Perf\.(3M|6M|Y))/;

async function probe(field) {
  const body = {
    columns: ['name', field],
    filter: [{ left: field, operation: 'egreater', right: -1e12 }],
    markets: ['america'],
    options: { lang: 'en' },
    range: [0, 3],
    ignore_unknown_fields: false,
  };
  try {
    const r = await axios.post(URL, body, { headers: HEADERS, timeout: 20000 });
    const rows = r.data.data || [];
    const sample = rows.find(x => x.d && x.d[1] !== null);
    return {
      ok: true,
      matched: r.data.totalCount ?? rows.length,
      sample: sample ? `${sample.d[0]}=${sample.d[1]}` : 'no non-null values',
    };
  } catch (err) {
    const detail = err.response?.data;
    return {
      ok: false,
      error: typeof detail === 'string' ? detail.slice(0, 120)
        : detail ? JSON.stringify(detail).slice(0, 120)
        : err.message,
    };
  }
}

(async () => {
  const only = process.argv.includes('--new');
  const fields = FIELDS.map(f => f.value).filter(v => (only ? NEW_ONLY.test(v) : true));
  console.log(`Checking ${fields.length} field(s) against TradingView\n`);

  const bad = [];
  for (const f of fields) {
    const r = await probe(f);
    if (r.ok) {
      console.log(`  OK    ${f.padEnd(48)} ${r.matched} match(es), ${r.sample}`);
    } else {
      console.log(`  FAIL  ${f.padEnd(48)} ${r.error}`);
      bad.push(f);
    }
    await new Promise(res => setTimeout(res, 250));   // be polite
  }

  console.log('');
  if (bad.length) {
    console.log(`${bad.length} field(s) TradingView did not accept:`);
    bad.forEach(f => console.log(`  ${f}`));
    console.log('\nAny screener using these is running WITHOUT that filter.');
    process.exit(1);
  }
  console.log('All fields accepted.');
})();
