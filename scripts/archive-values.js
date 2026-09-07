#!/usr/bin/env node
/*
 * WHAT WERE THE STOCKS THAT ACTUALLY MATCHED READING, ON THE DAYS THEY DID.
 *
 * field-values.js answers "is TradingView still returning this column" — and
 * for `relative_volume_10d_calc` on 2026-09-08 the answer was yes: LULU 6.41,
 * IOT 4.17, PL 3.92, real ratios, nothing rescaled or nulled. So the field is
 * live and `> 10` matched nothing because the market's top was 6.41.
 *
 * That still leaves the trader's question half-answered:
 *
 *     "make sure it's really not having candidates because maybe tradingview
 *      changed something so we need to adopt"
 *
 * One quiet lunchtime proves nothing about a threshold. What does is the
 * desk's OWN archive: this tool froze a register every trading day, each row
 * carrying the screeners that matched it and the numbers it carried at the
 * moment of capture. If the names that matched Big Move were reading 15, 22,
 * 30 — the rule works and today is simply quiet. If they were reading 3 and 4,
 * the rule as written could never have produced them, and something upstream
 * changed while the counts went on looking like a slow market.
 *
 * READ THE CAVEAT BELOW BEFORE TRUSTING A NUMBER FROM THIS. It is loud on
 * purpose: the stored field is not always the field the filter used.
 *
 *   node scripts/archive-values.js "Big Move"
 *   node scripts/archive-values.js "Big Move" stock.rvol 20
 *   DB_PATH=data/t10.db node scripts/archive-values.js "CANSLIM"
 *
 * IT CHANGES NOTHING — one SELECT, no writes.
 */

const path = require('path');

process.env.DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'tradedesk.db');

const db = require('../src/db');

const DEFAULT_FIELD = 'stock.rvol';
const DEFAULT_DAYS = 15;

/*
 * WHICH STORED FIELDS ARE NOT THE FIELD A FILTER USED.
 *
 * `stock.rvol` is a BLEND — mapTVRow takes `relative_volume_intraday|5` when
 * it is above zero and `relative_volume_10d_calc` otherwise. At a 09:36
 * capture the intraday column is populated, so the archived number is almost
 * certainly the INTRADAY ratio, NOT the ten-day one Big Move filters on.
 *
 * It is still evidence — a stock reading 20 was doing extraordinary volume
 * however the ratio was computed — but it is not the filter's own number, and
 * printing it as though it were is the kind of quiet substitution this desk
 * keeps being bitten by. So it is said on every run, not buried here.
 */
const NOT_THE_FILTERS_NUMBER = {
  'stock.rvol': 'stock.rvol is a BLEND: the scanner stores relative_volume_intraday|5 '
    + 'when it is above zero and relative_volume_10d_calc otherwise. At a morning '
    + 'capture the intraday column is populated, so this is probably the INTRADAY '
    + 'ratio — not the ten-day column a rule like "relative_volume_10d_calc > 10" '
    + 'is tested against. Read it as "how unusual was this stock\'s volume", not as '
    + 'the filter\'s own number.',
};

/** Dotted path into the stored row. */
function pluck(obj, dotted) {
  return String(dotted).split('.').reduce((o, k) => (o == null ? o : o[k]), obj);
}

/**
 * Every archived row this screener matched, newest day first.
 *
 * MATCHED BY THE SAME RULE THE REST OF THE DESK USES: screenerKeys carries the
 * screener's DISPLAY NAME (see src/sideA/merge.js), and older rows may carry
 * the key, so both are accepted. A `LIKE '%CANSLIM%'` would also match every
 * "CANSLIM Pullback" row — one screener's history counted as another's.
 */
function matches(want, field) {
  const out = [];
  for (const row of db.prepare('SELECT date, ticker, data FROM r1_frozen').all()) {
    let parsed;
    try { parsed = JSON.parse(row.data); } catch { continue; }
    const keys = (parsed || {}).screenerKeys;
    if (!Array.isArray(keys) || !keys.some(k => want.includes(k))) continue;
    out.push({ date: row.date, ticker: row.ticker, value: pluck(parsed, field) });
  }
  return out.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
}

/*
 * THE SUMMARY, over the rows that actually carried a number.
 *
 * A row with no value is COUNTED SEPARATELY rather than skipped silently: "12
 * of 96 rows have no reading for this field" is itself a finding — it can mean
 * the column was added after those rows were captured, and a median taken over
 * the rest without saying so is a statistic about a different population.
 */
function summarise(rows) {
  const nums = rows.map(r => r.value).filter(v => typeof v === 'number' && !Number.isNaN(v));
  const missing = rows.length - nums.length;
  if (!nums.length) return { n: 0, missing, min: null, med: null, max: null };
  const sorted = [...nums].sort((a, b) => a - b);
  const med = sorted.length % 2
    ? sorted[(sorted.length - 1) / 2]
    : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
  return { n: nums.length, missing, min: sorted[0], med, max: sorted[sorted.length - 1] };
}

const r2 = (v) => (typeof v === 'number' ? Math.round(v * 100) / 100 : v);

function main() {
  const [name, field = DEFAULT_FIELD, daysArg] = process.argv.slice(2);
  if (!name) {
    console.error('Usage: node scripts/archive-values.js "<screener name>" [field] [days]');
    console.error('       (DB_PATH=data/t10.db to pick a tool)\n');
    let names = [];
    try {
      const seen = new Set();
      for (const row of db.prepare('SELECT data FROM r1_frozen').all()) {
        try { for (const k of (JSON.parse(row.data) || {}).screenerKeys || []) seen.add(k); }
        catch { /* a row that will not parse is not a screener name */ }
      }
      names = [...seen].sort();
    } catch { /* a fresh database has no archive */ }
    console.error(names.length
      ? 'Screeners in this archive:\n  ' + names.join('\n  ')
      : 'This archive holds no rows yet.');
    process.exit(1);
  }

  const days = Number(daysArg) > 0 ? Number(daysArg) : DEFAULT_DAYS;
  const rows = matches([name], field);
  const allDays = db.prepare('SELECT COUNT(DISTINCT date) n FROM r1_frozen').get().n;

  console.log(`\n"${name}" · ${field}   ${process.env.DB_PATH}`);
  if (!rows.length) {
    console.log(`\nNo archived row carries this screener across ${allDays} recorded `
      + 'day(s). It has never produced a card here, which is a stronger finding '
      + 'than a quiet afternoon — start with why-empty.js.');
    return;
  }

  const byDay = new Map();
  for (const r of rows) {
    if (!byDay.has(r.date)) byDay.set(r.date, []);
    byDay.get(r.date).push(r);
  }
  console.log(`${rows.length} row(s) across ${byDay.size} of ${allDays} recorded day(s)`
    + ` — about ${Math.round((rows.length / byDay.size) * 10) / 10} a day when it fired.\n`);

  for (const [date, list] of [...byDay].slice(0, days)) {
    console.log(`  ${date}  ` + list
      .map(r => `${r.ticker} ${r.value == null ? '—' : r2(r.value)}`)
      .join('   '));
  }
  if (byDay.size > days) console.log(`  … ${byDay.size - days} earlier day(s) not shown`);

  const s = summarise(rows);
  console.log('');
  if (!s.n) {
    console.log(`VERDICT: not one of those ${rows.length} row(s) carries a number for `
      + `${field}. Either the field is named wrong, or it was added to the card `
      + 'after these rows were captured — this says nothing about the rule.');
    return;
  }
  console.log(`${field} on the rows that matched:  min ${r2(s.min)} · median `
    + `${r2(s.med)} · max ${r2(s.max)}  (over ${s.n} row(s)`
    + (s.missing ? `; ${s.missing} carried no reading` : '') + ')');

  const note = NOT_THE_FILTERS_NUMBER[field];
  if (note) console.log(`\nCAUTION: ${note}`);

  console.log('\nRead it against the rule: if these numbers sit comfortably above the '
    + 'threshold, the rule works and a zero today is the market. If they sit BELOW '
    + 'it, the rule as written could not have produced them — something changed, '
    + 'and the counts have been reading like a slow market ever since.');
}

if (require.main === module) {
  try { main(); process.exit(0); } catch (err) {
    console.error('Failed:', err.stack || err.message);
    process.exit(1);
  }
}

module.exports = { pluck, summarise, matches, NOT_THE_FILTERS_NUMBER };
