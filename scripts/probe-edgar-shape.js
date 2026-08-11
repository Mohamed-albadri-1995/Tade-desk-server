#!/usr/bin/env node
/*
 * What does EDGAR's full-text search actually send back?
 *
 * The first run after the request was fixed produced five rows all reading
 * "SEC Filing", dated 1159 and 1162 days ago. Both halves of that are the same
 * problem: the code reads `_source.form_type` and `_source.period_of_report`,
 * and when the first is absent it prints a placeholder while the second yields
 * a date from three years back. Either the field names are different from what
 * was assumed, or the search ignores the date range — and guessing between
 * those two is how the placeholder got written in the first place.
 *
 * This prints the raw shape of one hit, every field name on it, and how the
 * mapper currently reads it. No parsing, no assumptions.
 *
 *   node scripts/probe-edgar-shape.js         # defaults to AAPL
 *   node scripts/probe-edgar-shape.js CELH
 *
 * Run it from the server — the SEC refuses requests this sandbox can make.
 */

const axios = require('axios');

const TICKER = (process.argv[2] || 'AAPL').toUpperCase();
const DAYS = 14;
const ymd = (ms) => new Date(ms).toISOString().slice(0, 10);
const now = Date.now();

const HEADERS = {
  'User-Agent': process.env.SEC_USER_AGENT || 'TradeDesk Screener admin@trade-desk.local',
  'Accept-Encoding': 'gzip, deflate',
  Accept: 'application/json',
};

const QUERIES = [
  ['with a date range',
   `https://efts.sec.gov/LATEST/search-index?q=%22${TICKER}%22&forms=8-K,S-3` +
   `&dateRange=custom&startdt=${ymd(now - DAYS * 86400000)}&enddt=${ymd(now)}`],
  ['without one (what was being sent before)',
   `https://efts.sec.gov/LATEST/search-index?q=%22${TICKER}%22&forms=8-K,S-3`],
];

(async () => {
  for (const [label, url] of QUERIES) {
    console.log(`\n${label}`);
    console.log('─'.repeat(label.length));
    try {
      const r = await axios.get(url, { headers: HEADERS, timeout: 15000 });
      const hits = (r.data && r.data.hits && r.data.hits.hits) || [];
      const total = r.data && r.data.hits && r.data.hits.total;
      console.log(`  ${hits.length} hits returned, total reported: ${JSON.stringify(total)}`);
      if (!hits.length) { console.log('  (nothing to inspect)'); continue; }

      const s = hits[0]._source || {};
      console.log(`  _source field names: ${Object.keys(s).join(', ')}`);
      console.log(`  first hit, raw:\n    ${JSON.stringify(hits[0]).slice(0, 400)}`);

      // Which candidate names actually carry something, across all hits
      const FORM = ['form_type', 'form', 'root_form', 'type', 'file_type'];
      const DATE = ['file_date', 'filed_at', 'period_ending', 'period_of_report', 'file_datetime'];
      const present = (names) => names.filter(n => hits.some(h => (h._source || {})[n] != null));
      console.log(`  form fields present: ${present(FORM).join(', ') || 'NONE'}`);
      console.log(`  date fields present: ${present(DATE).join(', ') || 'NONE'}`);

      console.log('  dates on each hit, and how old:');
      for (const h of hits.slice(0, 5)) {
        const src = h._source || {};
        const parts = DATE.filter(n => src[n] != null).map(n => `${n}=${src[n]}`);
        const best = DATE.map(n => src[n]).find(Boolean);
        const age = best ? Math.round((now - Date.parse(best)) / 86400000) : null;
        console.log(`    ${(DATE.map(n => src[n]).find(Boolean) || '?').toString().slice(0, 10)}  ` +
          `${age == null ? 'age unknown' : age + 'd old'}  ${parts.join(' ') || '(no date field)'}`);
      }
    } catch (e) {
      const code = e.response && e.response.status;
      console.log(code ? `  HTTP ${code}` : `  ${e.code || e.message}`);
    }
    await new Promise(s => setTimeout(s, 800));
  }
  console.log('\nPaste this whole output back.');
})();
