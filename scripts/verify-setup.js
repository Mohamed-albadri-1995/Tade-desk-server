#!/usr/bin/env node
/*
 * Hold the T2 VWAP-extension implementation against the spec's reference log.
 *
 *   node scripts/verify-setup.js                 whatever feed answers first
 *   node scripts/verify-setup.js --feed=polygon  the feed the spec was built on
 *   node scripts/verify-setup.js --feed=yahoo
 *
 * setup_spec.md section 6 ships eight trades with their direction, entry price,
 * extension and risk. Those numbers came from a separate analysis of real
 * 1-minute bars, so re-deriving them here from bars fetched independently is a
 * real check on this implementation rather than a restatement of it: an
 * anchoring mistake, an off-by-one in the morning window, or a VWAP built from
 * the wrong volume would all move these numbers and none of them would move the
 * unit tests, which use constructed bars.
 *
 * It could not be run where the code was written — that machine's network
 * policy blocks the data hosts — so it lives here to be run on the box that
 * has them.
 *
 * WHAT A MISMATCH MEANS. Usually the feed, not a bug — and that has now been
 * measured rather than assumed. Run against Yahoo, every direction came out
 * right and six of the eight entry prices matched to the cent, while the
 * extensions moved by up to 2.4 points. Direction and entry depend only on
 * prices; extension depends on VWAP, and VWAP depends on VOLUME. The formula is
 * identical to the quant platform's, so what differs between the two is the
 * tape each feed reports.
 *
 * The reference numbers were produced on Polygon, the platform's default. So
 * --feed=polygon is the run that tests THIS code, and a run on any other feed
 * tests the feed. The column on the right says which one answered.
 */

const path = require('path');
const ROOT = path.join(__dirname, '..');
const barsSource = require(path.join(ROOT, 'src', 'setups', 'bars'));
const s = require(path.join(ROOT, 'src', 'setups', 'vwapExtension'));

// setup_spec.md §6, entry = open of the 10:00 bar.
const REFERENCE = [
  { date: '2026-07-31', ticker: 'FFAI', dir: 'LONG',  entry: 5.43,   ext: 4.94, risk: 4.70 },
  { date: '2026-07-31', ticker: 'COHU', dir: 'SHORT', entry: 49.35,  ext: 4.82, risk: 5.06 },
  { date: '2026-08-04', ticker: 'ADEA', dir: 'LONG',  entry: 27.64,  ext: 3.23, risk: 3.13 },
  { date: '2026-08-04', ticker: 'WLK',  dir: 'LONG',  entry: 76.47,  ext: 1.68, risk: 1.65 },
  { date: '2026-08-05', ticker: 'BBNX', dir: 'SHORT', entry: 13.77,  ext: 4.14, risk: 4.32 },
  { date: '2026-08-05', ticker: 'CDW',  dir: 'LONG',  entry: 132.62, ext: 4.00, risk: 3.85 },
  { date: '2026-08-06', ticker: 'LIFE', dir: 'LONG',  entry: 29.05,  ext: 4.95, risk: 4.71 },
  { date: '2026-08-06', ticker: 'LSCC', dir: 'LONG',  entry: 129.56, ext: 2.76, risk: 2.69 },
];

// Tolerances. Entry is a printed price and should match to the cent. Extension
// and risk are percentages the spec quotes to two decimals, so half a basis
// point of rounding is expected and anything larger is a real difference.
const TOL = { entry: 0.02, pct: 0.06 };

const near = (got, want, tol) => got != null && Math.abs(got - want) <= tol;
const pad = (v, n) => String(v).padEnd(n);

const FEED = (process.argv.find(a => a.startsWith('--feed=')) || '').split('=')[1] || null;
if (FEED && !barsSource.SOURCES.some(s => s.id === FEED)) {
  console.error(`Unknown feed "${FEED}". Have: ${barsSource.SOURCES.map(s => s.id).join(', ')}`);
  process.exit(2);
}
console.log(FEED
  ? `Feed: ${FEED} only.${FEED === 'polygon' ? ' This is the one the spec was built on.' : ''}`
  : 'Feed: whichever answers first (Polygon, then Yahoo, then Alpaca).');

(async () => {
  const byDate = new Map();
  for (const r of REFERENCE) {
    if (!byDate.has(r.date)) byDate.set(r.date, []);
    byDate.get(r.date).push(r);
  }

  let checked = 0;
  let matched = 0;
  const problems = [];

  for (const [date, rows] of byDate) {
    const tickers = rows.map(r => r.ticker);
    // Deliberately the same fetch path the live run uses, so a data problem
    // shows up here rather than only at 10:00 on a Monday.
    const data = await barsSource.fetchMorning(tickers, date, { attempts: 1, waitMs: 0, only: FEED });

    console.log(`\n${date}`);
    for (const r of rows) {
      const bars = data.bars[r.ticker] || [];
      const source = data.sources[r.ticker] || 'none';
      if (!bars.length) {
        console.log(`  ${pad(r.ticker, 6)} no bars (${source}) — cannot check`);
        problems.push(`${date} ${r.ticker}: no bars`);
        continue;
      }

      const out = s.evaluateTicker(r.ticker, bars);
      const tenOpen = bars.find(b => b.etTime === '10:00');
      const entry = tenOpen ? Number(tenOpen.o) : null;
      const plan = (out.signal !== 'NONE' && entry != null)
        ? s.plan(out.signal, entry, out.decisionVwap) : null;

      const dirOK = out.signal === r.dir;
      const entryOK = near(entry, r.entry, TOL.entry);
      const extOK = near(out.extension, r.ext, TOL.pct);
      const riskOK = plan != null && near(plan.riskPct, r.risk, TOL.pct);
      const all = dirOK && entryOK && extOK && riskOK;

      checked++;
      if (all) matched++;
      else {
        problems.push(`${date} ${r.ticker}: `
          + [!dirOK && `direction ${out.signal} vs ${r.dir}`,
             !entryOK && `entry ${entry} vs ${r.entry}`,
             !extOK && `extension ${out.extension?.toFixed(2)} vs ${r.ext}`,
             !riskOK && `risk ${plan?.riskPct?.toFixed(2)} vs ${r.risk}`,
            ].filter(Boolean).join(', '));
      }

      console.log(`  ${pad(r.ticker, 6)} ${all ? 'OK  ' : 'DIFF'}`
        + `  dir ${pad(out.signal, 5)}${dirOK ? ' ' : '≠'}${r.dir}`
        + `  entry ${pad(entry?.toFixed(2) ?? '—', 8)}${entryOK ? ' ' : '≠'}${r.entry}`
        + `  ext ${pad(out.extension?.toFixed(2) ?? '—', 6)}${extOK ? ' ' : '≠'}${r.ext}`
        + `  risk ${pad(plan?.riskPct?.toFixed(2) ?? '—', 6)}${riskOK ? ' ' : '≠'}${r.risk}`
        + `  [${source}]`);
    }
  }

  console.log(`\n${matched}/${checked} reference trades reproduced.`);
  if (!problems.length && checked === REFERENCE.length) {
    console.log('The implementation matches the spec on real bars.');
    process.exit(0);
  }
  console.log('\nDifferences:');
  for (const p of problems) console.log(`  ${p}`);
  console.log('\nBefore treating these as bugs, check the feed column above. The spec\'s');
  console.log('numbers assume the consolidated tape; anything marked alpaca:iex was');
  console.log('computed from a few percent of the volume and its VWAP will differ.');
  process.exit(1);
})();
