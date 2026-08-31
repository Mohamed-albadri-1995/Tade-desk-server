/*
 * DID IT DO WHAT THE BACKTEST SAID IT WOULD?
 *
 * The last question in the loop, and the one nothing answered:
 *
 *   make a strategy → test it → decide it is good → apply it → GET SIMILAR
 *   RESULTS
 *
 * parity.js compares the SETTINGS the two sides run with. This compares the
 * OUTCOMES: the trades the backtest took over a period against the trades the
 * desk actually took, name by name, day by day.
 *
 * WHY NAME-BY-NAME AND NOT JUST P&L. Two books can end at the same number for
 * opposite reasons, and two that end differently can differ for reasons needing
 * opposite fixes:
 *
 *   SAME NAMES, different money   the selection agreed and the EXECUTION cost
 *                                 the difference — slippage, a late exit, a
 *                                 stop that filled worse than its level.
 *                                 Fixable at the desk.
 *
 *   DIFFERENT NAMES               the two sides did not agree on what to trade.
 *                                 No execution work fixes that; something about
 *                                 the DECISION differs, and parity.js is where
 *                                 to look.
 *
 * A P&L difference alone cannot tell those apart, which is why `verdict` is
 * computed before any money and the money is reported last.
 */

/** Matched on date + SYMBOL. */
const key = (date, sym) => `${date} ${String(sym || '').toUpperCase()}`;

/*
 * NOT ON TIME. The whole point of the exercise is that the two sides may have
 * entered at different moments — that difference is what is being measured — so
 * a match requiring the same second would report every trade as unmatched and
 * hide the thing it was built to show.
 */
function compareOutcome({ backtestTrades = [], liveTrades = [],
                          covered = null, account = null,
                          accountBlock = null } = {}) {
  /*
   * ONLY THE SESSIONS THE BACKTEST ACTUALLY COVERED.
   *
   * A register backtest can only evaluate days the screener froze, so the range
   * typed into the form is not the range that was tested. Comparing live days
   * the backtest never saw reports every one of them as "live only" — a
   * frightening number that means nothing.
   */
  const days = covered && covered.length ? new Set(covered) : null;
  const live = liveTrades
    .filter(t => !account || t.account === account)
    .filter(t => !days || days.has(t.date));
  const bt = backtestTrades.filter(t => !days || days.has(t.date));

  const btBy = new Map();
  for (const t of bt) btBy.set(key(t.date, t.symbol), t);
  const liveBy = new Map();
  for (const t of live) liveBy.set(key(t.date, t.ticker), t);

  const both = [];
  const btOnly = [];
  const liveOnly = [];
  for (const [k, t] of btBy) {
    if (liveBy.has(k)) both.push({ key: k, backtest: t, live: liveBy.get(k) });
    else btOnly.push({ key: k, backtest: t });
  }
  for (const [k, t] of liveBy) if (!btBy.has(k)) liveOnly.push({ key: k, live: t });

  /*
   * AGREEMENT is measured against the LARGER book, not against the backtest.
   * Divided by the backtest's count, a desk that took ten extra trades would
   * score 100% agreement while trading a completely different day.
   */
  const largest = Math.max(bt.length, live.length);
  const agreement = largest ? both.length / largest : 0;

  // THE ENTRY GAP, on the trades both sides took — the only population where a
  // price comparison means anything, because the name and the day are the same.
  const gaps = [];
  for (const x of both) {
    const be = Number(x.backtest.entry);
    const le = Number(x.live.entryPrice);
    if (!(be > 0) || !(le > 0)) continue;
    /*
     * SIGNED SO POSITIVE IS ALWAYS WORSE, whichever way the trade faces. A
     * short filled HIGHER is better; unsigned it would read as a cost, and the
     * average of a long book and a short book would cancel to nothing.
     */
    const short = String(x.backtest.side || x.live.direction || '')
      .toLowerCase().startsWith('s');
    const pct = ((le - be) / be) * 100 * (short ? -1 : 1);
    gaps.push({ key: x.key, pct: Math.round(pct * 1000) / 1000,
                backtest: be, live: le });
  }
  gaps.sort((a, b) => b.pct - a.pct);
  const entryGapPct = gaps.length
    ? Math.round((gaps.reduce((n, g) => n + g.pct, 0) / gaps.length) * 1000) / 1000
    : null;

  /*
   * THE MONEY, LAST. Live dollars come from CLOSED trades only: an open one has
   * a number that is not a result yet, and counting it would make a book look
   * finished that is not.
   */
  let liveNet = 0;
  let liveClosed = 0;
  for (const t of live) {
    if (t.status !== 'closed') continue;
    const e = Number(t.entryPrice);
    const x = Number(t.exitPrice);
    const q = Number(t.shares);
    if (!(e > 0) || !(x > 0) || !(q > 0)) continue;
    const short = String(t.direction || '').toLowerCase().startsWith('s');
    liveNet += (short ? e - x : x - e) * q;
    liveClosed += 1;
  }
  const btNet = accountBlock && typeof accountBlock.net_pnl_usd === 'number'
    ? accountBlock.net_pnl_usd : null;

  /*
   * THE VERDICT, and it is about SELECTION rather than money. If the two sides
   * did not agree on what to trade, every dollar below is a comparison between
   * two different books and says nothing about execution.
   */
  let verdict;
  if (!both.length) verdict = 'no-overlap';
  else if (agreement < 0.8) verdict = 'selection-differs';
  else verdict = 'selection-agrees';

  return {
    counts: { backtest: bt.length, live: live.length,
              both: both.length, btOnly: btOnly.length, liveOnly: liveOnly.length },
    agreement: Math.round(agreement * 1000) / 1000,
    verdict,
    both, btOnly, liveOnly,
    entryGapPct,
    worstEntries: gaps.slice(0, 5),
    money: {
      backtest: btNet,
      live: Math.round(liveNet * 100) / 100,
      liveClosed,
      liveOpen: live.length - liveClosed,
      // Only meaningful when the selection agreed — said here rather than left
      // for the reader to remember.
      gap: btNet !== null && liveClosed
        ? Math.round((liveNet - btNet) * 100) / 100 : null,
      gapIsExecution: verdict === 'selection-agrees',
    },
  };
}

module.exports = { compareOutcome, key };
