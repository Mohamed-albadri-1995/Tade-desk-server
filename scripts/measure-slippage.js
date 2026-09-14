#!/usr/bin/env node
/*
 * WHAT THE DELAY BETWEEN DECIDING AND FILLING ACTUALLY COSTS — measured.
 *
 * The backtest fills at a price on the bar chart: the decision bar's close, or
 * the next bar's open. The desk fills wherever the tape is when its market
 * order arrives, which on 2026-09-08 was nineteen seconds after the decision:
 *
 *     OR + VWAP 09:35   09:34  19375ms   SHORT PL 2702 @ 17.75
 *     the fill                            17.515
 *
 * That 0.235 is 1.32% of the price and 1.27R of the trade. Only one of those
 * two numbers explains why a backtest showing +$611 on that name produced
 * about +$69 in the account, and it is not the percentage.
 *
 * SO THE BACKTEST NEEDS A COST, AND THE COST MUST NOT BE INVENTED. The backtest
 * page leaves its cost field blank on purpose: a default there would silently
 * change what gets tested, and a plausible-looking figure nobody chose is worse
 * than none. This is where the figure comes from instead — the desk's own
 * ledger, every entry it has a real fill for, in the three units that matter.
 *
 * Put the bps figure in the backtest's Cost field, and the run is finally about
 * the situation the orders are placed in.
 *
 *   node scripts/measure-slippage.js
 *   node scripts/measure-slippage.js 2026-09-08
 *   node scripts/measure-slippage.js --since 2026-09-08
 *
 * IT CHANGES NOTHING — it reads the ledger and prints.
 */

const broker = require('../src/broker/signalstack');

/** Entries with a price we decided at and a price we really got. */
function measured({ date = null, since = null } = {}) {
  return broker.reconciled(date)
    .filter(o => o.sent && o.kind !== 'flatten')
    .filter(o => !since || String(o.date || '') >= since)
    .map((o) => {
      const paid = o.finalPrice != null ? Number(o.finalPrice)
        : (o.fillPrice != null ? Number(o.fillPrice) : null);
      if (!Number.isFinite(paid)) return null;
      const s = broker.slipOf(o, { fillPrice: paid });
      if (!Number.isFinite(s.slip)) return null;
      return {
        date: o.date, symbol: o.symbol, action: o.action,
        decided: Number(o.price), paid,
        slip: s.slip, bps: Math.round(s.slipPct * 100),   // slipPct is percent
        slipR: s.slipR, plannedR: s.plannedR, realR: s.realR,
        // What it cost in money on the size that actually went out.
        dollars: Number.isFinite(o.quantity) ? s.slip * o.quantity : null,
        by: o.confirmedBy || null,
      };
    })
    .filter(Boolean);
}

const med = (xs) => {
  if (!xs.length) return null;
  const a = [...xs].sort((x, y) => x - y);
  return a.length % 2 ? a[(a.length - 1) / 2]
    : (a[a.length / 2 - 1] + a[a.length / 2]) / 2;
};

const r = (v, n = 2) => (Number.isFinite(v) ? Math.round(v * 10 ** n) / 10 ** n : v);

function main() {
  const args = process.argv.slice(2);
  const sinceAt = args.indexOf('--since');
  const since = sinceAt >= 0 ? args[sinceAt + 1] : null;
  const date = sinceAt >= 0 ? null : (args[0] || null);

  const rows = measured({ date, since });

  console.log(`\nENTRY SLIPPAGE — what the decision assumed vs what the tape gave`);
  console.log(`${broker.LEDGER}\n`);

  if (!rows.length) {
    /*
     * NO ROWS IS NOT A SLIPPAGE OF ZERO. On a paper account SignalStack sends
     * no callback at all, so an order can be sent, filled and never confirmed
     * on this side — and a confident "0 bps" from that is the same substitution
     * this desk keeps paying for.
     */
    console.log('No entry carries both a decision price and a fill price.');
    console.log('That is NOT a measurement of zero slippage — it is no measurement.');
    console.log('On a paper account SignalStack sends no callback, so the fills have');
    console.log('to come from the broker: run the desk\'s confirmFromFills (the');
    console.log('/api/broker/fills route) and try again.');
    return;
  }

  console.log('  date        symbol  side   decided      paid     slip    bps'
    + '     R    $ on size');
  for (const t of rows) {
    console.log(`  ${t.date}  ${String(t.symbol).padEnd(6)}  `
      + `${String(t.action).padEnd(5)}  ${String(r(t.decided, 4)).padStart(8)}  `
      + `${String(r(t.paid, 4)).padStart(8)}  ${String(r(t.slip, 4)).padStart(7)}  `
      + `${String(t.bps).padStart(5)}  ${String(t.slipR == null ? '—' : r(t.slipR)).padStart(5)}  `
      + `${t.dollars == null ? '—' : '$' + r(t.dollars, 0)}`);
  }

  const bps = rows.map(t => t.bps);
  const rs = rows.map(t => t.slipR).filter(Number.isFinite);
  const cost = Math.max(0, Math.round(med(bps)));

  console.log(`\n${rows.length} filled entr${rows.length === 1 ? 'y' : 'ies'}`
    + `   median ${med(bps)} bps`
    + (rs.length ? `   median ${r(med(rs))}R` : '   R not measurable on these rows'));

  /*
   * A MEDIAN OF TWO IS NOT A DISTRIBUTION, and saying so is the difference
   * between a measurement and a number that looks like one. The figure is
   * still better than the zero the backtest uses today — it is measured — but
   * it should not be presented as settled.
   */
  if (rows.length < 10) {
    console.log(`\nCAUTION: ${rows.length} fill(s) is not a distribution. Use this as the`);
    console.log('first honest estimate, not a settled number, and run it again as more');
    console.log('orders fill.');
  }

  console.log(`\nPUT ${cost} IN THE BACKTEST'S COST FIELD (bps per side).`);
  console.log('It is charged on entry AND exit, which is right: the exit is a market');
  console.log('order with the same delay behind it.');

  if (rs.length) {
    const mr = med(rs);
    console.log(`\nAnd read the R column, because that is the one that bites. A median`);
    console.log(`of ${r(mr)}R means the average trade starts ${r(mr)}R behind, and the stop`);
    console.log('does not move to meet it — so the position carries more risk than the');
    console.log('size was calculated for, and every target the broker holds is nearer');
    console.log('than its label says.');
  }
}

if (require.main === module) {
  try { main(); process.exit(0); } catch (err) {
    console.error('Failed:', err.stack || err.message);
    process.exit(1);
  }
}

module.exports = { measured, med };
