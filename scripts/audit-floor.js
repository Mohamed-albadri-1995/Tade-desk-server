#!/usr/bin/env node
/*
 * Is anything in the collected data below the tradability floor?
 *
 * The floor is supposed to filter COLLECTION, not the view — a stock under a
 * dollar, or too thin, or with too little daily range, should never have been
 * fetched, so it should not be in any register and should not be in the
 * training data. If that were only true on screen, every result the analysis
 * produces would describe a population that was never traded.
 *
 * tests/floor.collection.test.js pins the code path. This checks the actual
 * rows, which is the part a test cannot see: it reads each tool's own database
 * and counts, per register, how many stored rows fail each leg.
 *
 *   node scripts/audit-floor.js            every tool
 *   node scripts/audit-floor.js T8         one of them
 *   node scripts/audit-floor.js --list     print the offending tickers
 *
 * Nothing is written and nothing is fetched; the tools do not need to be up.
 *
 * ONE EXPECTED SOURCE OF FAILURES. The ADR% leg is computed here rather than by
 * TradingView, and it passes rows whose ATR or price came back blank — a
 * provider hiccup must not silently shrink every result set. Those rows are
 * counted separately as "unknown" rather than as breaches, because nobody
 * established they were below the floor; nobody established they were above it
 * either. A large "unknown" count is the real finding to act on.
 */

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const ROOT = path.join(__dirname, '..');
const only = process.argv.slice(2).find(a => /^T\d+$/i.test(a));
const listThem = process.argv.includes('--list');

const tools = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools.config.json'), 'utf8')).tools;

// Read from the tool's own settings, not from the defaults — the floor a row
// was collected under is the floor that tool had configured.
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

const REGISTERS = [
  ['r1_frozen',  'SELECT date, ticker, data FROM r1_frozen'],
  ['r4a_train',  'SELECT date, ticker, data FROM r4a_train'],
  ['r4b_train',  'SELECT date, ticker, data FROM r4b_train'],
];

const num = v => (v === null || v === undefined || v === '' ? null : Number(v));

/*
 * A stored row is a JSON blob whose shape has changed over the life of the
 * project — sometimes { stock: {...} }, sometimes flat. Read both rather than
 * assuming, or an audit would report a clean sheet by looking in the wrong
 * place, which is the one failure mode that would make this script worse than
 * not running it.
 */
function fields(blob) {
  const d = blob && blob.stock ? blob.stock : (blob || {});
  return {
    price: num(d.price ?? d.close),
    avgVolume: num(d.avgVolume ?? d.average_volume_10d_calc ?? d.avgVolume10d),
    atr: num(d.atr ?? d.ATR ?? d.atr14),
  };
}

function audit(t) {
  const dbPath = path.join(ROOT, 'data', `${t.id.toLowerCase()}.db`);
  const legacy = path.join(ROOT, 'data', 'tradedesk.db');
  const file = fs.existsSync(dbPath) ? dbPath
    : (t.id === 'T1' && fs.existsSync(legacy) ? legacy : null);
  if (!file) return console.log(`\n${t.id}  ${t.name} — no database yet`);

  const db = new Database(file, { readonly: true });
  const f = floorFor(db);
  console.log(`\n${t.id} · ${t.name}`);
  console.log(`  floor in force: price >= $${f.minPrice}  ·  avg volume >= ${f.minAvgVolume.toLocaleString()}`
    + `  ·  ADR >= $${f.minAtr}  ·  ADR >= ${f.minAtrPct}%`);

  for (const [name, sql] of REGISTERS) {
    let rows = [];
    try { rows = db.prepare(sql).all(); } catch { continue; }   // table absent
    if (!rows.length) { console.log(`  ${name.padEnd(11)} empty`); continue; }

    const breach = { price: [], volume: [], atr: [], atrPct: [] };
    let unknown = 0;
    const allDates = new Set();

    for (const r of rows) {
      let blob;
      try { blob = JSON.parse(r.data); } catch { continue; }
      const { price, avgVolume, atr } = fields(blob);
      allDates.add(r.date);
      // Carry the numbers, not just the name. "Below the floor" covers two very
      // different findings — a stock that drifted a few cents under it during
      // the session, and a stored value that is nonsense — and only the figures
      // tell them apart.
      const hit = (got, want) => ({ date: r.date, ticker: r.ticker, got, want });

      if (f.minPrice > 0 && price !== null && price < f.minPrice) breach.price.push(hit(price, f.minPrice));
      if (f.minAvgVolume > 0 && avgVolume !== null && avgVolume < f.minAvgVolume) breach.volume.push(hit(avgVolume, f.minAvgVolume));
      if (f.minAtr > 0 && atr !== null && atr < f.minAtr) breach.atr.push(hit(atr, f.minAtr));

      if (f.minAtrPct > 0) {
        if (atr === null || price === null || price <= 0) unknown++;
        else if ((atr / price) * 100 < f.minAtrPct) breach.atrPct.push(hit(+((atr / price) * 100).toFixed(2), f.minAtrPct));
      }
    }

    const total = Object.values(breach).reduce((a, b) => a + b.length, 0);
    const verdict = total === 0 ? 'clean' : `${total} breach(es)`;
    const span = [...allDates].sort();
    console.log(`  ${name.padEnd(11)} ${String(rows.length).padStart(6)} rows   ${verdict}`
      + `   dates ${span[0] || '-'}..${span[span.length - 1] || '-'}`
      + (unknown ? `   ${unknown} not checkable` : ''));

    for (const [leg, hits] of Object.entries(breach)) {
      if (!hits.length) continue;
      const label = { price: 'below min price', volume: 'below min avg volume',
        atr: 'below min ADR $', atrPct: 'below min ADR %' }[leg];

      // Which DATES the breaches fall on is the question that decides what this
      // is. Confined to old dates, it is history collected under a floor that
      // has since changed, or before the column-alignment guard existed. Spread
      // across every date including the most recent, something is letting them
      // through now.
      const byDate = {};
      for (const h of hits) byDate[h.date] = (byDate[h.date] || 0) + 1;
      const dates = Object.keys(byDate).sort();
      const worst = hits.slice().sort((a, b) => a.got - b.got)[0];

      console.log(`      ${String(hits.length).padStart(5)}  ${label}`
        + `   on ${dates.length}/${span.length} day(s): ${dates.join(' ')}`);
      console.log(`             worst ${worst.ticker} ${worst.got} vs ${worst.want} required`);
      if (listThem) {
        console.log('             ' + hits.slice(0, 25)
          .map(h => `${h.ticker}@${h.date}=${h.got}`).join('  ')
          + (hits.length > 25 ? '  …' : ''));
      }
    }
  }
  db.close();
}

console.log('TRADABILITY FLOOR — what is actually stored, not what the screen shows');
console.log('A breach means a row was collected that the floor should have excluded.');
console.log('"not checkable" rows had no ATR or no price; they passed by design, see tradable.js.');

for (const t of tools) {
  if (only && t.id.toUpperCase() !== only.toUpperCase()) continue;
  audit(t);
}
console.log('\nRun with --list to see the tickers.\n');
