/*
 * The news test, and the reason it runs where it does.
 *
 * The unexplained-move screener asks TradingView for stocks that went 15% in
 * two hours. TradingView has no news column, so what comes back is every 15%
 * mover — and most of those moved because something happened. The setup is the
 * ones where nothing did.
 *
 * A card filter on the setup would be too late. By then the whole unfiltered
 * list is in r0, frozen into R1 the next morning, and in the training data.
 * Asked for plainly: the full list must not reach r0 or any other part of the
 * warehouse. So the gate sits between the scanner and the merge, and the names
 * that fail it are never recorded as candidates at all.
 */

const gate = require('../src/sideA/preR0');

const SCREENERS = [
  { name: 'Unexplained Move', key: 'unexplained-move' },
  { name: 'Unexplained Move (mirror)', key: 'unexplained-move-mirror' },
  { name: '20-Day Break', key: '20d-break' },
  { name: 'Gap + Volume', key: 'gap-volume' },
];

const row = ticker => ({ ticker, stock: { price: 3, tvSymbol: `NASDAQ:${ticker}` } });

/** A news lookup with a fixed answer per ticker. */
const feed = (map, fail = []) => async (ticker) => {
  if (fail.includes(ticker)) throw new Error('news API timed out');
  return { news: [], catalyst: map[ticker] || null };
};

// Six months of flat closes, then whatever the test wants.
const flat = (n = 200, px = 10) => Array.from({ length: n }, () => ({ c: px }));
const trending = (n, from, to) =>
  Array.from({ length: n }, (_, i) => ({ c: from + (to - from) * (i / (n - 1)) }));
const history = map => async tickers =>
  Object.fromEntries(tickers.filter(t => map[t]).map(t => [t, map[t]]));

/* Intraday bars: 3 hours of 1-minute closes that move `pct` over the last 2. */
const minuteBars = (pct, n = 180) => Array.from({ length: n }, (_, i) => ({
  t: new Date(Date.UTC(2026, 7, 17, 14, i)).toISOString(),
  c: 10 * (1 + (pct / 100) * Math.max(0, Math.min(1, (i - (n - 121)) / 120))),
}));
/* Every ticker asked for moved enough, unless named otherwise. */
const moved = (pct = 30, per = {}) => async tickers =>
  Object.fromEntries(tickers.map(t => [t, minuteBars(per[t] ?? pct)]));

describe('which screeners are gated', () => {
  test('the unexplained-move pair requires NO news', () => {
    expect(gate.gateFor('unexplained-move').news).toBe('none');
    expect(gate.gateFor('unexplained-move-mirror').news).toBe('none');
  });

  /*
   * And each side refuses a spike that AGREES with the trend it already had.
   */
  test('the up-spike refuses an uptrend, the down-spike refuses a downtrend', () => {
    expect(gate.gateFor('unexplained-move').trend).toBe('not-up');
    expect(gate.gateFor('unexplained-move-mirror').trend).toBe('not-down');
  });

  /*
   * The 20-day break WANTS a catalyst, and that stays a card filter on the
   * setup. Its news requirement is a preference — a break with something
   * behind it is a better break — and a preference belongs where it can be
   * changed per setup and where the names it removes are still recorded. Only
   * a screener whose PREMISE is the news test is worth a lookup per candidate
   * and worth keeping out of the archive.
   */
  test('the 20-day break is NOT gated here — its news rule is a preference', () => {
    expect(gate.gateFor('20d-break')).toBeNull();
  });

  test('an ordinary screener is not gated', () => {
    expect(gate.gateFor('gap-volume')).toBeNull();
    expect(gate.gateFor('')).toBeNull();
    expect(gate.gateFor(undefined)).toBeNull();
  });
});

describe('applying the gate', () => {
  test('only the names with nothing behind the move survive', async () => {
    const candidates = {
      'Unexplained Move': [row('QUIET'), row('NEWSY'), row('ALSOQUIET')],
    };
    const { candidates: out } = await gate.apply(candidates, SCREENERS, {
      intraday: moved(), closes: history({ QUIET: flat(), ALSOQUIET: flat(), NEWSY: flat() }),
      fetch: feed({ NEWSY: 'FDA approval' }),
    });
    expect(out['Unexplained Move'].map(r => r.ticker)).toEqual(['QUIET', 'ALSOQUIET']);
  });

  test('an ungated screener is passed through untouched, and costs nothing', async () => {
    const fetch = jest.fn(feed({}));
    const candidates = { 'Gap + Volume': [row('AAA'), row('BBB')] };
    const { candidates: out } = await gate.apply(candidates, SCREENERS, { intraday: moved(), closes: history({ AAA: flat(), BBB: flat() }), fetch });
    expect(out['Gap + Volume']).toHaveLength(2);
    expect(fetch).not.toHaveBeenCalled();
  });

  test('the mirror is gated the same way as the base', async () => {
    const { candidates: out } = await gate.apply(
      { 'Unexplained Move (mirror)': [row('QUIET'), row('NEWSY')] },
      SCREENERS, { intraday: moved(-30), closes: history({ QUIET: flat(), NEWSY: flat() }),
                   fetch: feed({ NEWSY: 'earnings' }) });
    expect(out['Unexplained Move (mirror)'].map(r => r.ticker)).toEqual(['QUIET']);
  });

  /*
   * THE ONE PLACE A FAILED LOOKUP DROPS THE ROW.
   *
   * Everywhere else in this pipeline a missing value means "cannot tell" and
   * the row survives, because losing a candidate to a flaky API is worse than
   * keeping a doubtful one. Here the whole premise is "nothing explains this
   * move", and "we could not find out" is not that — a name kept on a failed
   * lookup is a name whose news nobody checked, in a screener that exists to
   * find names with no news.
   */
  test('a failed lookup drops the stock, and says so', async () => {
    const { candidates: out, report } = await gate.apply(
      { 'Unexplained Move': [row('QUIET'), row('BROKEN')] },
      SCREENERS, { intraday: moved(), closes: history({ QUIET: flat(), BROKEN: flat() }),
                   fetch: feed({}, ['BROKEN']) });
    expect(out['Unexplained Move'].map(r => r.ticker)).toEqual(['QUIET']);
    expect(report.failed).toBe(1);
    expect(report.dropped).toBe(1);
  });

  test('one lookup per ticker, however many rows mention it', async () => {
    const fetch = jest.fn(feed({}));
    await gate.apply({ 'Unexplained Move': [row('AAA'), row('AAA'), row('BBB')] },
                     SCREENERS, { intraday: moved(), closes: history({ AAA: flat(), BBB: flat() }), fetch });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  test('the report says what went in and what came out', async () => {
    const { report } = await gate.apply(
      { 'Unexplained Move': [row('Q1'), row('Q2'), row('N1')] },
      SCREENERS, { intraday: moved(), closes: history({ Q1: flat(), Q2: flat(), N1: flat() }),
                   fetch: feed({ N1: 'merger' }) });
    expect(report.byScreener['Unexplained Move']).toMatchObject({ in: 3, out: 2 });
    expect(report.checked).toBe(3);
    expect(report.dropped).toBe(1);
  });

  test('an empty scan is not an error', async () => {
    const { candidates: out } = await gate.apply({}, SCREENERS, { intraday: moved(), closes: history({}), fetch: feed({}) });
    expect(out).toEqual({});
  });

  test('a screener the definition list does not know is left alone', async () => {
    const { candidates: out } = await gate.apply(
      { 'Something New': [row('AAA')] }, SCREENERS, { intraday: moved(), closes: history({}), fetch: feed({}) });
    expect(out['Something New']).toHaveLength(1);
  });
});

/*
 * The point of the whole file: what the warehouse is allowed to see.
 */
describe('what reaches the merge', () => {
  test('the unfiltered list never leaves this stage', async () => {
    const candidates = {
      'Unexplained Move': [row('QUIET'), row('NEWSY1'), row('NEWSY2'), row('NEWSY3')],
    };
    const before = candidates['Unexplained Move'].length;
    const { candidates: out } = await gate.apply(candidates, SCREENERS, {
      intraday: moved(), closes: history({ QUIET: flat(), NEWSY1: flat(), NEWSY2: flat(), NEWSY3: flat() }),
      fetch: feed({ NEWSY1: 'a', NEWSY2: 'b', NEWSY3: 'c' }),
    });
    expect(before).toBe(4);
    expect(out['Unexplained Move']).toHaveLength(1);
    // …and the three that moved on news are simply not in what goes forward.
    expect(JSON.stringify(out)).not.toContain('NEWSY');
  });
});

/*
 * THE CASE THAT KILLED THE SCREENER FILTER.
 *
 *   "What happens if it's flat for 6 months then at that specific day alone it
 *    rises 30%? I think the rising/falling filter will exclude it."
 *
 * It did. `Perf.6M` runs TO today's price, so the 30% spike lands inside the
 * six-month number and the stock reads as clearly rising — the measure meant to
 * be independent of the move is computed from it. Slower columns only shrink
 * the problem: one +30% day moves EMA50 by 1.18% and EMA120 by 0.50%, leaving a
 * flat stock reading as rising by two thirds of a percent, which is enough to
 * fail a comparison between them. There is no "as of yesterday" in the scanner
 * API, so the trend is read here instead, from closes that STOP BEFORE THE
 * MOVE.
 */
describe('the six-month trend, read from before the move', () => {
  test('FLAT FOR SIX MONTHS, THEN +30% TODAY — kept', async () => {
    // The closes end yesterday and are flat. Today's spike is not in them,
    // which is the whole point: it is the thing being explained, not evidence.
    const { candidates: out } = await gate.apply(
      { 'Unexplained Move': [row('FLAT')] },
      SCREENERS, { intraday: moved(), closes: history({ FLAT: flat(200, 10) }), fetch: feed({}) });
    expect(out['Unexplained Move'].map(r => r.ticker)).toEqual(['FLAT']);
  });

  test('...and the trend it measured is 0%, not 30%', async () => {
    const rows = [row('FLAT')];
    await gate.apply({ 'Unexplained Move': rows }, SCREENERS,
                     { intraday: moved(30), closes: history({ FLAT: flat(200, 10) }),
                       fetch: feed({}) });
    expect(rows[0].stock.trend6mPct).toBe(0);
    // …and the move it measured is the rolling two-hour one, not the candle's
    expect(rows[0].stock.move2hPct).toBe(30);
  });

  test('a stock that really was climbing is refused on the up-spike', async () => {
    const { candidates: out, report } = await gate.apply(
      { 'Unexplained Move': [row('RISER')] },
      SCREENERS, { intraday: moved(), closes: history({ RISER: trending(200, 10, 20) }), fetch: feed({}) });
    expect(out['Unexplained Move']).toEqual([]);
    expect(report.byScreener['Unexplained Move'].why.RISER).toMatch(/already trending up/);
  });

  /*
   * The case that started all this: six months into a decline, down again
   * today. Nothing unexplained about it, and no reason for it to bounce.
   */
  test('a stock six months into a decline is refused on the down-spike', async () => {
    const { candidates: out, report } = await gate.apply(
      { 'Unexplained Move (mirror)': [row('FALLER')] },
      SCREENERS, { intraday: moved(-30), closes: history({ FALLER: trending(200, 20, 10) }), fetch: feed({}) });
    expect(out['Unexplained Move (mirror)']).toEqual([]);
    expect(report.byScreener['Unexplained Move (mirror)'].why.FALLER)
      .toMatch(/already trending down/);
  });

  /* …but the OTHER side of each is fine: a faller that spikes UP is exactly
     the unexplained move, and so is a riser that suddenly drops. */
  test('a decline that spikes UP is the setup, not an exclusion', async () => {
    const { candidates: out } = await gate.apply(
      { 'Unexplained Move': [row('FALLER')] },
      SCREENERS, { intraday: moved(), closes: history({ FALLER: trending(200, 20, 10) }), fetch: feed({}) });
    expect(out['Unexplained Move'].map(r => r.ticker)).toEqual(['FALLER']);
  });

  test('a climb that suddenly drops is the setup too', async () => {
    const { candidates: out } = await gate.apply(
      { 'Unexplained Move (mirror)': [row('RISER')] },
      SCREENERS, { intraday: moved(-30), closes: history({ RISER: trending(200, 10, 20) }), fetch: feed({}) });
    expect(out['Unexplained Move (mirror)'].map(r => r.ticker)).toEqual(['RISER']);
  });

  /* Drift is allowed on both sides — "not clearly rising" is not "flat". */
  test('a drift inside the band passes either way', () => {
    for (const pct of [-19, -5, 0, 5, 19]) {
      expect(gate.trendPasses('not-up', pct)).toBe(true);
      expect(gate.trendPasses('not-down', pct)).toBe(true);
    }
    expect(gate.trendPasses('not-up', 21)).toBe(false);
    expect(gate.trendPasses('not-down', -21)).toBe(false);
    // …and each side only refuses ITS OWN direction
    expect(gate.trendPasses('not-up', -80)).toBe(true);
    expect(gate.trendPasses('not-down', 80)).toBe(true);
  });

  test('the trend is measured over six months of trading days', () => {
    expect(gate.TRADING_DAYS_6M).toBe(126);
    // exactly enough is enough; one short is not
    expect(gate.trendPct(flat(126))).toBe(0);
    expect(gate.trendPct(flat(125))).toBeNull();
  });

  /*
   * NO HISTORY IS A DROP, like a failed news lookup. A candidate that skipped
   * the safety layer is not the setup — it is the setup minus the part that
   * keeps you out of a falling knife.
   */
  test('a stock with no six-month history is dropped, and said so', async () => {
    const { candidates: out, report } = await gate.apply(
      { 'Unexplained Move': [row('NEWLY_LISTED')] },
      SCREENERS, { intraday: moved(), closes: history({ NEWLY_LISTED: flat(40) }), fetch: feed({}) });
    expect(out['Unexplained Move']).toEqual([]);
    expect(report.noHistory).toBe(1);
    expect(report.byScreener['Unexplained Move'].why.NEWLY_LISTED)
      .toMatch(/not enough history/);
  });

  test('a history source that throws does not empty the scan silently', async () => {
    const { report } = await gate.apply(
      { 'Unexplained Move': [row('AAA')] },
      SCREENERS, { intraday: moved(), closes: async () => { throw new Error('feed down'); }, fetch: feed({}) });
    // every row is dropped, but as "no history" — a counted, reported reason
    expect(report.noHistory).toBe(1);
  });
});

/*
 * THE MOVE IS A RATE, AND `change|120` WAS NOT ONE.
 *
 *   "You are measuring 30% but you are not measuring 2 hours. It's all about
 *    the acceleration, not just the jump itself."
 *
 * `change|120` is the change of the CURRENT 120-minute CANDLE, and those
 * candles are fixed: 09:30-11:30, 11:30-13:30, 13:30-15:30. At 11:35 it covers
 * five minutes; at 13:29 it covers a hundred and nineteen. The same stock
 * passed or failed a 15% test depending on when the scan ran — that is not a
 * rate. And a move STRADDLING a boundary was split in half, so the fastest
 * moves were the ones most likely to be missed.
 *
 * The window here ends NOW and slides.
 */
describe('the move is measured over a rolling two hours', () => {
  // 1-minute closes: flat, then `pct` travelled over the LAST 120 minutes.
  const over2h = pct => minuteBars(pct);
  // `pct` spread evenly across the whole session — a grind, not a jump.
  const grind = (pct, n = 360) => Array.from({ length: n }, (_, i) => ({
    t: new Date(Date.UTC(2026, 7, 17, 14, i)).toISOString(),
    c: 10 * (1 + (pct / 100) * (i / (n - 1))),
  }));

  test('a 30% jump inside the window is measured at 30%', () => {
    expect(gate.moveRatePct(over2h(30))).toBeCloseTo(30, 1);
  });

  /*
   * The distinction the whole screener rests on. Both stocks are up 15% —
   * one did it in two hours, the other took the whole day. Only the first is
   * an unexplained jump; the second is just a stock going up.
   */
  test('a SLOW +15% over six hours does NOT pass, though the day change does', () => {
    const slow = gate.moveRatePct(grind(15));
    expect(slow).toBeLessThan(6);                 // ~4.6% in any two hours
    expect(gate.movePasses('up', slow)).toBe(false);
    expect(gate.movePasses('up', gate.moveRatePct(over2h(15)))).toBe(true);
  });

  test('the window is the LAST two hours, not a fixed candle', () => {
    // Same total move, placed at the start of the session instead of the end:
    // by now it is outside the window and the stock is no longer accelerating.
    const early = Array.from({ length: 360 }, (_, i) => ({
      t: new Date(Date.UTC(2026, 7, 17, 14, i)).toISOString(),
      c: 10 * (1 + 0.30 * Math.min(1, i / 60)),   // all of it in the first hour
    }));
    expect(gate.moveRatePct(early)).toBeCloseTo(0, 1);
    expect(gate.moveRatePct(over2h(30))).toBeCloseTo(30, 1);
  });

  /*
   * THE STRADDLE, which is the failure that made change|120 unusable.
   *
   * A stock goes +30% from minute 90 to minute 150 of a session whose fixed
   * 2-hour candles break at minute 120. NEITHER candle ever shows the full
   * move — each holds about half of it — so a 15% test on the candle fails on
   * both, forever, no matter when it is run. The rolling window measured as the
   * move completes sees all 30%.
   */
  test('a move straddling a candle boundary: the candle never sees it, the window does', () => {
    const px = i => 10 * (1 + 0.30 * Math.max(0, Math.min(1, (i - 90) / 60)));
    const bars = Array.from({ length: 240 }, (_, i) => ({
      t: new Date(Date.UTC(2026, 7, 17, 14, i)).toISOString(), c: px(i),
    }));

    // What each FIXED 2-hour candle would report: open to close of that candle.
    const candle = (from, to) => ((px(to) - px(from)) / px(from)) * 100;
    expect(candle(0, 119)).toBeLessThan(15);        // ~14.5% — fails
    expect(candle(120, 239)).toBeLessThan(15);      // ~13.5% — fails
    // …so the biggest move of the day trips the threshold on neither candle.

    // The rolling window, measured as the move completes at minute 150.
    const rolling = gate.moveRatePct(bars.slice(0, 151));
    expect(rolling).toBeCloseTo(30, 1);
    expect(gate.movePasses('up', rolling)).toBe(true);
  });

  test('not enough bars to cover the window is "cannot say", not zero', () => {
    expect(gate.moveRatePct(minuteBars(30, 40))).toBeNull();
    expect(gate.movePasses('up', null)).toBeNull();
  });

  test('each side only accepts its own direction', () => {
    expect(gate.movePasses('up', 30)).toBe(true);
    expect(gate.movePasses('up', -30)).toBe(false);
    expect(gate.movePasses('down', -30)).toBe(true);
    expect(gate.movePasses('down', 30)).toBe(false);
    expect(gate.movePasses('up', 14.9)).toBe(false);
    expect(gate.movePasses('up', 15)).toBe(true);
  });

  test('the window and the threshold are the ones asked for', () => {
    expect(gate.MOVE_WINDOW_MIN).toBe(120);
    expect(gate.MOVE_PCT).toBe(15);
  });

  /* End to end: a grind is dropped, and the reason names the rate. */
  test('a stock that only ground its way up is dropped, with the number', async () => {
    const { candidates: out, report } = await gate.apply(
      { 'Unexplained Move': [row('GRIND')] }, SCREENERS,
      { intraday: async () => ({ GRIND: grind(15) }),
        closes: history({ GRIND: flat() }), fetch: feed({}) });
    expect(out['Unexplained Move']).toEqual([]);
    expect(report.tooSlow).toBe(1);
    expect(report.byScreener['Unexplained Move'].why.GRIND)
      .toMatch(/only 4\.\d% over 120 minutes/);
  });

  /*
   * The move is checked FIRST. Everything after it costs a request per
   * surviving name, so a stock that did not accelerate must never reach the
   * news lookup at all.
   */
  test('a stock that did not move is never looked up', async () => {
    const fetch = jest.fn(feed({}));
    await gate.apply({ 'Unexplained Move': [row('GRIND')] }, SCREENERS,
                     { intraday: async () => ({ GRIND: grind(15) }),
                       closes: history({ GRIND: flat() }), fetch });
    expect(fetch).not.toHaveBeenCalled();
  });
});
