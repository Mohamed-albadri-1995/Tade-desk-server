/*
 * Turning a setup's picks into alerts that arrive.
 *
 * The property that matters most here is not the arithmetic — that is tested
 * against the spec in setups.vwapExtension.test.js — it is that a run ALWAYS
 * says something. From a phone, "the setup ran and nothing qualified", "the
 * data never arrived" and "the process was down" all look identical: an empty
 * feed. So each of those has to produce its own line, and that is what is
 * pinned here.
 */

const os = require('os');
const path = require('path');
const fs = require('fs');

const FIRES = path.join(os.tmpdir(), `setup-fires-${process.pid}.json`);
process.env.ALERT_FIRES_FILE = FIRES;
process.env.TOOL_ID = 'T2';
process.env.TOOL_NAME = 'Momentum';

jest.mock('../src/setups/bars');
jest.mock('../src/r0/registry', () => ({ getTodayRows: jest.fn(() => []) }));

const bars = require('../src/setups/bars');
const r0 = require('../src/r0/registry');
const runner = require('../src/setups/runner');
const setups = require('../src/setups');
const store = require('../src/alerts/store');

const SETUP = setups.get('T2-VWAP-EXT');
const DATE = '2026-08-10';

/*
 * A morning that produces a clean LONG, steeper for a bigger `mult`.
 *
 * Thirty bars, 09:30 through 09:59, because that is what a real morning is —
 * and because the decision bar being 09:59 is load-bearing. A fixture ending at
 * 09:54 would silently exercise the "the feed had not published the decision
 * bar" path in every test that used it.
 */
function rising(mult) {
  const out = [];
  for (let i = 0; i < 30; i++) {
    const mins = 9 * 60 + 30 + i;
    out.push({
      etTime: `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`,
      o: 10 + i * 0.1 * mult, h: 10 + i * 0.1 * mult,
      l: 9.9 + i * 0.1 * mult, c: 10 + i * 0.1 * mult, v: 1000,
    });
  }
  return out;
}
function flat() {
  const out = [];
  for (let i = 0; i < 30; i++) {
    const mins = 9 * 60 + 30 + i;
    out.push({
      etTime: `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`,
      o: 10, h: 10, l: 10, c: 10, v: 1000,
    });
  }
  return out;
}

function feed(barsByTicker, extra = {}) {
  bars.fetchMorning.mockResolvedValue({
    bars: barsByTicker,
    sources: Object.fromEntries(Object.keys(barsByTicker).map(t => [t, 'yahoo'])),
    missing: [], degraded: [], waitedMs: 0, attempts: 1, coverage: 1,
    feed: 'yahoo', mixed: false, used: ['yahoo'],
    ...extra,
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  try { fs.unlinkSync(FIRES); } catch { /* absent */ }
  r0.getTodayRows.mockReturnValue([{ ticker: 'FAST' }, { ticker: 'SLOW' }, { ticker: 'FLAT' }]);
});
afterAll(() => { try { fs.unlinkSync(FIRES); } catch { /* absent */ } });

describe('the decision bar', () => {
  test('is the minute before the decision time', () => {
    expect(runner.lastWantedBar('10:00')).toBe('09:59');
    expect(runner.lastWantedBar('09:35')).toBe('09:34');
  });
});

describe('a run that finds trades', () => {
  test('publishes one alert per pick, with the whole plan in it', async () => {
    feed({ FAST: rising(3), SLOW: rising(1), FLAT: flat() });
    const out = await runner.runSetup(SETUP, { date: DATE });

    expect(out.picks.map(p => p.ticker)).toEqual(['FAST', 'SLOW']);
    const fires = store.recentFires(DATE);
    expect(fires.filter(f => f.level === 'trade')).toHaveLength(2);

    const f = fires.find(x => x.ticker === 'FAST');
    expect(f.setup.signal).toBe('LONG');
    expect(f.setup.stop).toBeCloseTo(f.setup.decisionVwap, 10);
    expect(f.setup.target).toBeGreaterThan(f.setup.entry);
  });

  /*
   * The notification body is all a phone shows. It has to carry the four things
   * needed to place the trade without opening anything.
   */
  test('the text says direction, price, stop and target', async () => {
    feed({ FAST: rising(3) });
    r0.getTodayRows.mockReturnValue([{ ticker: 'FAST' }]);
    await runner.runSetup(SETUP, { date: DATE });
    const detail = store.recentFires(DATE).find(f => f.ticker === 'FAST').detail;
    expect(detail).toMatch(/^BUY FAST/);
    expect(detail).toMatch(/stop [\d.]+ \(VWAP, fixed\)/);
    expect(detail).toMatch(/target [\d.]+/);
  });

  test('the caution travels with the trade, not just the documentation', async () => {
    feed({ FAST: rising(3) });
    r0.getTodayRows.mockReturnValue([{ ticker: 'FAST' }]);
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
    feed({ FLAT: flat() });
    r0.getTodayRows.mockReturnValue([{ ticker: 'FLAT' }]);
    await runner.runSetup(SETUP, { date: DATE });
    const fires = store.recentFires(DATE);
    expect(fires).toHaveLength(1);
    expect(fires[0].level).toBe('info');
    expect(fires[0].detail).toMatch(/Nothing qualified/);
    expect(fires[0].detail).toMatch(/1 evaluated/);
  });

  test('an empty card list is its own message, not "nothing qualified"', async () => {
    r0.getTodayRows.mockReturnValue([]);
    await runner.runSetup(SETUP, { date: DATE });
    const fires = store.recentFires(DATE);
    expect(fires[0].detail).toMatch(/No cards on the list/);
    expect(bars.fetchMorning).not.toHaveBeenCalled();
  });

  test('missing bars are reported, because the ranking was over fewer names', async () => {
    feed({ FAST: rising(3) }, { missing: ['GONE', 'ALSOGONE'], coverage: 0.33 });
    await runner.runSetup(SETUP, { date: DATE });
    const warn = store.recentFires(DATE).find(f => f.level === 'warn');
    expect(warn.detail).toMatch(/No 09:59 bar for GONE, ALSOGONE/);
  });

  test('a crash is published too, rather than leaving an empty feed', async () => {
    bars.fetchMorning.mockRejectedValue(new Error('feed down'));
    await runner.runDue('10:00', { date: DATE });
    const err = store.recentFires(DATE).find(f => f.level === 'error');
    expect(err.detail).toMatch(/Did not run: feed down/);
  });
});

/*
 * The VWAP is the stop. A VWAP computed from IEX volume — a few percent of the
 * consolidated tape — is not the level a chart draws, so a pick built on one
 * has to say so on the pick itself rather than in blanket small print.
 */
describe('feed quality', () => {
  test('an IEX-sourced pick carries the warning', async () => {
    feed({ FAST: rising(3) }, {
      sources: { FAST: 'alpaca:iex' }, degraded: ['FAST'],
    });
    r0.getTodayRows.mockReturnValue([{ ticker: 'FAST' }]);
    await runner.runSetup(SETUP, { date: DATE });
    const f = store.recentFires(DATE).find(x => x.ticker === 'FAST');
    expect(f.setup.source).toBe('alpaca:iex');
    expect(f.setup.feedWarning).toMatch(/IEX/);
  });

  test('a consolidated-tape pick carries no warning to ignore', async () => {
    feed({ FAST: rising(3) });
    r0.getTodayRows.mockReturnValue([{ ticker: 'FAST' }]);
    await runner.runSetup(SETUP, { date: DATE });
    expect(store.recentFires(DATE).find(x => x.ticker === 'FAST').setup.feedWarning).toBeNull();
  });
});

describe('ownership and dry runs', () => {
  test('a preview publishes nothing', async () => {
    feed({ FAST: rising(3) });
    const out = await runner.runSetup(SETUP, { date: DATE, dryRun: true });
    expect(out.picks).toHaveLength(1);
    expect(store.recentFires(DATE)).toHaveLength(0);
  });

  test('a preview can be given its own universe, so any tool can inspect it', async () => {
    feed({ AAA: rising(3) });
    await runner.runSetup(SETUP, { date: DATE, dryRun: true, tickers: ['AAA'] });
    expect(bars.fetchMorning).toHaveBeenCalledWith(['AAA'], DATE, expect.anything());
  });

  test('the wrong tool refuses to run it for real', async () => {
    const foreign = { ...SETUP, toolId: 'T7' };
    const out = await runner.runSetup(foreign, { date: DATE });
    expect(out.ok).toBe(false);
    expect(out.reason).toMatch(/belongs to T7/);
    expect(store.recentFires(DATE)).toHaveLength(0);
  });

  test('runDue only runs setups whose decision time matches', async () => {
    feed({ FAST: rising(3) });
    const none = await runner.runDue('11:30', { date: DATE });
    expect(none).toEqual([]);
    expect(bars.fetchMorning).not.toHaveBeenCalled();
  });
});

/*
 * The setup RANKS and takes the top two, so every candidate's extension has to
 * be measured on the same tape. Feeds disagree by more than the gap between
 * second place and fifth — measured against the spec's reference log, Yahoo and
 * Polygon extensions differed by up to 2.4 points — so a universe assembled
 * from two feeds is a ranking that is partly a ranking of feeds. It is allowed,
 * because deciding on four names out of forty is worse, but it is never silent.
 */
describe('mixed feeds', () => {
  test('a ranking built on more than one tape says so', async () => {
    feed({ FAST: rising(3), SLOW: rising(1) }, {
      mixed: true, used: ['polygon', 'yahoo'], feed: null,
      sources: { FAST: 'polygon', SLOW: 'yahoo' },
    });
    r0.getTodayRows.mockReturnValue([{ ticker: 'FAST' }, { ticker: 'SLOW' }]);
    await runner.runSetup(SETUP, { date: DATE });
    const warn = store.recentFires(DATE).find(f => f.level === 'warn');
    expect(warn.detail).toMatch(/mixed feeds \(polygon \+ yahoo\)/);
    expect(warn.detail).toMatch(/not directly comparable/);
  });

  test('one tape for everything raises nothing to ignore', async () => {
    feed({ FAST: rising(3), SLOW: rising(1) });
    r0.getTodayRows.mockReturnValue([{ ticker: 'FAST' }, { ticker: 'SLOW' }]);
    await runner.runSetup(SETUP, { date: DATE });
    expect(store.recentFires(DATE).some(f => f.level === 'warn')).toBe(false);
  });

  test('the feed is reported on the run, so a fire can be traced to its tape', async () => {
    feed({ FAST: rising(3) });
    r0.getTodayRows.mockReturnValue([{ ticker: 'FAST' }]);
    const out = await runner.runSetup(SETUP, { date: DATE });
    expect(out.data.feed).toBe('yahoo');
  });

  /*
   * The fetch reports a lot about its own quality, and every one of those
   * fields is optional to produce. A missing one must cost detail in the alert,
   * never the two trades the run was about to name.
   */
  test('a fetch that reports nothing about itself still produces the picks', async () => {
    bars.fetchMorning.mockResolvedValue({ bars: { FAST: rising(3) } });
    r0.getTodayRows.mockReturnValue([{ ticker: 'FAST' }]);
    const out = await runner.runSetup(SETUP, { date: DATE });
    expect(out.picks).toHaveLength(1);
    expect(store.recentFires(DATE).some(f => f.level === 'trade')).toBe(true);
  });
});

/*
 * The 09:59 bar closes at 10:00:00.000 and no feed is obliged to have published
 * it by then. Waiting for it indefinitely is the obvious choice and the wrong
 * one — the trade is entered at market on sight, so a minute of waiting costs
 * more than the bar is worth. Deciding on an earlier bar is the right trade-off
 * AND a different decision from the tested one, so it is never silent.
 */
describe('when the decision bar has not been published', () => {
  /** A morning that stops early, as a slow feed would deliver it at 10:00. */
  function short(mult, bars = 26) {          // 09:30 … 09:55
    return rising(mult).slice(0, bars);
  }

  test('the run still produces the trade rather than waiting past the minute', async () => {
    feed({ FAST: short(3) });
    r0.getTodayRows.mockReturnValue([{ ticker: 'FAST' }]);
    const out = await runner.runSetup(SETUP, { date: DATE });
    expect(out.picks).toHaveLength(1);
    expect(store.recentFires(DATE).some(f => f.level === 'trade')).toBe(true);
  });

  test('and says which bar it actually used', async () => {
    feed({ FAST: short(3) });
    r0.getTodayRows.mockReturnValue([{ ticker: 'FAST' }]);
    await runner.runSetup(SETUP, { date: DATE });
    const warn = store.recentFires(DATE).find(f => f.level === 'warn');
    expect(warn.detail).toMatch(/09:59 bar had not been published/);
    expect(warn.detail).toMatch(/FAST was decided on 09:55/);
  });

  test('the bar used is on the pick itself, not only in the warning', async () => {
    feed({ FAST: short(3) });
    r0.getTodayRows.mockReturnValue([{ ticker: 'FAST' }]);
    await runner.runSetup(SETUP, { date: DATE });
    expect(store.recentFires(DATE).find(f => f.ticker === 'FAST').setup.decisionAt)
      .toBe('09:55');
  });

  test('a complete morning raises nothing', async () => {
    feed({ FAST: rising(3) });
    r0.getTodayRows.mockReturnValue([{ ticker: 'FAST' }]);
    await runner.runSetup(SETUP, { date: DATE });
    expect(store.recentFires(DATE).some(f => f.level === 'warn')).toBe(false);
    expect(store.recentFires(DATE).find(f => f.ticker === 'FAST').setup.decisionAt)
      .toBe('09:59');
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
    feed({ FAST: rising(3) });
    r0.getTodayRows.mockReturnValue([{ ticker: 'FAST' }]);
    await runner.runSetup(SETUP, { date: DATE });
    const f = store.recentFires(DATE).find(x => x.ticker === 'FAST');
    expect(f.setup.size).toBeNull();
    expect(f.detail).toMatch(/^BUY FAST/);          // no invented quantity
    risk.settings.mockRestore();
  });

  test('leads the alert text once they are set', async () => {
    jest.spyOn(risk, 'settings').mockReturnValue({
      accountSize: 25000, riskPerTrade: 250, maxPositionPct: 100, updatedAt: 1 });
    feed({ FAST: rising(3) });
    r0.getTodayRows.mockReturnValue([{ ticker: 'FAST' }]);
    await runner.runSetup(SETUP, { date: DATE });
    const f = store.recentFires(DATE).find(x => x.ticker === 'FAST');
    expect(f.setup.size.shares).toBeGreaterThan(0);
    expect(f.detail).toMatch(new RegExp(`^BUY ${f.setup.size.shares} FAST`));
    // What it actually risks must be at or under what was asked for.
    expect(f.setup.size.riskDollars).toBeLessThanOrEqual(250);
    risk.settings.mockRestore();
  });
});
