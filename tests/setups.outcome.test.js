/*
 * DID IT DO WHAT THE BACKTEST SAID IT WOULD?
 *
 * The last question in the loop, and the one nothing answered:
 *
 *   make a strategy → test it → decide it is good → apply it → GET SIMILAR
 *   RESULTS
 *
 * parity.js compares the SETTINGS. This compares the OUTCOMES. The distinction
 * it exists to draw is the whole value of it:
 *
 *   SAME NAMES, different money   the selection agreed and the EXECUTION cost
 *                                 the difference. Fixable at the desk.
 *   DIFFERENT NAMES               the two sides did not agree on what to trade.
 *                                 No execution work fixes that.
 *
 * A P&L difference alone cannot tell those apart, and a tool that reported only
 * the dollars would send you to fix the wrong thing.
 */

const { compareOutcome } = require('../src/setups/outcome');

const BT = (date, symbol, entry, side = 'long') => ({ date, symbol, entry, side });
const LIVE = (date, ticker, entryPrice, extra = {}) => ({
  date, ticker, entryPrice, direction: 'Long', shares: 100,
  status: 'closed', exitPrice: entryPrice, ...extra,
});

const DATES = ['2026-08-18', '2026-08-19', '2026-08-20'];

describe('matching the two books', () => {
  /*
   * MATCHED ON DATE + SYMBOL, NEVER ON TIME. The whole point is that the two
   * sides may have entered at different moments — that difference is what is
   * being measured — so a match requiring the same second would report every
   * trade as unmatched and hide the thing this was built to show.
   */
  test('the same name on the same day is one trade, whatever the time', () => {
    const r = compareOutcome({
      backtestTrades: [BT('2026-08-19', 'WULF', 15.45)],
      liveTrades: [LIVE('2026-08-19', 'WULF', 15.37, { entryTime: '09:36:02' })],
      covered: DATES,
    });
    expect(r.counts.both).toBe(1);
    expect(r.counts.btOnly).toBe(0);
    expect(r.counts.liveOnly).toBe(0);
  });

  test('the same name on a DIFFERENT day is two trades', () => {
    const r = compareOutcome({
      backtestTrades: [BT('2026-08-18', 'WULF', 15)],
      liveTrades: [LIVE('2026-08-19', 'WULF', 15)],
      covered: DATES,
    });
    expect(r.counts.both).toBe(0);
    expect(r.counts.btOnly).toBe(1);
    expect(r.counts.liveOnly).toBe(1);
  });

  test('case does not decide whether two trades are the same', () => {
    const r = compareOutcome({
      backtestTrades: [BT('2026-08-19', 'wulf', 15)],
      liveTrades: [LIVE('2026-08-19', 'WULF', 15)],
      covered: DATES,
    });
    expect(r.counts.both).toBe(1);
  });

  /*
   * ONLY THE SESSIONS THE BACKTEST COVERED. A register backtest can evaluate
   * only days the screener froze, so the range typed into the form is not the
   * range tested. Comparing live days the backtest never saw reports every one
   * as "live only" — a frightening number that means nothing.
   */
  test('a live day the backtest never covered is excluded, not counted against it', () => {
    const r = compareOutcome({
      backtestTrades: [BT('2026-08-19', 'WULF', 15)],
      liveTrades: [LIVE('2026-08-19', 'WULF', 15), LIVE('2026-08-25', 'FCX', 40)],
      covered: ['2026-08-19'],
    });
    expect(r.counts.live).toBe(1);
    expect(r.counts.liveOnly).toBe(0);
  });

  test('with no covered list, everything given is compared', () => {
    const r = compareOutcome({
      backtestTrades: [BT('2026-08-19', 'WULF', 15)],
      liveTrades: [LIVE('2026-08-19', 'WULF', 15), LIVE('2026-08-25', 'FCX', 40)],
    });
    expect(r.counts.live).toBe(2);
    expect(r.counts.liveOnly).toBe(1);
  });

  test('one account can be looked at alone', () => {
    const r = compareOutcome({
      backtestTrades: [BT('2026-08-19', 'WULF', 15)],
      liveTrades: [LIVE('2026-08-19', 'WULF', 15, { account: 'paperA' }),
                   LIVE('2026-08-19', 'FCX', 40, { account: 'paperB' })],
      covered: DATES,
      account: 'paperA',
    });
    expect(r.counts.live).toBe(1);
    expect(r.counts.both).toBe(1);
  });
});

describe('the verdict, which is about SELECTION not money', () => {
  const three = ['AAA', 'BBB', 'CCC'];

  test('the same three names: selection agrees', () => {
    const r = compareOutcome({
      backtestTrades: three.map(s => BT('2026-08-19', s, 10)),
      liveTrades: three.map(s => LIVE('2026-08-19', s, 10)),
      covered: DATES,
    });
    expect(r.verdict).toBe('selection-agrees');
    expect(r.agreement).toBe(1);
  });

  test('one name in common out of three: selection differs', () => {
    const r = compareOutcome({
      backtestTrades: three.map(s => BT('2026-08-19', s, 10)),
      liveTrades: ['AAA', 'XXX', 'YYY'].map(s => LIVE('2026-08-19', s, 10)),
      covered: DATES,
    });
    expect(r.verdict).toBe('selection-differs');
  });

  test('nothing in common is its own answer, not just a low score', () => {
    const r = compareOutcome({
      backtestTrades: three.map(s => BT('2026-08-19', s, 10)),
      liveTrades: ['XXX'].map(s => LIVE('2026-08-19', s, 10)),
      covered: DATES,
    });
    expect(r.verdict).toBe('no-overlap');
  });

  /*
   * AGREEMENT IS MEASURED AGAINST THE LARGER BOOK. Divided by the backtest's
   * count, a desk that took ten extra trades would score 100% agreement while
   * trading a completely different day.
   */
  test('a desk that took EXTRA trades does not score full agreement', () => {
    const r = compareOutcome({
      backtestTrades: [BT('2026-08-19', 'AAA', 10)],
      liveTrades: ['AAA', 'BBB', 'CCC', 'DDD'].map(s => LIVE('2026-08-19', s, 10)),
      covered: DATES,
    });
    expect(r.agreement).toBe(0.25);
    expect(r.verdict).toBe('selection-differs');
  });
});

describe('the entry gap, on the shared trades only', () => {
  /*
   * SIGNED SO POSITIVE IS ALWAYS WORSE, whichever way the trade faces. A short
   * filled HIGHER is better; unsigned it would read as a cost, and the average
   * of a long book and a short book would cancel to nothing.
   */
  test('a long filled higher than the backtest is worse', () => {
    const r = compareOutcome({
      backtestTrades: [BT('2026-08-19', 'AAA', 100, 'long')],
      liveTrades: [LIVE('2026-08-19', 'AAA', 101)],
      covered: DATES,
    });
    expect(r.entryGapPct).toBe(1);
  });

  test('a SHORT filled higher than the backtest is BETTER', () => {
    const r = compareOutcome({
      backtestTrades: [BT('2026-08-19', 'AAA', 100, 'short')],
      liveTrades: [LIVE('2026-08-19', 'AAA', 101, { direction: 'Short' })],
      covered: DATES,
    });
    expect(r.entryGapPct).toBe(-1);
  });

  // The failure this guards: a long and a short each a point worse would
  // average to zero if the sign were taken from the raw price move.
  test('a long and a short, both a point worse, average to a point worse', () => {
    const r = compareOutcome({
      backtestTrades: [BT('2026-08-19', 'AAA', 100, 'long'),
                       BT('2026-08-19', 'BBB', 100, 'short')],
      liveTrades: [LIVE('2026-08-19', 'AAA', 101),
                   LIVE('2026-08-19', 'BBB', 99, { direction: 'Short' })],
      covered: DATES,
    });
    expect(r.entryGapPct).toBe(1);
  });

  test('the worst are listed first, so the outlier is visible', () => {
    const r = compareOutcome({
      backtestTrades: [BT('2026-08-19', 'AAA', 100), BT('2026-08-19', 'BBB', 100)],
      liveTrades: [LIVE('2026-08-19', 'AAA', 100.1), LIVE('2026-08-19', 'BBB', 105)],
      covered: DATES,
    });
    expect(r.worstEntries[0].key).toContain('BBB');
  });

  test('no shared trades means no gap, rather than a zero', () => {
    const r = compareOutcome({
      backtestTrades: [BT('2026-08-19', 'AAA', 100)],
      liveTrades: [LIVE('2026-08-19', 'ZZZ', 100)],
      covered: DATES,
    });
    // Zero would read as "the execution was perfect" on a comparison that
    // never happened.
    expect(r.entryGapPct).toBeNull();
  });
});

describe('the money, and what it is allowed to claim', () => {
  /*
   * AN OPEN TRADE HAS A NUMBER THAT IS NOT A RESULT YET. Counting it would make
   * a book look finished that is not.
   */
  test('only closed trades count towards the live figure', () => {
    const r = compareOutcome({
      backtestTrades: [BT('2026-08-19', 'AAA', 10)],
      liveTrades: [
        LIVE('2026-08-19', 'AAA', 10, { exitPrice: 11, shares: 100 }),
        LIVE('2026-08-19', 'BBB', 10, { status: 'open', exitPrice: null }),
      ],
      covered: DATES,
    });
    expect(r.money.live).toBe(100);
    expect(r.money.liveClosed).toBe(1);
    expect(r.money.liveOpen).toBe(1);
  });

  test('a short makes money when it exits lower', () => {
    const r = compareOutcome({
      backtestTrades: [],
      liveTrades: [LIVE('2026-08-19', 'AAA', 10,
                        { direction: 'Short', exitPrice: 9, shares: 100 })],
      covered: DATES,
    });
    expect(r.money.live).toBe(100);
  });

  /*
   * THE GAP IS ONLY EXECUTION WHEN THE SELECTION AGREED. Said as a field rather
   * than left for the reader to remember, because the dollars are the number
   * everyone reads first and the one that says least on its own.
   */
  test('the gap is flagged as execution when the names matched', () => {
    const r = compareOutcome({
      backtestTrades: [BT('2026-08-19', 'AAA', 10)],
      liveTrades: [LIVE('2026-08-19', 'AAA', 10, { exitPrice: 11, shares: 100 })],
      covered: DATES,
      accountBlock: { net_pnl_usd: 120 },
    });
    expect(r.money.gap).toBe(-20);
    expect(r.money.gapIsExecution).toBe(true);
  });

  test('...and NOT flagged as execution when they did not', () => {
    const r = compareOutcome({
      backtestTrades: [BT('2026-08-19', 'AAA', 10), BT('2026-08-19', 'BBB', 10),
                       BT('2026-08-19', 'CCC', 10)],
      liveTrades: [LIVE('2026-08-19', 'ZZZ', 10, { exitPrice: 11, shares: 100 })],
      covered: DATES,
      accountBlock: { net_pnl_usd: 120 },
    });
    expect(r.money.gapIsExecution).toBe(false);
  });

  // A run with no account block was never sized, so it has no dollars to
  // compare — and inventing a figure would be worse than saying so.
  test('an unsized backtest reports no money and no gap', () => {
    const r = compareOutcome({
      backtestTrades: [BT('2026-08-19', 'AAA', 10)],
      liveTrades: [LIVE('2026-08-19', 'AAA', 10, { exitPrice: 11 })],
      covered: DATES,
    });
    expect(r.money.backtest).toBeNull();
    expect(r.money.gap).toBeNull();
  });
});

describe('the empty cases', () => {
  test('nothing at all is not a crash', () => {
    const r = compareOutcome({});
    expect(r.counts).toEqual({ backtest: 0, live: 0, both: 0, btOnly: 0, liveOnly: 0 });
    expect(r.verdict).toBe('no-overlap');
    expect(r.agreement).toBe(0);
  });

  // A backtest that took trades against a desk that took none is the shape of
  // "the setup never fired live", and it must not read as agreement.
  test('a backtest with trades and a silent desk is no-overlap', () => {
    const r = compareOutcome({
      backtestTrades: [BT('2026-08-19', 'AAA', 10)],
      liveTrades: [],
      covered: DATES,
    });
    expect(r.verdict).toBe('no-overlap');
    expect(r.counts.btOnly).toBe(1);
  });
});
