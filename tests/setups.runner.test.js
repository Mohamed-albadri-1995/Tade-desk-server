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
jest.mock('../src/setups/catalog');
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
    expect(detail).toMatch(/stop [\d.]+ \(VWAP, fixed\)/);
    expect(detail).toMatch(/target [\d.]+/);
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
    expect(err.detail).toMatch(/Did not run: connect ECONNREFUSED/);
  });

  test('and so is qp answering that it could not decide', async () => {
    qp.decide.mockRejectedValue(new Error("no strategy for 'T2 10:00 VWAP Extension'"));
    await runner.runDue('10:00', { date: DATE });
    expect(store.recentFires(DATE).find(f => f.level === 'error').detail)
      .toMatch(/no strategy for/);
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
