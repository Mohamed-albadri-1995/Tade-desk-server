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
  const SMALL = { destinationId: 'ttp', destinationName: 'Trade The Pool', scale: 0.25 };
  const BIG = { destinationId: 'alpaca', destinationName: 'Alpaca', scale: 1 };
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
      cfgs: [{ ...SMALL, scale: null, accountSize: 100, riskPerTrade: 0.5 }, BIG], error: null });
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

  test('an account with no scale of its own is the standard account', async () => {
    // The single-broker case, which must not have changed at all.
    const spy = jest.spyOn(brokerMod, 'placeOrder')
      .mockResolvedValue({ sent: true, status: 'filled' });
    brokerMod.autoRoute.mockReturnValue({
      cfgs: [{ destinationId: 'ttp', destinationName: 'TTP' }], error: null });
    await runner.runSetup(SET, {});
    expect(spy.mock.calls[0][0].quantity).toBe(200);
  });
});
