#!/usr/bin/env node
/*
 * WHAT IS TRADINGVIEW ACTUALLY RETURNING FOR THIS COLUMN, RIGHT NOW.
 *
 * why-empty names the filter that empties a screener; try-filter measures what
 * would open it up. Neither answers the question the trader asked about
 * `relative_volume_10d_calc > 10`:
 *
 *     "considering the complete market the 10x is not rare"
 *
 * And he is right. Across the whole US market a handful of names trade at ten
 * times their average volume most days — gappers, earnings reactions, news.
 * A rule that matches ZERO is therefore two completely different findings:
 *
 *     the market is quiet        the values are real and today's top is 3.2
 *     the FIELD changed          TradingView renamed it, rescaled it (a ratio
 *                                that became a percentage), started returning
 *                                null, or narrowed what it is computed over
 *
 * A count cannot tell those apart — both are "0". The VALUES can, so this asks
 * for them: the universe sorted by the column, highest first, printed as
 * numbers. If the top of the market is 4.1 then `> 10` is honestly rare today.
 * If every row is null, the column is gone and no threshold will ever match.
 *
 * IT CHANGES NOTHING. It reads the screener's floor from the tool's database
 * and asks TradingView one question.
 *
 *   node scripts/field-values.js relative_volume_10d_calc
 *   node scripts/field-values.js relative_volume_10d_calc bigmoves
 *   DB_PATH=data/t10.db node scripts/field-values.js price_52_week_high canslim
 *
 * With a screener key, the screener's OWN filters are applied except any that
 * mention the column — so you see the values among the stocks it would
 * otherwise be choosing from, which is the population the threshold acts on.
 */

const path = require('path');

process.env.DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'tradedesk.db');

const store = require('../src/sideA/screenerStore');
const { testScreener, COMMON_COLUMNS } = require('../src/sideA/tvScanner');

const TOP = 25;

/*
 * READ BY COLUMN POSITION FROM THE RAW RESPONSE, never from the mapped row.
 *
 * mapTVRow INTERPRETS, and interpretation is what a diagnostic must not
 * inherit. Its `stock.rvol` is a BLEND — `intraday > 0 ? intraday : tenDay` —
 * so if relative_volume_10d_calc went empty, every mapped row would still
 * carry a healthy rvol from the intraday column and this script would report
 * a field that works. Asked "is TradingView still returning THIS field", the
 * mapped row answers about a different one.
 */
function valueOf(raw, column) {
  const i = COMMON_COLUMNS.indexOf(column);
  const d = (raw && raw.d) || [];
  // Shorter than the columns asked for means the response itself is off, and
  // reading by position would then report another column's number under this
  // one's name — the exact silent mistake tvScanner's own alignment check
  // exists to stop.
  if (d.length !== COMMON_COLUMNS.length) return { misaligned: true, value: null };
  return { misaligned: false, value: d[i] };
}

function main() {
  const [column, key] = process.argv.slice(2);
  if (!column) {
    console.error('Usage: node scripts/field-values.js <column> [screener-key]');
    console.error('\nColumns this scanner asks TradingView for:');
    for (const c of COMMON_COLUMNS) console.error(`  ${c}`);
    process.exit(1);
  }
  /*
   * A COLUMN THE SCANNER DOES NOT REQUEST comes back as nothing, and printing
   * a page of nulls for it would look exactly like a field TradingView had
   * withdrawn. Refused with the reason instead.
   */
  if (!COMMON_COLUMNS.includes(column)) {
    console.error(`'${column}' is not one of the columns this scanner requests, so `
      + 'TradingView is never asked for it and every value would print as null.');
    console.error('Add it to COMMON_COLUMNS in src/sideA/tvScanner.js first, or pick '
      + 'one of:\n  ' + COMMON_COLUMNS.join('\n  '));
    process.exit(1);
  }

  let screener = null;
  if (key) {
    screener = store.list().find(s => s.key === key);
    if (!screener) {
      console.error(`No screener with key '${key}' in ${process.env.DB_PATH}.`);
      console.error('Screeners here: ' + store.list().map(s => s.key).join(', '));
      process.exit(1);
    }
  }

  /*
   * EVERY RULE EXCEPT THE ONES ABOUT THIS COLUMN. Keeping the column's own
   * filter would ask "what are the values above 10" and be answered "nothing",
   * which is the question already known to return nothing.
   */
  const all = screener ? (screener.filters || []) : [];
  const kept = all.filter(f => f.left !== column && f.right !== column);
  return { column, screener, kept, dropped: all.length - kept.length };
}

async function run({ column, screener, kept, dropped }) {
  console.log(`\n${column}   ${process.env.DB_PATH}`);
  console.log(screener
    ? `Among the stocks "${screener.name}" would be choosing from`
      + (dropped ? ` — its ${dropped} rule(s) on this column dropped, so these are `
        + 'the values the threshold acts on' : '')
    : 'Across the tradable universe (the floor only)');

  const r = await testScreener({
    name: `values:${column}`,
    filters: kept,
    sort: { sortBy: column, sortOrder: 'desc' },
    limit: TOP,
  });

  const raw = r.rawRows || [];
  console.log(`\n${r.totalCount} stock(s) in that population. `
    + `Highest ${Math.min(TOP, raw.length)} by ${column}:\n`);

  if (!raw.length) {
    console.log('  TradingView returned no rows at all — the POPULATION is empty, '
      + 'so this says nothing about the column. Widen it or drop the screener key.');
    return;
  }

  const nums = [];
  let misaligned = 0;
  for (const row of raw) {
    const sym = String(row.s || '').split(':').pop();
    const { misaligned: bad, value } = valueOf(row, column);
    if (bad) { misaligned += 1; console.log(`  ${sym.padEnd(8)} —  response misaligned`); continue; }
    if (typeof value === 'number' && !Number.isNaN(value)) nums.push(value);
    console.log(`  ${sym.padEnd(8)} ${value === null || value === undefined
      ? 'null   (asked for, returned empty)' : value}`);
  }

  /*
   * THE VERDICT, and it will not call a quiet market a broken field or the
   * other way round. From a COUNT both are "0 matched".
   */
  console.log('');
  if (misaligned) {
    console.log(`VERDICT: ${misaligned} row(s) came back with the wrong number of `
      + 'columns, so nothing here can be read by position. That is the RESPONSE '
      + 'SHAPE, not the market — fix COMMON_COLUMNS before judging any rule.');
    return;
  }
  if (!nums.length) {
    console.log(`VERDICT: not one row carried a number for ${column}. That is the `
      + 'FIELD, not the market — no threshold on it can ever match, and every '
      + 'screener using it is silently empty.');
    console.log('  Check the name against TradingView\'s current schema before '
      + 'touching a single rule.');
    return;
  }
  const top = Math.max(...nums);
  console.log(`VERDICT: the column is live — the highest in this population right `
    + `now is ${top}.`);
  console.log(`  So a threshold above ${top} is honestly rare AT THIS MOMENT rather `
    + 'than broken. How many a lower one would admit is what try-filter.js measures.');
  console.log('  ONE READING IS ONE MOMENT. Relative volume especially runs far '
    + 'higher near the open than at midday, so a rule read at 11:30 says little '
    + 'about the same rule at 09:36 — take this again at the hour the screener is '
    + 'meant to fire before changing it.');
}

if (require.main === module) {
  Promise.resolve(main())
    .then(run)
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('Failed:', err.stack || err.message);
      process.exit(1);
    });
}

module.exports = { valueOf, TOP };
