/*
 * Rebuild the R4A/R4B training rows from the warehouse.
 *
 * r4a_train / r4b_train are normally appended one day at a time by the
 * end-of-day capture. Clearing them (DELETE /api/analysis/training-data)
 * therefore empties the model's entire training set with no way to get it
 * back from the UI — even though nothing was actually lost, because every row
 * is derivable from r1_frozen (the 9:36 card) joined to r3a/r3b (the outcome).
 *
 * This replays syncFromWarehouse over every date that has a frozen register,
 * which is also the cleanest way to take a fresh start: the rebuilt rows are
 * re-derived through getRegisterData, so they pick up the relational signals
 * automatically and no separate backfill is needed.
 *
 * Rows without an EOD outcome are skipped by syncFromWarehouse, exactly as
 * they are on a normal day.
 *
 *   node scripts/rebuild_training.js --dry-run
 *   node scripts/rebuild_training.js
 */

const db = require('../src/db');
const training = require('../src/training/trainingData');

const DRY = process.argv.includes('--dry-run');

function main() {
  const dates = db
    .prepare('SELECT DISTINCT date FROM r1_frozen ORDER BY date ASC')
    .all()
    .map(r => r.date);

  if (!dates.length) {
    console.log('No frozen R1 dates found — nothing to rebuild.');
    return;
  }

  const before = { R4A: training.getRowCount('R4A'), R4B: training.getRowCount('R4B') };
  console.log(`Dates in the warehouse : ${dates.length}  (${dates[0]} → ${dates[dates.length - 1]})`);
  console.log(`Training rows before   : R4A ${before.R4A}, R4B ${before.R4B}`);
  console.log(DRY ? '\nDRY RUN — nothing will be written\n' : '');

  let a = 0, b = 0, empty = 0;
  for (const date of dates) {
    if (DRY) {
      // Count what would be written without touching the tables.
      const { getRegisterData } = require('../src/warehouse/registers');
      const ra = (getRegisterData('R4A', date) || []).filter(r => r.upR_A != null && r.downR_A != null);
      const rb = (getRegisterData('R4B', date) || []).filter(r => r.upR_B != null && r.downR_B != null);
      a += ra.length; b += rb.length;
      if (!ra.length && !rb.length) empty++;
      continue;
    }
    const res = training.syncFromWarehouse(date);
    a += res.r4a; b += res.r4b;
    if (!res.r4a && !res.r4b) empty++;
  }

  console.log(`Rows ${DRY ? 'that would be rebuilt' : 'rebuilt'} : R4A ${a}, R4B ${b}`);
  if (empty) console.log(`Dates with no EOD outcome yet : ${empty} (skipped, as on a normal day)`);

  if (!DRY) {
    const after = { R4A: training.getRowCount('R4A'), R4B: training.getRowCount('R4B') };
    console.log(`Training rows after    : R4A ${after.R4A}, R4B ${after.R4B}`);

    // Confirm the rebuilt rows carry the relational signals, since that is the
    // main reason to rebuild rather than restore from a backup.
    const sample = db.prepare('SELECT data FROM r4a_train ORDER BY date DESC LIMIT 1').get();
    if (sample) {
      const row = JSON.parse(sample.data);
      const has = ['vsEma20', 'distEma20', 'maStack', 'monthQuarter', 'pmAdrBand']
        .filter(k => Object.prototype.hasOwnProperty.call(row, k));
      console.log(`Sample row ${row.ticker} ${row.date}: ${has.length}/5 signal fields present` +
        (has.length === 5 ? ` (vsEma20=${row.vsEma20}, maStack=${row.maStack})` : ''));
    }
    console.log('\nNow retrain from the Analysis tab.');
  } else {
    console.log('\nRe-run without --dry-run to apply.');
  }
}

main();
