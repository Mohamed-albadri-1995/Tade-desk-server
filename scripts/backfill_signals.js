/*
 * Backfill relational signals into the stored training rows.
 *
 * r4a_train / r4b_train hold frozen JSON snapshots taken when each day was
 * captured, and writeTrainingCSV builds the model's training file from those
 * stored rows — not from a live register read. So rows captured before
 * sideB/relations.js existed carry none of the new columns, and a retrain
 * would only see them on rows added from today onward.
 *
 * This merges the signals into each stored row in place. It is additive and
 * non-destructive: the R4 row is already flat and carries price, ema9/13/20/50,
 * sma5, vwap, prevClose, open, pmHigh/pmLow, monthRangePos and pmAdrRatio at
 * the top level, which is exactly what computeRelations needs — so nothing is
 * re-derived from the warehouse, no existing value is touched, and manually
 * added rows keep their `source` and their edits.
 *
 * Safe to re-run; recomputing from unchanged inputs yields the same values.
 *
 *   node scripts/backfill_signals.js --dry-run
 *   node scripts/backfill_signals.js
 */

const db = require('../src/db');
const { computeRelations, RELATION_FIELDS } = require('../src/sideB/relations');

const TABLES = { R4A: 'r4a_train', R4B: 'r4b_train' };
const DRY = process.argv.includes('--dry-run');

function backfill(register) {
  const table = TABLES[register];
  const rows = db.prepare(`SELECT date, ticker, data FROM ${table}`).all();
  if (!rows.length) return { register, total: 0, updated: 0, alreadyHad: 0, noInputs: 0 };

  const update = db.prepare(`UPDATE ${table} SET data = ? WHERE date = ? AND ticker = ?`);
  let updated = 0, alreadyHad = 0, noInputs = 0;

  const txn = db.transaction(items => {
    for (const r of items) {
      let row;
      try {
        row = JSON.parse(r.data);
      } catch {
        continue;
      }
      // The flat R4 row is itself the "stock" shape computeRelations expects.
      const sig = computeRelations(row);
      if (sig.vsEma20 === null && sig.vsVwap === null && sig.vsPrevClose === null) {
        noInputs++;               // nothing to relate — leave the row alone
        continue;
      }
      const had = RELATION_FIELDS.every(f => Object.prototype.hasOwnProperty.call(row, f));
      const merged = { ...row };
      for (const f of RELATION_FIELDS) merged[f] = sig[f] ?? null;
      if (had && RELATION_FIELDS.every(f => row[f] === merged[f])) {
        alreadyHad++;
        continue;
      }
      if (!DRY) update.run(JSON.stringify(merged), r.date, r.ticker);
      updated++;
    }
  });
  txn(rows);

  return { register, total: rows.length, updated, alreadyHad, noInputs };
}

function main() {
  console.log(DRY ? '[Backfill] DRY RUN — nothing will be written\n' : '[Backfill] writing\n');
  const results = [];
  for (const register of Object.keys(TABLES)) {
    const res = backfill(register);
    results.push(res);
    console.log(
      `  ${res.register}: ${res.total} stored rows | ` +
      `${res.updated} ${DRY ? 'would gain' : 'gained'} signals | ` +
      `${res.alreadyHad} already current | ${res.noInputs} lacked the inputs`
    );
  }

  // Show one row so the result is verifiable rather than just a count.
  const sample = db.prepare('SELECT data FROM r4a_train ORDER BY date DESC LIMIT 1').get();
  if (sample) {
    const row = JSON.parse(sample.data);
    const sig = computeRelations(row);
    console.log(
      `\n  sample ${row.ticker} ${row.date}: price ${row.price} vs ema20 ${row.ema20} -> ` +
      `${sig.vsEma20} ${sig.distEma20 == null ? '' : (sig.distEma20 >= 0 ? '+' : '') + sig.distEma20 + '%'}` +
      ` | stack ${sig.maStack} | ${sig.monthQuarter} | pm/adr ${sig.pmAdrBand}`
    );
  }

  const totalUpdated = results.reduce((n, r) => n + r.updated, 0);
  console.log(
    DRY
      ? `\n  ${totalUpdated} rows would be updated. Re-run without --dry-run to apply.`
      : `\n  Done — ${totalUpdated} rows updated. Retrain to let the model use them.`
  );
}

main();
