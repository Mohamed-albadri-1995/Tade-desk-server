#!/usr/bin/env node
/*
 * WRITE DOWN WHAT THE BROKER SAYS IT PAID, WHILE IT WILL STILL SAY.
 *
 * The desk's own ledger for 2026-09-08 to 09-11:
 *
 *     PL   |2702|17.75 |17.935|-|SENT|1351@17.38=acc 1351@runner=acc
 *     DOCU | 791|65.71 |66.275|-|SENT| 395@64.58=acc  396@runner=acc
 *     AXTI | 263|73.17 |71.273|-|SENT| 131@76.97=acc  132@runner=acc
 *     QCOM | 204|179.61|177.17|-|SENT| 102@184.49=acc 102@runner=acc
 *
 * Every fill price a dash. Four sessions of real orders and the desk cannot say
 * what one of them cost.
 *
 * WHY. On a paper account SignalStack sends no callback, so the only record of
 * the price is Alpaca's. `reconcile.confirmed()` has always been able to fetch
 * it — and returned it in memory and thrown it away. Alpaca's activities
 * endpoint does not keep prints forever, so this is not a gap that can be
 * filled in next month. It has to be written down now.
 *
 * Without it nothing can be compared to a backtest. The backtest knows exactly
 * what it paid; the desk knows only what it hoped to pay, and the difference
 * between those two numbers IS the execution fault being looked for.
 *
 *   node scripts/save-fills.js 2026-09-08
 *   node scripts/save-fills.js 2026-09-08 2026-09-09 2026-09-10 2026-09-11
 *   node scripts/save-fills.js --dry 2026-09-08      # show, write nothing
 *
 * APPEND-ONLY AND IDEMPOTENT. Each fill is a new row keyed by the broker's
 * order id; the order row is never edited, because it is the record of what
 * this side INTENDED and that is the other half of every slip measurement.
 * Running it twice writes nothing the second time.
 */

const broker = require('../src/broker/signalstack');
const reconcile = require('../src/broker/reconcile');

const r4 = (v) => (Number.isFinite(v) ? Math.round(v * 10000) / 10000 : v);

async function saveDay(date, { dry = false } = {}) {
  let out;
  try {
    out = await reconcile.confirmed(date);
  } catch (err) {
    return { date, ok: false, error: err.message };
  }
  /*
   * A DAY THAT COULD NOT BE ASKED IS NOT A DAY WITH NO FILLS. Bad keys, a
   * timeout, two Alpaca accounts the credential rule refuses to guess between —
   * all of them come back here, and writing "0 fills" for any of them would
   * put a permanent, confident blank where the prices used to be.
   */
  if (!out || out.ok === false) {
    return { date, ok: false, error: (out && out.error) || 'the broker did not answer' };
  }
  if (!out.verifiable) {
    return { date, ok: false,
      error: 'no account here could be asked for fills — nothing was written' };
  }

  const already = broker.fillsRecorded();
  const rows = (out.rows || []).filter(r => r.sent
    && r.confirmedBy === 'alpaca'
    && r.orderId && Number.isFinite(Number(r.finalPrice)));

  const wrote = [];
  const skipped = [];
  for (const r of rows) {
    if (already.has(String(r.orderId))) { skipped.push(r.symbol); continue; }
    if (!dry) {
      broker.recordFill({
        orderId: r.orderId, symbol: r.symbol, date: r.date,
        fillPrice: Number(r.finalPrice), filledQty: r.filledQty ?? null,
        prints: r.prints ?? null, by: 'alpaca',
      });
      already.add(String(r.orderId));
    }
    wrote.push(r);
  }
  return { date, ok: true, wrote, skipped,
           unmatched: (out.rows || []).filter(r => r.sent && !r.confirmed).length };
}

async function main() {
  const args = process.argv.slice(2);
  const dry = args.includes('--dry');
  const dates = args.filter(a => /^\d{4}-\d{2}-\d{2}$/.test(a));
  if (!dates.length) {
    console.error('Usage: node scripts/save-fills.js [--dry] <YYYY-MM-DD> [more dates…]');
    process.exit(1);
  }

  console.log(`\nSAVING WHAT THE BROKER PAID${dry ? '  (dry run — nothing written)' : ''}`);
  console.log(`${broker.LEDGER}\n`);

  let total = 0;
  let failed = 0;
  for (const date of dates) {
    const r = await saveDay(date, { dry });
    if (!r.ok) {
      failed += 1;
      // AN ERROR IS NOT A ZERO. The line says which it was.
      console.log(`  ${date}  COULD NOT ASK — ${r.error}`);
      continue;
    }
    for (const x of r.wrote) {
      const s = broker.slipOf(x, { fillPrice: Number(x.finalPrice) });
      console.log(`  ${date}  ${String(x.symbol).padEnd(6)} `
        + `decided ${String(r4(Number(x.price))).padStart(9)}  `
        + `paid ${String(r4(Number(x.finalPrice))).padStart(9)}  `
        + `slip ${String(s.slip == null ? '—' : r4(s.slip)).padStart(8)}  `
        + `${s.slipR == null ? '' : r4(s.slipR) + 'R'}`);
    }
    total += r.wrote.length;
    const bits = [];
    if (r.skipped.length) bits.push(`${r.skipped.length} already saved`);
    if (r.unmatched) bits.push(`${r.unmatched} sent order(s) Alpaca has no fill for`);
    console.log(`  ${date}  ${r.wrote.length} fill(s) ${dry ? 'would be ' : ''}saved`
      + (bits.length ? `   (${bits.join('; ')})` : ''));
  }

  console.log(`\n${total} fill(s) ${dry ? 'would be ' : ''}written`
    + (failed ? `, ${failed} day(s) could not be asked` : ''));
  if (total && !dry) {
    console.log('\nNow: node scripts/measure-slippage.js --since ' + dates[0]);
  }
  if (failed) {
    console.log('\nA day that could not be asked keeps its dashes. That is the honest');
    console.log('state — it is not a day that filled at the decision price.');
  }
}

if (require.main === module) {
  main().then(() => process.exit(0)).catch((err) => {
    console.error('Failed:', err.stack || err.message);
    process.exit(1);
  });
}

module.exports = { saveDay };
