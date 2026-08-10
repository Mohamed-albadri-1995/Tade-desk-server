#!/usr/bin/env node
/*
 * Remove stored rows that the tradability floor would never have collected.
 *
 * They exist for a plain reason: the floor was written on 2026-07-31, and the
 * registers start well before that — T1's go back to 2026-06-29. Rows from
 * before it landed were collected under no floor at all, so a $0.0002 ATR or a
 * $0.12 share price got in legitimately at the time. Nothing is leaking
 * through now, and the dates are what say so: across every tool the breaches
 * stop on 2026-07-31 and there are none after it.
 *
 * But they are still in the training tables, and that is the part worth acting
 * on. A model fitted on stocks the desk cannot trade learns from moves nobody
 * could have taken, and the month-end comparison between screeners is decided
 * by exactly those rows: an untradable name with a huge percentage move is the
 * kind of outlier that flatters whichever screener happened to find it.
 *
 *   node scripts/purge-sub-floor.js            show what would go (default)
 *   node scripts/purge-sub-floor.js --yes      actually delete it
 *   node scripts/purge-sub-floor.js T7 --yes   one tool
 *
 * DELETING IS THE POINT, so it does not happen by accident: the default run
 * writes nothing, and every real run copies the database file first. The copy
 * sits beside it as <tool>.db.prepurge-<timestamp> and is never cleaned up
 * automatically — a backup that deletes itself is not a backup.
 *
 * What is NOT removed: rows whose ATR or price came back empty. Nobody
 * established those were below the floor, and throwing away every row with a
 * gap in it would quietly delete a provider's bad afternoon along with the
 * stocks that deserve to go.
 */

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const ROOT = path.join(__dirname, '..');
const args = process.argv.slice(2);
const only = args.find(a => /^T\d+$/i.test(a));
const commit = args.includes('--yes');

const tools = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools.config.json'), 'utf8')).tools;

const REGISTERS = ['r1_frozen', 'r4a_train', 'r4b_train'];

const num = v => (v === null || v === undefined || v === '' ? null : Number(v));

function floorFor(db) {
  const get = (k, d) => {
    try {
      const r = db.prepare('SELECT value FROM settings WHERE key = ?').get(k);
      const n = r ? parseFloat(r.value) : NaN;
      return Number.isFinite(n) ? n : d;
    } catch { return d; }
  };
  return {
    minPrice: get('minPrice', 1),
    minAvgVolume: get('minAvgVolume', 1000000),
    minAtr: get('minAtr', 1),
    minAtrPct: get('minAtrPct', 3),
  };
}

// Same reader as the audit — the stored shape has changed over time, and a
// purge that looked in the wrong place would report nothing to do while the
// rows it was meant to find sat there.
function fields(blob) {
  const d = blob && blob.stock ? blob.stock : (blob || {});
  return {
    price: num(d.price ?? d.close),
    avgVolume: num(d.avgVolume ?? d.average_volume_10d_calc ?? d.avgVolume10d),
    atr: num(d.atr ?? d.ATR ?? d.atr14),
  };
}

/** Why this row fails, or null if it does not. Missing data is never a reason. */
function reason(blob, f) {
  const { price, avgVolume, atr } = fields(blob);
  if (f.minPrice > 0 && price !== null && price < f.minPrice) return `price ${price} < ${f.minPrice}`;
  if (f.minAvgVolume > 0 && avgVolume !== null && avgVolume < f.minAvgVolume) return `volume ${avgVolume} < ${f.minAvgVolume}`;
  if (f.minAtr > 0 && atr !== null && atr < f.minAtr) return `ADR $${atr} < $${f.minAtr}`;
  if (f.minAtrPct > 0 && atr !== null && price !== null && price > 0
      && (atr / price) * 100 < f.minAtrPct) {
    return `ADR ${((atr / price) * 100).toFixed(2)}% < ${f.minAtrPct}%`;
  }
  return null;
}

function purge(t) {
  const dbPath = path.join(ROOT, 'data', `${t.id.toLowerCase()}.db`);
  const legacy = path.join(ROOT, 'data', 'tradedesk.db');
  const file = fs.existsSync(dbPath) ? dbPath
    : (t.id === 'T1' && fs.existsSync(legacy) ? legacy : null);
  if (!file) return 0;

  const db = new Database(file, { readonly: !commit });
  const f = floorFor(db);
  const doomed = {};
  const sizes = {};
  let total = 0;

  for (const table of REGISTERS) {
    let rows = [];
    try { rows = db.prepare(`SELECT date, ticker, data FROM ${table}`).all(); } catch { continue; }
    sizes[table] = rows.length;
    const hits = [];
    for (const r of rows) {
      let blob;
      try { blob = JSON.parse(r.data); } catch { continue; }
      const why = reason(blob, f);
      if (why) hits.push({ date: r.date, ticker: r.ticker, why });
    }
    if (hits.length) { doomed[table] = hits; total += hits.length; }
  }

  if (!total) { db.close(); return 0; }

  /*
   * The share, not just the count.
   *
   * "309 rows" is not a number anyone can decide on. Removing 4% of a training
   * set is housekeeping; removing 40% of it is a different act, and T1 is the
   * tool with a month of history and the one measured edge on it. The figure
   * that makes the decision is how much of each register goes, and how much is
   * left — a register cut to twenty rows cannot support the comparison it was
   * collected for, whatever the rows that remain deserve.
   */
  console.log(`\n${t.id} · ${t.name}  —  ${total} row(s)`);
  console.log('  effect on each register:');
  for (const table of REGISTERS) {
    const n = (doomed[table] || []).length;
    const of = sizes[table] || 0;
    if (!of) continue;
    const pct = ((n / of) * 100).toFixed(n / of >= 0.1 ? 0 : 1);
    console.log(`    ${table.padEnd(11)} ${String(n).padStart(4)} of ${String(of).padStart(5)}`
      + `  = ${String(pct).padStart(4)}% removed, ${of - n} left`);
  }

  const showDetail = !args.includes('--quiet');
  for (const [table, hits] of Object.entries(doomed)) {
    const byDate = {};
    for (const h of hits) (byDate[h.date] = byDate[h.date] || []).push(h);
    const dates = Object.keys(byDate).sort();
    if (!showDetail) {
      console.log(`  ${table}: ${dates[0]} … ${dates[dates.length - 1]} (${dates.length} day(s))`);
      continue;
    }
    console.log(`  ${table}`);
    for (const date of dates) {
      const list = byDate[date];
      console.log(`    ${date}  ${String(list.length).padStart(3)} row(s)  `
        + list.slice(0, 6).map(h => `${h.ticker} (${h.why})`).join(', ')
        + (list.length > 6 ? ` …+${list.length - 6}` : ''));
    }
  }

  if (!commit) { db.close(); return total; }

  // Copy the whole file before touching it. A per-row dump would be the more
  // elegant backup and the wrong one: if this script's idea of which rows to
  // remove is mistaken, the dump inherits the mistake, while a file copy does
  // not care what the reasoning was.
  const backup = `${file}.prepurge-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  fs.copyFileSync(file, backup);

  const del = {};
  for (const table of REGISTERS) del[table] = db.prepare(`DELETE FROM ${table} WHERE date = ? AND ticker = ?`);
  const run = db.transaction(() => {
    for (const [table, hits] of Object.entries(doomed)) {
      for (const h of hits) del[table].run(h.date, h.ticker);
    }
  });
  run();
  db.close();
  console.log(`  deleted. backup: ${path.basename(backup)}`);
  return total;
}

console.log(commit
  ? 'REMOVING rows the tradability floor would have excluded. Each database is copied first.'
  : 'DRY RUN — nothing will be changed. Add --yes to actually delete.');
console.log('Add --quiet for the summary without the per-day ticker lists.');

let grand = 0;
for (const t of tools) {
  if (only && t.id.toUpperCase() !== only.toUpperCase()) continue;
  grand += purge(t);
}

console.log(grand === 0
  ? '\nNothing to remove — every stored row passes the floor in force.\n'
  : `\n${grand} row(s) ${commit ? 'removed' : 'would be removed'}.`
    + (commit ? '\nRestart the tools so nothing is holding a stale copy: pm2 restart all\n'
              : '\nRun again with --yes to do it. Each database is copied first.\n'));
