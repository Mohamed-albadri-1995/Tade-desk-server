#!/usr/bin/env node
/*
 * What every tool is actually screening for, and when.
 *
 * Read from each tool's own database rather than from the seed definitions,
 * because those are only what a tool STARTED with. Screeners get edited in the
 * builder, renamed, disabled; T2's mirror was renamed and lost its link to its
 * parent for weeks. A reference that is written down separately from the thing
 * it describes goes stale quietly, and a stale description of a screener is
 * worse than none — it is the one you would check before trusting a result.
 *
 *   node scripts/show-screeners.js            every tool
 *   node scripts/show-screeners.js T7         one of them
 *   node scripts/show-screeners.js --md       markdown, for pasting somewhere
 *
 * Nothing is fetched and nothing is written; the tools do not need to be up.
 */

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const ROOT = path.join(__dirname, '..');
const only = process.argv.slice(2).find(a => /^T\d+$/i.test(a));
const asMd = process.argv.includes('--md');

const tools = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools.config.json'), 'utf8')).tools;

// Mirrors src/sideA/tradable.js — appended to every screener at scan time, so a
// list of a screener's rules that omitted it would be missing the ones that
// actually decide what is tradable.
function floorFor(db) {
  const get = (k, d) => {
    try {
      const r = db.prepare('SELECT value FROM settings WHERE key = ?').get(k);
      const n = r ? parseFloat(r.value) : NaN;
      return Number.isFinite(n) ? n : d;
    } catch { return d; }
  };
  return {
    minAvgVolume: get('minAvgVolume', 1000000),
    minAtr: get('minAtr', 1),
    minAtrPct: get('minAtrPct', 3),
  };
}

const fmtRight = (r) => Array.isArray(r) ? `[${r.join(', ')}]`
  : typeof r === 'string' ? r : String(r);

const OPS = {
  greater: '>', egreater: '>=', less: '<', eless: '<=', equal: '=',
  not_in_range: 'outside', in_range: 'within',
  crosses_above: 'crosses above', crosses_below: 'crosses below',
};
const op = (o) => OPS[o] || o;

/*
 * When a screener actually runs.
 *
 * Two things have to line up and only one of them lives on the screener. The
 * scheduler fires discovery scans on a fixed cadence; a screener runs on a scan
 * only if the clock is inside its own window. A screener with no window is not
 * broken — it runs on every scan of the day, which for several of T1's is the
 * intent.
 */
const SCANS = [
  ['04:00–09:00', 'every 30 min'],
  ['09:00–10:00', 'every 5 min'],
  ['10:00–16:00', 'every 15 min'],
];

function windowText(s) {
  if (!s.run_from && !s.run_to) return 'all day (04:00–16:00)';
  return `${s.run_from || '04:00'}–${s.run_to || '16:00'} ET`;
}

function show(t) {
  const dbPath = path.join(ROOT, 'data', `${t.id.toLowerCase()}.db`);
  const legacy = path.join(ROOT, 'data', 'tradedesk.db');
  const file = fs.existsSync(dbPath) ? dbPath : (t.id === 'T1' && fs.existsSync(legacy) ? legacy : null);
  if (!file) return console.log(`\n${t.id}  ${t.name} — no database yet\n`);

  const db = new Database(file, { readonly: true });
  let rows = [];
  try {
    rows = db.prepare('SELECT * FROM screeners ORDER BY id').all();
  } catch { /* table not created yet */ }
  const floor = floorFor(db);
  db.close();

  const h = asMd ? '### ' : '';
  console.log(`\n${h}${t.id} · ${t.name}  —  port ${t.port}`);
  console.log(`freeze ${t.captureAt.r1} · entry A ${t.captureAt.entryA} · entry B ${t.captureAt.entryB} ET`);
  if (t.captureAt.why) console.log(`why: ${t.captureAt.why}`);

  if (!rows.length) return console.log('  (no screeners stored)');

  for (const s of rows) {
    let filters = [];
    try { filters = JSON.parse(s.filters); } catch { /* leave empty */ }
    let sort = null;
    try { sort = s.sort ? JSON.parse(s.sort) : null; } catch { /* ignore */ }

    console.log(`\n  ${s.enabled ? '' : '[OFF] '}${s.name}`);
    console.log(`    runs   ${windowText(s)}`);
    console.log(`    top    ${s.limit_n || 50}${sort ? `, sorted by ${sort.sortBy} ${sort.sortOrder}` : ''}`);
    if (s.mirror_of) console.log(`    mirror of "${s.mirror_of}"`);
    console.log('    rules:');
    for (const f of filters) console.log(`      ${f.left} ${op(f.operation)} ${fmtRight(f.right)}`);
    console.log(`      + avg volume >= ${floor.minAvgVolume.toLocaleString()}   (floor)`);
    console.log(`      + ATR >= $${floor.minAtr}                    (floor)`);
    console.log(`      + ATR >= ${floor.minAtrPct}% of price            (floor)`);
  }
}

console.log('SCAN CADENCE — a screener runs on a scan only if the clock is inside its window');
for (const [when, how] of SCANS) console.log(`  ${when}   ${how}`);
console.log('  plus a re-quote of existing cards every 5 min, 04:00–16:00 — no new stocks');
console.log('  weekdays only, New York time');

for (const t of tools) {
  if (only && t.id.toUpperCase() !== only.toUpperCase()) continue;
  show(t);
}
console.log('');
