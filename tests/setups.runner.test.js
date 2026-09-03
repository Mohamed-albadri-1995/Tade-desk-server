/*
 * Turning a setup's picks into alerts that arrive.
 *
 * The runner no longer decides anything. The strategy is a qp seed built from
 * qp primitives and the ranking is chart/decide.py, using the same metric a
 * backtest uses — so what is tested here is the part that is genuinely this
 * side's: hand the card list over, and turn what comes back into something a
 * person can act on from a phone.
 *
 * The property that matters most is that a run ALWAYS says something. From a
 * phone, "nothing qualified", "the platform was down" and "the process was
 * dead" all look identical: an empty feed. So each produces its own line.
 */

const os = require('os');
const path = require('path');
const fs = require('fs');

const FIRES = path.join(os.tmpdir(), `setup-fires-${process.pid}.json`);
process.env.ALERT_FIRES_FILE = FIRES;
process.env.TOOL_ID = 'T2';
process.env.TOOL_NAME = 'Momentum';

jest.mock('../src/setups/qpClient');
/*
 * The catalogue is mocked so a test can hand the runner exactly the setups it
 * wants — but `withinWindow` is a pure predicate, not a data source, and an
 * auto-mocked version returns undefined. That silently filtered EVERY setup
 * out and three tests failed on "cannot read properties of undefined",
 * nowhere near the cause. Data is mocked; arithmetic is not.
 */
jest.mock('../src/setups/catalog', () => ({
  ...jest.createMockFromModule('../src/setups/catalog'),
  withinWindow: jest.requireActual('../src/setups/catalog').withinWindow,
}));
jest.mock('../src/r0/registry', () => ({ getTodayRows: jest.fn(() => []) }));

const qp = require('../src/setups/qpClient');
const catalog = require('../src/setups/catalog');
const r0 = require('../src/r0/registry');
const runner = require('../src/setups/runner');
const store = require('../src/alerts/store');

/*
 * A setup as the catalog builds it from qp: the strategy carries its tools and
 * its decision time, so neither is retyped here.
 */
const SETUP = {
  id: 'T2 10:00 VWAP Extension@10:00',
  name: 'T2 10:00 VWAP Extension',
  strategyId: 'T2 10:00 VWAP Extension',
  tools: ['T2'],
  decisionTime: '10:00',
  universeScanAt: '09:58',
  rank: { metric: 'vwap_extension', topN: 2 },
  tf: '1m', feed: 'yahoo', targetR: 2.0, fill: 'close',
  caution: 'Backtest it in qp before trusting it live — not a validated edge.',
};
const DATE = '2026-08-10';

/*
 * One pick in the shape chart/decide.py returns. The numbers are qp's — which
 * is the point: this side re-derives none of them.
 */
function pick(symbol, { side = 'long', entry = 29.05, stop = 27.68,
                        metric = 4.949, at = '10:00' } = {}) {
  const risk = Math.abs(entry - stop);
  return {
    symbol, side, entry, stop, metric, entry_at: at, rank: 1,
    risk, risk_pct: (risk / entry) * 100,
    target: side === 'long' ? entry + 2 * risk : entry - 2 * risk,
    target_r: 2.0,
  };
}

/** What qp answered. Everything the runner reports flows from this. */
function decided(picks, extra = {}) {
  qp.decide.mockResolvedValue({
    ok: true, date: DATE, feed: 'yahoo', tf: '1m',
    universe: picks.length, picks, candidates: picks, errors: [],
    counts: { evaluated: picks.length, signalled: picks.length, errored: 0 },
    ...extra,
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  try { fs.unlinkSync(FIRES); } catch { /* absent */ }
  r0.getTodayRows.mockReturnValue([{ ticker: 'LIFE' }, { ticker: 'LSCC' }]);
  // The catalog is read live from qp, so runDue asks it every time.
  catalog.forTool.mockResolvedValue([SETUP]);
});
afterAll(() => { try { fs.unlinkSync(FIRES); } catch { /* absent */ } });

describe('the decision bar', () => {
  test('is the minute before the decision time', () => {
    expect(runner.lastWantedBar('10:00')).toBe('09:59');
    expect(runner.lastWantedBar('09:35')).toBe('09:34');
  });
});

describe('what it asks qp for', () => {
  test('the card list, the setup\'s strategy, and its ranking', async () => {
    decided([]);
    await runner.runSetup(SETUP, { date: DATE });
    expect(qp.decide).toHaveBeenCalledWith(expect.objectContaining({
      strategyId: SETUP.strategyId,
      symbols: ['LIFE', 'LSCC'],
      date: DATE,
      tf: '1m',
      topN: 2,
    }));
  });

  /*
   * Yahoo, and this is not a default worth losing. Polygon's free plan is a day
   * behind, so at 10:00 it holds yesterday; alpaca's free tier is IEX.
   */
  test('on the feed that can actually serve a live decision', async () => {
    decided([]);
    await runner.runSetup(SETUP, { date: DATE });
    expect(qp.decide).toHaveBeenCalledWith(expect.objectContaining({ feed: 'yahoo' }));
  });

  test('an empty card list asks qp nothing at all', async () => {
    r0.getTodayRows.mockReturnValue([]);
    await runner.runSetup(SETUP, { date: DATE });
    expect(qp.decide).not.toHaveBeenCalled();
    expect(store.recentFires(DATE)[0].detail).toMatch(/No cards on the list/);
  });
});

describe('a run that finds trades', () => {
  test('publishes one alert per pick, carrying qp\'s numbers unchanged', async () => {
    decided([pick('LIFE'), pick('LSCC', { entry: 129.56, stop: 126.08, metric: 2.76 })]);
    const out = await runner.runSetup(SETUP, { date: DATE });

    expect(out.picks.map(p => p.ticker)).toEqual(['LIFE', 'LSCC']);
    const f = store.recentFires(DATE).find(x => x.ticker === 'LIFE');
    expect(f.setup.signal).toBe('LONG');
    expect(f.setup.entry).toBe(29.05);
    expect(f.setup.stop).toBe(27.68);        // the stop IS the frozen VWAP
    expect(f.setup.extension).toBe(4.949);
    expect(f.setup.target).toBeCloseTo(31.79, 2);
  });

  /*
   * The notification body is all a phone shows. It has to carry the four things
   * needed to place the trade without opening anything.
   */
  test('the text says direction, price, stop and target', async () => {
    decided([pick('LIFE')]);
    const detail = (await runner.runSetup(SETUP, { date: DATE })).fires[0].detail;
    expect(detail).toMatch(/^BUY .*LIFE/);
    // The FACTS, not the wording. "(VWAP, fixed)" was asserted here, and it is
    // a property of the T2 VWAP-extension strategy rather than of a setup —
    // pinning it is the same assumption that made describePick throw on the
    // first setup with a different shape.
    expect(detail).toMatch(/stop [\d.]+/);
    expect(detail).toMatch(/target [\d.]+/);
  });

  /*
   * THE LINE THAT KILLED A LIVE MORNING.
   *
   * describePick called .toFixed() on the target and the extension without
   * checking either. `Test` has its take-profit OFF — its targets are
   * scale-out legs — so qp returns target: null, and the call threw INSIDE the
   * runner. The whole run died: every minute of a two-hour window published
   * "Did not run: Cannot read properties of null (reading 'toFixed')" and no
   * alert, no order and no pick ever came out of a setup that was working.
   *
   * A description is the last thing that should be able to stop a trade.
   */
  test('a pick with NO target does not throw — it says so instead', async () => {
    decided([{ ...pick('LIFE'), target: null, target_r: null, metric: null }]);
    const out = await runner.runSetup(SETUP, { date: DATE });
    expect(out.ok).toBe(true);
    expect(out.fires[0].detail).toMatch(/^BUY .*LIFE/);
    expect(out.fires[0].detail).toMatch(/no fixed target/);
  });

  test('a pick with no stop, no risk and no metric still describes itself', async () => {
    decided([{ symbol: 'LIFE', side: 'long', entry: 29.05, stop: null, metric: null,
               entry_at: '10:00', rank: 1, risk: null, risk_pct: null,
               target: null, target_r: null }]);
    const out = await runner.runSetup(SETUP, { date: DATE });
    expect(out.ok).toBe(true);
    expect(String(out.fires[0].detail)).toMatch(/LIFE/);
  });

  test('the VWAP wording only appears when there IS an extension', async () => {
    decided([{ ...pick('LIFE'), metric: null }]);
    const out = await runner.runSetup(SETUP, { date: DATE });
    expect(out.fires[0].detail).not.toMatch(/from VWAP/);
  });

  test('a short reads as SHORT, not BUY', async () => {
    decided([pick('BBNX', { side: 'short', entry: 13.77, stop: 14.36, metric: 4.28 })]);
    expect((await runner.runSetup(SETUP, { date: DATE })).fires[0].detail)
      .toMatch(/^SHORT /);
  });

  test('the caution travels with the trade, not just the documentation', async () => {
    decided([pick('LIFE')]);
    await runner.runSetup(SETUP, { date: DATE });
    expect(store.recentFires(DATE)[0].setup.caution).toMatch(/not a validated edge/i);
  });
});

/*
 * Silence is the enemy. Each of these is a different situation and each has to
 * be distinguishable from the others in the feed.
 */
describe('a run that finds nothing still says so', () => {
  test('nothing qualified, with the counts behind it', async () => {
    decided([], { counts: { evaluated: 34, signalled: 0, errored: 0 } });
    await runner.runSetup(SETUP, { date: DATE });
    const fires = store.recentFires(DATE);
    expect(fires).toHaveLength(1);
    expect(fires[0].level).toBe('info');
    expect(fires[0].detail).toMatch(/Nothing qualified/);
    expect(fires[0].detail).toMatch(/34 evaluated/);
  });

  test('symbols qp could not evaluate are named — the ranking was over fewer', async () => {
    decided([pick('LIFE')], {
      errors: [{ symbol: 'GONE', error: 'no bars' }, { symbol: 'ALSOGONE', error: 'no bars' }],
    });
    await runner.runSetup(SETUP, { date: DATE });
    const warn = store.recentFires(DATE).find(f => f.level === 'warn');
    expect(warn.detail).toMatch(/GONE, ALSOGONE/);
  });

  /*
   * qp being down is the failure this architecture introduced, so it is the one
   * that most needs to be loud. A missing platform must not look like a quiet
   * morning.
   */
  test('the platform being unreachable is published, not swallowed', async () => {
    qp.decide.mockRejectedValue(new Error('connect ECONNREFUSED 127.0.0.1:8765'));
    await runner.runDue('10:00', { date: DATE });
    const err = store.recentFires(DATE).find(f => f.level === 'error');
    expect(err.detail).toMatch(/connect ECONNREFUSED/);
  });

  test('and so is qp answering that it could not decide', async () => {
    qp.decide.mockRejectedValue(new Error("no strategy for 'T2 10:00 VWAP Extension'"));
    await runner.runDue('10:00', { date: DATE });
    expect(store.recentFires(DATE).find(f => f.level === 'error').detail)
      .toMatch(/no strategy for/);
  });

  /*
   * A CLOCK SETUP THAT FAILS HAS LOST THE DAY. On 2026-09-03 `OR + VWAP 09:35`
   * timed out on its single attempt and the alert said "Did not run" — the same
   * sentence a watch setup gets when it will be asked again in sixty seconds.
   * Only one of the two needs looking at before tomorrow.
   */
  test('a CLOCK setup that fails says it missed the window, not that it was late',
    async () => {
      qp.decide.mockRejectedValue(new Error('timeout of 18000ms exceeded'));
      const out = await runner.runDue('10:00', { date: DATE });
      const err = store.recentFires(DATE).find(f => f.level === 'error');
      expect(err.detail).toMatch(/MISSED THE 10:00 WINDOW/);
      expect(err.detail).toMatch(/no later attempt today/);
      expect(out[0].missedWindow).toBe(true);
    });

  test('a WATCH setup that fails does NOT — it is asked again next minute',
    async () => {
      catalog.forTool.mockResolvedValue([{
        ...SETUP, id: 'PML@09:40', name: 'PML breakout',
        decisionTime: '09:40', windowEnd: '10:10', watch: true,
      }]);
      qp.decide.mockRejectedValue(new Error('timeout of 18000ms exceeded'));
      const out = await runner.runDue('09:45', { date: DATE });
      const err = store.recentFires(DATE).find(f => f.level === 'error');
      expect(err.detail).toMatch(/Did not run on the 09:45 bar/);
      expect(err.detail).not.toMatch(/MISSED/);
      expect(out[0].missedWindow).toBe(false);
    });
});

/*
 * ONE SETUP'S MINUTE IS NOT ANOTHER'S TO SPEND.
 *
 * 2026-09-03, both deciding on the 09:34 bar:
 *
 *     Test              1744ms
 *     OR + VWAP 09:35  45050ms   FAILED — timeout
 *
 * Run in turn, the slow one holds the tick for forty-five seconds — and a
 * setup entering on the 09:35 open has sixty in total. Reverse the order and
 * the fast one places a market order most of a minute after its decision bar.
 */
describe('setups on the same bar do not queue behind each other', () => {
  test('they are asked at the same time, not one after the other', async () => {
    const OTHER = { ...SETUP, id: 'Other@10:00', name: 'Other',
                    strategyId: 'Other' };
    catalog.forTool.mockResolvedValue([SETUP, OTHER]);
    const started = [];
    let release;
    const held = new Promise((r) => { release = r; });
    qp.decide.mockImplementation(async (args) => {
      started.push(args.strategyId || args.strategies);
      // The FIRST call blocks. If the second only starts after it resolves,
      // `started` holds one entry when we look — which is the bug.
      if (started.length === 1) await held;
      return { ok: true, picks: [], counts: {} };
    });
    const run = runner.runDue('10:00', { date: DATE });
    // Let the microtask queue drain so a concurrent second call can be made.
    await new Promise(r => setImmediate(r));
    expect(started).toHaveLength(2);
    release();
    await run;
  });

  test('one setup failing does not stop the other from being decided',
    async () => {
      const OTHER = { ...SETUP, id: 'Other@10:00', name: 'Other',
                      strategyId: 'Other' };
      catalog.forTool.mockResolvedValue([SETUP, OTHER]);
      qp.decide.mockImplementation(async (args) => {
        if (args.strategyId === SETUP.strategyId) throw new Error('boom');
        return { ok: true, picks: [], counts: { evaluated: 7, signalled: 0 } };
      });
      const out = await runner.runDue('10:00', { date: DATE });
      expect(out).toHaveLength(2);
      expect(out[0].ok).toBe(false);
      expect(out[1].ok).toBe(true);
      // AND IN THE ORDER THEY WERE ASKED. `allSettled` preserves it; the
      // returned array has to line up with the setups or a caller reading
      // out[i] for setup i gets another setup's result.
      expect(out[0].setupId).toBe(SETUP.id);
    });
});

/*
 * Position sizing. Risk per share runs from 0.3% to 5% of price across these
 * candidates, so a fixed dollar amount would risk fifteen times more on one
 * than another for no reason anyone chose.
 */
describe('share count', () => {
  const risk = require('../src/setups/risk');

  test('is absent until the account settings are, which is the honest output', async () => {
    jest.spyOn(risk, 'settings').mockReturnValue({
      accountSize: null, riskPerTrade: null, maxPositionPct: 100, updatedAt: null });
    decided([pick('LIFE')]);
    await runner.runSetup(SETUP, { date: DATE });
    const f = store.recentFires(DATE)[0];
    expect(f.setup.size).toBeNull();
    expect(f.detail).toMatch(/^BUY LIFE/);          // no invented quantity
    risk.settings.mockRestore();
  });

  test('leads the alert text once they are set', async () => {
    jest.spyOn(risk, 'settings').mockReturnValue({
      accountSize: 25000, riskPerTrade: 250, maxPositionPct: 100, updatedAt: 1 });
    decided([pick('LIFE')]);
    await runner.runSetup(SETUP, { date: DATE });
    const f = store.recentFires(DATE)[0];
    expect(f.setup.size.shares).toBe(182);          // floor(250 / 1.37)
    expect(f.detail).toMatch(/^BUY 182 LIFE/);
    expect(f.setup.size.riskDollars).toBeLessThanOrEqual(250);
    risk.settings.mockRestore();
  });
});

describe('ownership and dry runs', () => {
  test('a preview publishes nothing', async () => {
    decided([pick('LIFE')]);
    const out = await runner.runSetup(SETUP, { date: DATE, dryRun: true });
    expect(out.picks).toHaveLength(1);
    expect(store.recentFires(DATE)).toHaveLength(0);
  });

  test('a preview can be given its own universe, so any tool can inspect it', async () => {
    decided([pick('AAA')]);
    await runner.runSetup(SETUP, { date: DATE, dryRun: true, tickers: ['AAA'] });
    expect(qp.decide).toHaveBeenCalledWith(expect.objectContaining({ symbols: ['AAA'] }));
  });

  test('the wrong tool refuses to run it for real', async () => {
    const foreign = { ...SETUP, tools: ['T7'] };
    const out = await runner.runSetup(foreign, { date: DATE });
    expect(out.ok).toBe(false);
    expect(out.reason).toMatch(/belongs to T7/);
    expect(store.recentFires(DATE)).toHaveLength(0);
  });

  test('runDue only runs setups whose decision time matches', async () => {
    decided([pick('LIFE')]);
    expect(await runner.runDue('11:30', { date: DATE })).toEqual([]);
    expect(qp.decide).not.toHaveBeenCalled();
  });
});

/*
 * A setup switched off from the alerts page does not run — and does not
 * announce that it did not run. "Nothing qualified" every morning for something
 * deliberately turned off is what teaches you to stop reading the feed.
 */
describe('switching a setup off', () => {
  const prefs = require('../src/setups/prefs');

  test('runDue skips it, silently', async () => {
    jest.spyOn(prefs, 'isEnabled').mockReturnValue(false);
    decided([pick('LIFE')]);
    expect(await runner.runDue('10:00', { date: DATE })).toEqual([]);
    expect(qp.decide).not.toHaveBeenCalled();
    expect(store.recentFires(DATE)).toHaveLength(0);
    prefs.isEnabled.mockRestore();
  });

  test('and runs it again when switched back on', async () => {
    jest.spyOn(prefs, 'isEnabled').mockReturnValue(true);
    decided([pick('LIFE')]);
    expect(await runner.runDue('10:00', { date: DATE })).toHaveLength(1);
    expect(store.recentFires(DATE).some(f => f.level === 'trade')).toBe(true);
    prefs.isEnabled.mockRestore();
  });
});

/*
 * A watch setup — one that qp gives a WINDOW rather than a single minute.
 *
 * qp has always carried `risk.window_start` AND `risk.window_end`, and evaluates
 * an entry on any bar between them: `PML breakout` is live from 09:40 to 10:10.
 * This side used to collapse that to the opening minute, so the setup was asked
 * once, at 09:40, and never again — and because a setup that finds nothing still
 * publishes "nothing qualified", it looked like it had run and found nothing all
 * morning. Silence would have been noticed; a confident wrong answer was not.
 */
describe('a setup with a window rather than a minute', () => {
  const WATCH = {
    ...SETUP,
    id: 'T2 09:40 PML breakout@09:40',
    name: 'T2 09:40 PML breakout',
    decisionTime: '09:40', windowEnd: '10:10', watch: true,
  };
  beforeEach(() => { catalog.forTool.mockResolvedValue([WATCH]); });

  test('runs on every bar in the window, not only the first', async () => {
    decided([]);
    for (const bar of ['09:40', '09:52', '10:10']) {
      expect(await runner.runDue(bar, { date: DATE })).toHaveLength(1);
    }
    expect(qp.decide).toHaveBeenCalledTimes(3);
  });

  test('and not once the window has shut', async () => {
    decided([]);
    expect(await runner.runDue('10:11', { date: DATE })).toEqual([]);
    expect(await runner.runDue('09:39', { date: DATE })).toEqual([]);
    expect(qp.decide).not.toHaveBeenCalled();
  });

  /*
   * THE STALE PICK — the fault that let the desk trade a stock at a time when
   * it was not on the watchlist.
   *
   * qp is asked to decide a DATE and answers with every signal that opened
   * that session. A watch setup asks once a minute, so on the 10:05 pass it is
   * handed the entry the strategy found at 09:42 — and until this guard it
   * sent a market order for it.
   *
   * Both halves of that are wrong. The stop, the target, the R and the share
   * count were all priced from the 09:42 close, so twenty-three minutes later
   * the order is a different trade wearing the tested trade's numbers. And the
   * scanner had not surfaced the stock at 09:42: no alert could have fired and
   * no order could have been placed, which is precisely the trade the
   * backtest's watchlist gate drops. The two sides were measuring different
   * strategies and the live one was the looser.
   */
  test('a pick from an earlier bar is refused, not traded late', async () => {
    decided([pick('LIFE', { at: '09:42' })]);
    const [out] = await runner.runDue('10:05', { date: DATE });
    expect(out.fires).toHaveLength(0);
    expect(store.recentFires(DATE).filter(f => f.ticker)).toHaveLength(0);
  });

  /*
   * ONE BAR IS NOT STALENESS, IT IS THE DESK'S OWN LATENCY.
   *
   * The decision is taken on the close of the bar just finished and the market
   * order reaches the tape inside the NEXT one. A signal stamped a minute
   * before the bar being decided is that same trade, seen through a feed that
   * published late. Refusing it would turn a one-bar lag into a setup that
   * takes nothing at all for its whole window — and a strategy finding nothing
   * looks exactly like a quiet day, which is why that failure never gets seen.
   */
  test('a pick one bar behind is still taken — that is the desk itself', async () => {
    decided([pick('LIFE', { at: '10:04' })]);
    const [out] = await runner.runDue('10:05', { date: DATE });
    expect(out.fires.filter(f => f.ticker)).toHaveLength(1);
    expect(out.staleBars).toBeUndefined();
  });

  test('two bars behind is a different trade, and is refused', async () => {
    decided([pick('LIFE', { at: '10:03' })]);
    const [out] = await runner.runDue('10:05', { date: DATE });
    expect(out.fires.filter(f => f.ticker)).toHaveLength(0);
  });

  test('the drop is reported, because it means the setup missed a bar', async () => {
    decided([pick('LIFE', { at: '09:42' }), pick('LSCC', { at: '10:05' })]);
    const [out] = await runner.runDue('10:05', { date: DATE });
    expect(out.staleBars).toEqual(['LIFE@09:42']);
    // …and the pick that DID fire on this bar is untouched by the guard.
    expect(store.recentFires(DATE).filter(f => f.ticker).map(f => f.ticker))
      .toEqual(['LSCC']);
  });

  /*
   * Thirty-one bars, thirty-one "nothing qualified" lines, one of which matters.
   * The empty answer is worth publishing once — on the last bar, when it is
   * final — and worth suppressing on the bars where the day is still open.
   */
  test('an empty bar mid-window publishes nothing', async () => {
    decided([]);
    const [out] = await runner.runDue('09:52', { date: DATE });
    expect(out.quiet).toBe(true);
    expect(store.recentFires(DATE)).toHaveLength(0);
  });

  test('an empty LAST bar says so, because now it is the answer', async () => {
    decided([]);
    const [out] = await runner.runDue('10:10', { date: DATE });
    expect(out.quiet).toBeUndefined();
    expect(store.recentFires(DATE)[0].detail).toMatch(/Nothing qualified/);
  });

  /*
   * The latch. A level that broke at 09:52 is still broken at 09:53, so qp
   * answers the same trade on every remaining bar. One break, one alert.
   */
  test('a ticker that already fired today does not fire again', async () => {
    // The pick's own bar, matching the bar being decided. It used to say
    // 10:00 for a run at 09:52 — a shape qp cannot produce and the runner now
    // refuses, because a signal from another bar carries another bar's prices.
    decided([pick('LIFE', { at: '09:52' })]);
    const first = await runner.runDue('09:52', { date: DATE });
    expect(first[0].fires).toHaveLength(1);

    // Still the same broken level a minute later, so qp answers with the same
    // trade — now stamped 09:53, which is what a re-evaluation really returns.
    decided([pick('LIFE', { at: '09:53' })]);
    const again = await runner.runDue('09:53', { date: DATE });
    expect(again[0].latched).toBe(1);
    expect(store.recentFires(DATE).filter(f => f.ticker === 'LIFE')).toHaveLength(1);
  });

  test('but a different ticker later in the window still does', async () => {
    decided([pick('LIFE', { at: '09:52' })]);
    await runner.runDue('09:52', { date: DATE });
    decided([pick('LSCC', { at: '09:58' })]);
    await runner.runDue('09:58', { date: DATE });
    const tickers = store.recentFires(DATE).filter(f => f.ticker).map(f => f.ticker);
    expect(tickers.sort()).toEqual(['LIFE', 'LSCC']);
  });

  /*
   * A clock setup is a one-minute window, so none of the above may change it:
   * it still runs on its minute and still says "nothing qualified" when it
   * finds nothing, because that bar is both its first and its last.
   */
  test('a clock setup is unaffected — one bar, and it always answers', async () => {
    catalog.forTool.mockResolvedValue([SETUP]);
    decided([]);
    const [out] = await runner.runDue('10:00', { date: DATE });
    expect(out.quiet).toBeUndefined();
    expect(store.recentFires(DATE)[0].detail).toMatch(/Nothing qualified/);
  });
});

/*
 * The card-field filter, applied BEFORE qp.
 *
 * The order is the whole point. The setup ranks and takes the top two, so
 * filtering afterwards means the filter eats picks and leaves gaps — rank 3,
 * which passed the filter, is discarded before anyone sees it. Filtering first
 * means the ranking happens among the names that would actually be taken, and
 * qp evaluates twelve symbols at 10:00 instead of forty.
 */
describe('the card-field filter', () => {
  const gated = { ...SETUP, universe: { rules: [
    { left: 'bias', op: 'eq', right: 'BULLISH' },
  ] } };

  function rows() {
    return [
      { ticker: 'GOOD', bias: 'BULLISH', _score: 80, stock: { price: 30 } },
      { ticker: 'BAD', bias: 'BEARISH', _score: 90, stock: { price: 30 } },
    ];
  }

  test('only the cards that passed are sent to qp', async () => {
    r0.getTodayRows.mockReturnValue(rows());
    decided([pick('GOOD')]);
    await runner.runSetup(gated, { date: DATE });
    expect(qp.decide).toHaveBeenCalledWith(
      expect.objectContaining({ symbols: ['GOOD'] }));
  });

  test('the run says how many the filter removed and why', async () => {
    r0.getTodayRows.mockReturnValue(rows());
    decided([pick('GOOD')]);
    await runner.runSetup(gated, { date: DATE });
    const line = store.recentFires(DATE).find(f => /Filter:/.test(f.detail || ''));
    expect(line.detail).toMatch(/2 card\(s\) → 1 passed/);
    expect(line.detail).toMatch(/Bias is BULLISH/);
  });

  test('a setup with no filter sends the whole card list', async () => {
    r0.getTodayRows.mockReturnValue(rows());
    decided([pick('GOOD')]);
    await runner.runSetup(SETUP, { date: DATE });
    expect(qp.decide).toHaveBeenCalledWith(
      expect.objectContaining({ symbols: ['GOOD', 'BAD'] }));
    expect(store.recentFires(DATE).some(f => /Filter:/.test(f.detail || ''))).toBe(false);
  });

  /*
   * "The filter removed everything" and "the tool found nothing" are different
   * mornings, and a filter nobody can see working gets blamed for the wrong one.
   */
  test('a filter that removes everything says so, and does not call qp', async () => {
    r0.getTodayRows.mockReturnValue([
      { ticker: 'BAD', bias: 'BEARISH', _score: 90, stock: { price: 30 } },
    ]);
    await runner.runSetup(gated, { date: DATE });
    expect(qp.decide).not.toHaveBeenCalled();
    const f = store.recentFires(DATE)[0];
    expect(f.detail).toMatch(/All 1 card\(s\) were removed by the filter/);
    expect(f.detail).toMatch(/1× Bias is BULLISH/);
  });

  test('an empty card list is still its own message, not a filter message', async () => {
    r0.getTodayRows.mockReturnValue([]);
    await runner.runSetup(gated, { date: DATE });
    expect(store.recentFires(DATE)[0].detail).toMatch(/No cards on the list/);
  });

  test('the setup\'s fill convention reaches qp', async () => {
    r0.getTodayRows.mockReturnValue(rows());
    decided([pick('GOOD')]);
    await runner.runSetup({ ...SETUP, fill: 'next_open' }, { date: DATE });
    expect(qp.decide).toHaveBeenCalledWith(
      expect.objectContaining({ fill: 'next_open' }));
  });
});

/*
 * Nothing is ordered unless an ACCOUNT asked for it.
 *
 * Permission used to be a flag on the setup, which was the wrong object to
 * hang it on: the same strategy can be one you watch by hand in the prop
 * account and let run in the paper account, and a flag on the strategy cannot
 * say that. It is now the account's mode plus the account's setup list, and
 * broker.autoRoute is what answers the question. Arming stays separate — that
 * is permission for the BOX, not for an account.
 */
describe('which setups place orders', () => {
  const brokerMod = require('../src/broker/signalstack');
  const risk = require('../src/setups/risk');

  beforeEach(() => {
    jest.restoreAllMocks();
    // An account, so there is a share count to order. Without one the setup
    // publishes the plan with no size and orders nothing — which is right, and
    // is not what these three are about.
    jest.spyOn(risk, 'settings').mockReturnValue({
      accountSize: 5000, riskPerTrade: 25, maxPositionPct: 100, updatedAt: 1 });
    /*
     * A broker to route to.
     *
     * These tests are about PERMISSION — whether a setup may place an order at
     * all — and permission now has a second half: an account to place it in.
     * With none configured, broker.route refuses before placeOrder is reached,
     * which is correct and is not what is being measured here. Routing has its
     * own tests.
     */
    jest.spyOn(brokerMod, 'accountsFor').mockReturnValue([{ id: 'x' }]);
    jest.spyOn(brokerMod, 'autoRoute').mockReturnValue({
      cfgs: [{ destinationId: 'ttp', destinationName: 'Trade The Pool' }], error: null });
  });

  test('a setup no account runs places nothing, however armed the broker is', async () => {
    brokerMod.autoRoute.mockReturnValue({ cfgs: [], error: 'no account runs this setup' });
    const spy = jest.spyOn(brokerMod, 'placeOrder');
    qp.decide.mockResolvedValue({
      ok: true, feed: 'yahoo', counts: { evaluated: 1, signalled: 1 },
      picks: [{ symbol: 'AAA', side: 'long', metric: 3, entry: 10, stop: 9,
                risk: 1, risk_pct: 10, target: 12, target_r: 2, entry_at: '10:00' }],
    });
    await runner.runSetup({ id: 'S', name: 'S', tools: ['T2'], decisionTime: '10:00' }, {});
    expect(spy).not.toHaveBeenCalled();
  });

  /* No account settings means no share count, and no share count means there is
   * nothing to order — a size invented at that point would be the worst kind. */
  test('a setup with permission but no account settings orders nothing', async () => {
    risk.settings.mockReturnValue({
      accountSize: null, riskPerTrade: null, maxPositionPct: 100, updatedAt: null });
    const spy = jest.spyOn(brokerMod, 'placeOrder');
    qp.decide.mockResolvedValue({
      ok: true, feed: 'yahoo', counts: { evaluated: 1, signalled: 1 },
      picks: [{ symbol: 'AAA', side: 'long', metric: 3, entry: 10, stop: 9,
                risk: 1, risk_pct: 10, target: 12, target_r: 2, entry_at: '10:00' }],
    });
    await runner.runSetup(
      { id: 'S', name: 'S', tools: ['T2'], decisionTime: '10:00' }, {});
    expect(spy).not.toHaveBeenCalled();
  });

  test('a setup with permission places one', async () => {
    const spy = jest.spyOn(brokerMod, 'placeOrder')
      .mockResolvedValue({ sent: true, status: 'filled', quantity: 2, bracket: true });
    qp.decide.mockResolvedValue({
      ok: true, feed: 'yahoo', counts: { evaluated: 1, signalled: 1 },
      picks: [{ symbol: 'AAA', side: 'long', metric: 3, entry: 10, stop: 9,
                risk: 1, risk_pct: 10, target: 12, target_r: 2, entry_at: '10:00' }],
    });
    const out = await runner.runSetup(
      { id: 'S', name: 'S', tools: ['T2'], decisionTime: '10:00' }, {});
    expect(spy).toHaveBeenCalled();
    // The stop and the target travel with the entry — they were decided at the
    // same instant, and an entry without its stop has no defined loss.
    expect(spy.mock.calls[0][0]).toMatchObject({ symbol: 'AAA', stop: 9, target: 12 });
    // …and what the broker did is on the alert itself, not somewhere to look up.
    expect(out.fires[0].detail).toMatch(/ORDER FILLED/);
  });

  /* A preview must never reach a broker. It is used to look at past dates. */
  test('a dry run never places an order', async () => {
    const spy = jest.spyOn(brokerMod, 'placeOrder');
    qp.decide.mockResolvedValue({
      ok: true, feed: 'yahoo', counts: { evaluated: 1, signalled: 1 },
      picks: [{ symbol: 'AAA', side: 'long', metric: 3, entry: 10, stop: 9,
                risk: 1, risk_pct: 10, target: 12, target_r: 2, entry_at: '10:00' }],
    });
    await runner.runSetup(
      { id: 'S', name: 'S', tools: ['T2'], decisionTime: '10:00' },
      { dryRun: true });
    expect(spy).not.toHaveBeenCalled();
  });
});

/*
 * Two layers of risk, and the setup's wins where it says anything.
 *
 * Having to edit the account figure before and after each morning is how it
 * ends up wrong on the morning nobody remembers.
 */
describe('setup-level risk overrides the account', () => {
  const risk = require('../src/setups/risk');

  beforeEach(() => {
    jest.restoreAllMocks();
    jest.spyOn(risk, 'settings').mockReturnValue({
      accountSize: 5000, riskPerTrade: 100, maxPositionPct: 100, updatedAt: 1 });
    qp.decide.mockResolvedValue({
      ok: true, feed: 'yahoo', counts: { evaluated: 1, signalled: 1 },
      picks: [{ symbol: 'AAA', side: 'long', metric: 3, entry: 10, stop: 9,
                risk: 1, risk_pct: 10, target: 12, target_r: 2, entry_at: '10:00' }],
    });
  });

  test("without one, the account's figure sizes it", async () => {
    await runner.runSetup({ id: 'S', name: 'S', tools: ['T2'], decisionTime: '10:00' },
      { date: DATE });
    const f = store.recentFires(DATE)[0];
    expect(f.setup.size.shares).toBe(100);        // 100 / 1
    expect(f.setup.riskFrom).toBe('account');
  });

  test('with one, the setup risks less and says so', async () => {
    await runner.runSetup({ id: 'S', name: 'S', tools: ['T2'], decisionTime: '10:00',
      riskPerTrade: 10 }, { date: DATE });
    const f = store.recentFires(DATE)[0];
    expect(f.setup.size.shares).toBe(10);         // 10 / 1
    expect(f.setup.riskUsed).toBe(10);
    expect(f.setup.riskFrom).toBe('setup');
  });

  test('a setup position cap applies too', async () => {
    await runner.runSetup({ id: 'S', name: 'S', tools: ['T2'], decisionTime: '10:00',
      maxPositionPct: 1 }, { date: DATE });
    // 1% of a 5,000 account is 50, at 10 a share = 5.
    expect(store.recentFires(DATE)[0].setup.size.shares).toBe(5);
  });
});

/*
 * A strategy that exits on a RULE alerts and does not trade.
 *
 * No broker watches for a VWAP cross. Substituting a price target would place a
 * different strategy from the one that was backtested — under the same name,
 * carrying the same evidence. Fashionably Late is validated at 75%, and that
 * number comes from its VWAP-cross exit.
 */
describe('a rule-exit strategy is alert-only', () => {
  const brokerMod = require('../src/broker/signalstack');
  const risk = require('../src/setups/risk');

  const RULE_EXIT = {
    id: 'S', name: 'Fashionably Late Scalp', tools: ['T2'], decisionTime: '10:00',
    autoTrade: true,
    readiness: { ok: true, orderOk: false,
      orderBlocking: ['this strategy exits on a RULE, not at a price'] },
  };

  beforeEach(() => {
    jest.restoreAllMocks();
    jest.spyOn(risk, 'settings').mockReturnValue({
      accountSize: 5000, riskPerTrade: 25, maxPositionPct: 100, updatedAt: 1 });
    qp.decide.mockResolvedValue({
      ok: true, feed: 'yahoo', counts: { evaluated: 1, signalled: 1 },
      picks: [{ symbol: 'AAA', side: 'long', metric: 3, entry: 10, stop: 9,
                risk: 1, risk_pct: 10, target: 12, target_r: 2, entry_at: '10:00' }],
    });
    /*
     * A broker to route to.
     *
     * These tests are about PERMISSION — whether a setup may place an order at
     * all — and permission now has a second half: an account to place it in.
     * With none configured, broker.route refuses before placeOrder is reached,
     * which is correct and is not what is being measured here. Routing has its
     * own tests.
     */
    jest.spyOn(brokerMod, 'accountsFor').mockReturnValue([{ id: 'x' }]);
    jest.spyOn(brokerMod, 'autoRoute').mockReturnValue({
      cfgs: [{ destinationId: 'ttp', destinationName: 'Trade The Pool' }], error: null });
  });

  test('no order is placed even with orders switched on', async () => {
    const spy = jest.spyOn(brokerMod, 'placeOrder');
    await runner.runSetup(RULE_EXIT, { date: DATE });
    expect(spy).not.toHaveBeenCalled();
  });

  /* The alert still arrives, in full, and says why nothing was ordered. */
  test('the alert still fires and says it is alert-only', async () => {
    await runner.runSetup(RULE_EXIT, { date: DATE });
    const f = store.recentFires(DATE)[0];
    expect(f.detail).toMatch(/^BUY 25 AAA/);
    expect(f.detail).toMatch(/ALERT ONLY/);
    expect(f.detail).toMatch(/exits on a RULE/);
  });

  test('a strategy that CAN be ordered still is', async () => {
    const spy = jest.spyOn(brokerMod, 'placeOrder')
      .mockResolvedValue({ sent: true, status: 'filled', quantity: 25 });
    await runner.runSetup({ ...RULE_EXIT,
      readiness: { ok: true, orderOk: true, orderBlocking: [] } }, { date: DATE });
    expect(spy).toHaveBeenCalled();
  });

  /* A setup with no readiness at all — an older payload — must not be blocked
   * by this, or a deploy ordering mismatch would silence every setup. */
  test('a setup with no readiness is treated as orderable', async () => {
    const spy = jest.spyOn(brokerMod, 'placeOrder')
      .mockResolvedValue({ sent: true, status: 'filled', quantity: 25 });
    await runner.runSetup({ id: 'S', name: 'S', tools: ['T2'],
      decisionTime: '10:00' }, { date: DATE });
    expect(spy).toHaveBeenCalled();
  });
});

/*
 * ONE SIGNAL, TWO ACCOUNTS.
 *
 * A setup routed to a prop-firm account and to Alpaca is the same trade in
 * both, and the interesting cases are all about them being SEPARATE: separate
 * sizing, separate outcomes, and separate failures. The one that would cost
 * real money is a broker being unreachable and taking the other account's
 * order down with it — which is exactly what a single try/catch around the
 * loop would have done.
 */
describe('a setup routed to two accounts', () => {
  const brokerMod = require('../src/broker/signalstack');
  const risk = require('../src/setups/risk');
  const TWO = [
    { destinationId: 'ttp', destinationName: 'Trade The Pool' },
    { destinationId: 'alpaca', destinationName: 'Alpaca' },
  ];
  const SET = { id: 'S', name: 'S', tools: ['T2'], decisionTime: '10:00',
                brokers: ['ttp', 'alpaca'] };

  beforeEach(() => {
    jest.restoreAllMocks();
    jest.spyOn(risk, 'settings').mockReturnValue({
      accountSize: 5000, riskPerTrade: 25, maxPositionPct: 100, updatedAt: 1 });
    jest.spyOn(brokerMod, 'accountsFor').mockReturnValue([{ id: 'x' }]);
    jest.spyOn(brokerMod, 'autoRoute').mockReturnValue({ cfgs: TWO, error: null });
    qp.decide.mockResolvedValue({
      ok: true, feed: 'yahoo', counts: { evaluated: 1, signalled: 1 },
      picks: [{ symbol: 'AAA', side: 'long', metric: 3, entry: 10, stop: 9,
                risk: 1, risk_pct: 10, target: 12, target_r: 2, entry_at: '10:00' }],
    });
  });

  test('both get an order, each against its own cfg', async () => {
    const spy = jest.spyOn(brokerMod, 'placeOrder')
      .mockResolvedValue({ sent: true, status: 'filled', quantity: 25 });
    await runner.runSetup(SET, {});
    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy.mock.calls.map(c => c[0].cfg.destinationId)).toEqual(['ttp', 'alpaca']);
    // Same trade, not two different ones.
    expect(spy.mock.calls[0][0]).toMatchObject({ symbol: 'AAA', stop: 9, target: 12 });
    expect(spy.mock.calls[1][0]).toMatchObject({ symbol: 'AAA', stop: 9, target: 12 });
  });

  test('the alert names what happened at each', async () => {
    jest.spyOn(brokerMod, 'placeOrder')
      .mockResolvedValueOnce({ sent: true, status: 'filled', quantity: 25, bracket: true })
      .mockResolvedValueOnce({ sent: false, error: 'insufficient buying power' });
    const out = await runner.runSetup(SET, {});
    const d = out.fires[0].detail;
    expect(d).toMatch(/Trade The Pool: ORDER FILLED 25/);
    expect(d).toMatch(/Alpaca: ORDER FAILED — insufficient buying power/);
  });

  test('one broker being unreachable does not stop the other', async () => {
    jest.spyOn(brokerMod, 'placeOrder')
      .mockRejectedValueOnce(new Error('ETIMEDOUT'))
      .mockResolvedValueOnce({ sent: true, status: 'accepted', quantity: 25 });
    const out = await runner.runSetup(SET, {});
    const rows = out.fires[0].setup.orders;
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ sent: false, error: 'ETIMEDOUT', destination: 'ttp' });
    expect(rows[1]).toMatchObject({ sent: true, destination: 'alpaca' });
  });

  test('the record keeps both, and `order` still means the first', async () => {
    // Every fire ever written has an `order` object and the history page reads
    // it. Turning that field into an array would rewrite the past.
    jest.spyOn(brokerMod, 'placeOrder')
      .mockResolvedValue({ sent: true, status: 'filled', quantity: 25 });
    const out = await runner.runSetup(SET, {});
    const t = out.fires[0].setup;
    expect(t.order.destination).toBe('ttp');
    expect(t.orders.map(o => o.destination)).toEqual(['ttp', 'alpaca']);
  });

  test('a setup that cannot be routed says so on the alert', async () => {
    // The failure this replaces: a setup marked auto-trade quietly placing
    // nothing, which from a phone is indistinguishable from a quiet morning.
    brokerMod.autoRoute.mockReturnValue({ cfgs: [], error: 'no broker is configured' });
    const spy = jest.spyOn(brokerMod, 'placeOrder');
    const out = await runner.runSetup(SET, {});
    expect(spy).not.toHaveBeenCalled();
    expect(out.fires[0].detail).toMatch(/NO ORDER — no broker is configured/);
  });

  test('a dry run asks no broker anything', async () => {
    const spy = jest.spyOn(brokerMod, 'placeOrder');
    await runner.runSetup(SET, { dryRun: true });
    expect(spy).not.toHaveBeenCalled();
  });
});

/*
 * TWO ACCOUNTS, TWO SHARE COUNTS.
 *
 * The failure this replaces: one size computed from the desk's balance and the
 * same count sent to both books. A $5,000 prop account handed a size meant for
 * $20,000 has the order refused; a $20,000 account handed the small one is
 * barely used. Neither is the trade that was backtested.
 */
describe('sizing when a setup sends to two accounts', () => {
  const brokerMod = require('../src/broker/signalstack');
  const risk = require('../src/setups/risk');
  // Described against the STANDARD account, which is what an account row on the
  // Settings tab actually stores: a quarter of it, and all of it.
  // A quarter of the standard, and the whole of it. One number each: that is
  // the entirety of an account's money management now.
  const SMALL = { destinationId: 'ttp', destinationName: 'Trade The Pool', ratio: 0.25 };
  const BIG = { destinationId: 'alpaca', destinationName: 'Alpaca', ratio: 1 };
  const SET = { id: 'S', name: 'S', tools: ['T2'], decisionTime: '10:00',
                brokers: ['ttp', 'alpaca'] };

  beforeEach(() => {
    jest.restoreAllMocks();
    // The standard account: $20,000 risking $200, no position cap in the way.
    jest.spyOn(risk, 'settings').mockReturnValue({
      accountSize: 20000, riskPerTrade: 200, maxPositionPct: 100, updatedAt: 1 });
    jest.spyOn(brokerMod, 'accountsFor').mockReturnValue([{ id: 'x' }]);
    jest.spyOn(brokerMod, 'autoRoute').mockReturnValue({ cfgs: [SMALL, BIG], error: null });
    qp.decide.mockResolvedValue({
      ok: true, feed: 'yahoo', counts: { evaluated: 1, signalled: 1 },
      picks: [{ symbol: 'AAA', side: 'long', metric: 3, entry: 10, stop: 9,
                risk: 1, risk_pct: 10, target: 12, target_r: 2, entry_at: '10:00' }],
    });
  });

  test('each account gets its own share count', async () => {
    const spy = jest.spyOn(brokerMod, 'placeOrder')
      .mockResolvedValue({ sent: true, status: 'filled' });
    await runner.runSetup(SET, {});
    const sent = spy.mock.calls.map(c => [c[0].cfg.destinationId, c[0].quantity]);
    // $1 of risk a share. The full-size account risks the standard's $200 →
    // 200 shares; the quarter-size one risks a quarter of it → 50.
    expect(sent).toEqual([['ttp', 50], ['alpaca', 200]]);
  });

  test('an account too small for one share is skipped, and says so', async () => {
    // Not silence: an account that placed nothing has to be distinguishable
    // from one that placed something, on the alert itself.
    const spy = jest.spyOn(brokerMod, 'placeOrder')
      .mockResolvedValue({ sent: true, status: 'filled' });
    brokerMod.autoRoute.mockReturnValue({
      cfgs: [{ ...SMALL, ratio: 0.001 }, BIG], error: null });
    const out = await runner.runSetup(SET, {});
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0].cfg.destinationId).toBe('alpaca');
    expect(out.fires[0].detail).toMatch(/Trade The Pool: ORDER: not sent/);
  });

  test('what each account was sized for is kept on the record', async () => {
    jest.spyOn(brokerMod, 'placeOrder')
      .mockResolvedValue({ sent: true, status: 'filled', quantity: 7 });
    const out = await runner.runSetup(SET, {});
    expect(out.fires[0].setup.orders.map(o => [o.destination, o.sizedFor]))
      .toEqual([['ttp', 50], ['alpaca', 200]]);
  });

  test('an account with no ratio of its own is the standard account', async () => {
    // The single-broker case, which must not have changed at all.
    const spy = jest.spyOn(brokerMod, 'placeOrder')
      .mockResolvedValue({ sent: true, status: 'filled' });
    brokerMod.autoRoute.mockReturnValue({
      cfgs: [{ destinationId: 'ttp', destinationName: 'TTP' }], error: null });
    await runner.runSetup(SET, {});
    expect(spy.mock.calls[0][0].quantity).toBe(200);
  });
});

/*
 * READY, BUT NOT SENT.
 *
 * An account on `manual` runs the setup and has agreed to receive orders — it
 * just wants a thumb on the button. That is not a reason to make it do the
 * arithmetic again ten minutes later, so the share count is worked out at the
 * same instant and from the same standard as the automatic ones, and travels
 * on the alert. Pressing send is then a send, not a re-derivation.
 */
describe('an account on manual gets a prepared order', () => {
  const brokerMod = require('../src/broker/signalstack');
  const risk = require('../src/setups/risk');
  const AUTO = { destinationId: 'alpaca', destinationName: 'Alpaca', ratio: 1 };
  const HAND = { destinationId: 'ttp', destinationName: 'Trade The Pool', ratio: 0.05 };
  const SET = { id: 'S', name: 'S', tools: ['T2'], decisionTime: '10:00' };

  beforeEach(() => {
    jest.restoreAllMocks();
    // $100,000 risking $1,000. A $1 stop makes the standard trade 1,000 shares.
    jest.spyOn(risk, 'settings').mockReturnValue({
      accountSize: 100000, riskPerTrade: 1000, maxPositionPct: 100, updatedAt: 1 });
    jest.spyOn(brokerMod, 'settings').mockReturnValue({ armed: true, enabled: true });
    jest.spyOn(brokerMod, 'accountsFor').mockImplementation((id, mode) =>
      mode === 'manual' ? [HAND] : [AUTO, HAND]);
    jest.spyOn(brokerMod, 'autoRoute').mockReturnValue({ cfgs: [AUTO], error: null });
    jest.spyOn(brokerMod, 'placeOrder').mockResolvedValue({ sent: true, status: 'filled' });
    qp.decide.mockResolvedValue({
      ok: true, feed: 'yahoo', counts: { evaluated: 1, signalled: 1 },
      picks: [{ symbol: 'AAA', side: 'long', metric: 3, entry: 10, stop: 9,
                risk: 1, risk_pct: 10, target: 12, target_r: 2, entry_at: '10:00' }],
    });
  });

  test('the auto account is sent, the manual one is prepared', async () => {
    const out = await runner.runSetup(SET, {});
    const t = out.fires[0].setup;
    expect(t.orders.map(o => o.destination)).toEqual(['alpaca']);
    expect(t.ready.map(r => r.destination)).toEqual(['ttp']);
  });

  test('its share count is its own fraction of the standard, already worked out', async () => {
    const out = await runner.runSetup(SET, {});
    const [r] = out.fires[0].setup.ready;
    // 1,000 at the standard; this account is 0.05 of it.
    expect({ standard: r.standardShares, ratio: r.ratio, shares: r.shares })
      .toEqual({ standard: 1000, ratio: 0.05, shares: 50 });
  });

  test('nothing is prepared while the box is unarmed', async () => {
    // A one-tap order offered by an unarmed desk would be the master switch
    // failing to be a master switch.
    brokerMod.settings.mockReturnValue({ armed: false, enabled: true });
    const out = await runner.runSetup(SET, {});
    expect(out.fires[0].setup.ready).toEqual([]);
  });

  test('an account too small for one share says so instead of offering a button', async () => {
    brokerMod.accountsFor.mockImplementation((id, mode) =>
      mode === 'manual' ? [{ ...HAND, ratio: 0.0004 }] : [AUTO]);
    const out = await runner.runSetup(SET, {});
    const [r] = out.fires[0].setup.ready;
    expect(r.shares).toBe(0);
    expect(r.reason).toMatch(/under one whole share/);
  });

  test('a rule-exit strategy prepares nothing — it cannot be ordered at all', async () => {
    const out = await runner.runSetup({ ...SET,
      readiness: { ok: true, orderOk: false, orderBlocking: ['exits on a rule'],
                   blocking: [], warnings: [] } }, {});
    expect(out.fires[0].setup.ready).toEqual([]);
  });
});
