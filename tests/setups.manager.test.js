/*
 * Watching a position after the orders have gone in.
 *
 * WHAT WAS MISSING, and it is the whole reason this file exists: between
 * placement and 15:50, nothing observed a position at all. A broker holds a
 * resting stop and a resting limit; two of the three live strategies need more
 * than that —
 *
 *   OR + VWAP 09:35   leaves on a RULE (close crossing back through VWAP), and
 *                     in the backtest that closes the ENTIRE remaining
 *                     position, runner included. Nothing evaluated it, so the
 *                     runner rode its stop to the bell — the tested win rate
 *                     was measured with an exit the live trade never used.
 *
 *   Test              has a stop that MOVES and ratchets.
 *
 * This loop is what closes that gap, and it is the only thing on the desk that
 * sends an order nobody asked for in the moment. So the tests are mostly about
 * when it must NOT act.
 */

const os = require('os');
const path = require('path');
const fs = require('fs');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'manager-'));
process.env.BROKER_FILE = path.join(DIR, 'broker.json');
process.env.BROKER_LEDGER = path.join(DIR, 'orders.jsonl');
process.env.DATA_DIR = DIR;

jest.mock('../src/setups/qpClient', () => ({ manage: jest.fn() }));
jest.mock('../src/setups/catalog', () => ({ list: jest.fn() }));
jest.mock('../src/alerts/store', () => ({ publishFires: jest.fn() }));

const qp = require('../src/setups/qpClient');
const catalog = require('../src/setups/catalog');
const store = require('../src/alerts/store');
const broker = require('../src/broker/signalstack');
const manager = require('../src/setups/manager');

// Made-up hook ids — the real ones live only in data/broker.json.
const HOOK = 'https://app.signalstack.com/hook/FAKEhook0000000000000a';
const HOOK2 = 'https://app.signalstack.com/hook/TESTfake0000000000000000000';

// A Tuesday, so the weekday guard never decides a test for us.
const DAY = '2026-08-18';
const AT = Date.parse('2026-08-18T14:40:00Z');      // 10:40 New York

let sent;
beforeEach(() => {
  fs.rmSync(process.env.BROKER_LEDGER, { force: true });
  fs.rmSync(process.env.BROKER_FILE, { force: true });
  sent = [];
  global.fetch = jest.fn(async (url, opts) => {
    sent.push({ url, body: JSON.parse(opts.body) });
    return { ok: true, status: 201,
             text: async () => JSON.stringify({ id: 'X', status: 'filled', price: 10 }) };
  });
  broker.save({
    destinations: [
      { id: 'alp', name: 'Alpaca', dialect: 'alpaca', webhookUrl: HOOK,
        buyingPower: 100000, ratio: 1, mode: 'auto', setups: [] },
      { id: 'ttp', name: 'TTP', dialect: 'ttp', webhookUrl: HOOK2,
        buyingPower: 100000, ratio: 1, mode: 'auto', setups: [] },
    ],
    enabled: true,
  });
  broker.save({ armed: true, allowShort: true });

  catalog.list.mockResolvedValue([
    { id: 'S@09:35', name: 'OR + VWAP 09:35', tf: '1m', feed: 'yahoo',
      strategies: ['OR + VWAP 09:35 (Long)', 'OR + VWAP 09:35 (Short)'] },
    { id: 'Test@09:30', name: 'Test', tf: '1m', feed: 'yahoo', strategies: ['Test'] },
  ]);
  qp.manage.mockReset();
  store.publishFires.mockReset();
});
afterAll(() => { fs.rmSync(DIR, { recursive: true, force: true }); });

/** An entry on the ledger, as placeOrder would have written it. */
const ledger = rows => fs.writeFileSync(process.env.BROKER_LEDGER,
  rows.map(r => JSON.stringify({
    date: DAY, at: Date.parse('2026-08-18T13:36:11Z'), sent: true,
    symbol: 'CBRS', signal: 'LONG', price: 10, stop: 9.5, quantity: 20,
    setupId: 'S@09:35', destination: 'alp', decisionBar: '09:35', ...r,
  })).join('\n'));

/** qp's answer, with the shape manage() really returns. */
const answer = over => ({
  ok: true, managed: true, has_exit_rule: true, exit_now: false,
  exit_bar: null, exit_bars_ago: null,
  stop_kind: 'fixed', stop_at_entry: 9.5, stop_now: 9.5,
  stop_moved: false, breached: false, stop_wrong_side: false, ...over,
});

// ── finding what is open ───────────────────────────────────────────────────

describe('which positions are open', () => {
  test('an entry with a setup id is one', () => {
    ledger([{}]);
    const open = manager.openPositions(DAY);
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ symbol: 'CBRS', side: 'long', setupId: 'S@09:35' });
  });

  /*
   * TWO ACCOUNTS ARE ONE POSITION. The same signal funded twice is one thing to
   * a strategy and two orders to a broker, and "should this close" is a
   * question about the strategy's position — asked twice it would answer twice
   * and close twice.
   */
  test('two accounts holding one signal is ONE position, with both destinations', () => {
    ledger([{ destination: 'alp' }, { destination: 'ttp' }]);
    const open = manager.openPositions(DAY);
    expect(open).toHaveLength(1);
    expect(open[0].destinations.sort()).toEqual(['alp', 'ttp']);
  });

  test('a symbol already flattened is not open', () => {
    ledger([{}, { kind: 'flatten', action: 'close', symbol: 'CBRS' }]);
    expect(manager.openPositions(DAY)).toHaveLength(0);
  });

  test('a refused order never opened anything', () => {
    ledger([{ sent: false, skipped: 'no' }]);
    expect(manager.openPositions(DAY)).toHaveLength(0);
  });

  test('an order with no setup id is not managed — nothing knows its strategy', () => {
    ledger([{ setupId: null }]);
    expect(manager.openPositions(DAY)).toHaveLength(0);
  });

  test('a short is read as a short', () => {
    ledger([{ signal: 'SHORT' }]);
    expect(manager.openPositions(DAY)[0].side).toBe('short');
  });

  test('two different names are two positions', () => {
    ledger([{ symbol: 'CBRS' }, { symbol: 'EYPT' }]);
    expect(manager.openPositions(DAY)).toHaveLength(2);
  });
});

// ── the entry bar ──────────────────────────────────────────────────────────

describe('which bar the position opened on', () => {
  /*
   * The SEND time is a whole bar late on a 1-minute strategy — the order left
   * at 09:36:11 for a decision made on the 09:35 bar. One bar out seeds the
   * ratchet from the wrong level and can skip the exact bar a cross fired on.
   */
  test('the decision bar is used when the order recorded one', () => {
    const { iso, exact } = manager.entryIsoOf({ decisionBar: '09:35', at: AT }, DAY);
    expect(iso).toBe('2026-08-18 09:35');
    expect(exact).toBe(true);
  });

  test('without one it falls back to the send time, and SAYS it did', () => {
    const { iso, exact } = manager.entryIsoOf(
      { decisionBar: null, at: Date.parse('2026-08-18T13:36:11Z') }, DAY);
    expect(iso).toBe('2026-08-18 09:36');       // ...a bar later than the truth
    expect(exact).toBe(false);
  });

  test('a malformed decision bar falls back rather than being passed on', () => {
    expect(manager.entryIsoOf({ decisionBar: 'nine thirty five', at: AT }, DAY).exact)
      .toBe(false);
  });
});

// ── which strategy ─────────────────────────────────────────────────────────

describe('which strategy a position belongs to', () => {
  test('a long picks the long half of the pair', async () => {
    const f = await manager.strategyFor({ setupId: 'S@09:35', side: 'long' });
    expect(f.name).toBe('OR + VWAP 09:35 (Long)');
  });

  test('a short picks the short half', async () => {
    const f = await manager.strategyFor({ setupId: 'S@09:35', side: 'short' });
    expect(f.name).toBe('OR + VWAP 09:35 (Short)');
  });

  test('a single-sided setup has only the one', async () => {
    const f = await manager.strategyFor({ setupId: 'Test@09:30', side: 'long' });
    expect(f.name).toBe('Test');
  });

  test('an unknown setup id is null, not a guess', async () => {
    expect(await manager.strategyFor({ setupId: 'gone', side: 'long' })).toBeNull();
  });
});

// ── when it acts ───────────────────────────────────────────────────────────

describe('closing on the exit rule', () => {
  test('the rule fires → the position is closed', async () => {
    ledger([{}]);
    qp.manage.mockResolvedValue(answer({ exit_now: true, exit_bars_ago: 0 }));
    const r = await manager.check(AT);
    expect(r.acted).toHaveLength(1);
    expect(sent).toHaveLength(1);
    expect(sent[0].body).toMatchObject({ symbol: 'CBRS', action: 'close' });
  });

  /*
   * A cross is an EDGE — true on the bar it crosses and false after. Caught a
   * few bars late it is still an exit, and the lateness is a real cost that
   * belongs on the alert rather than being rounded away.
   */
  test('a rule that fired bars ago still closes, and the lateness is said', async () => {
    ledger([{}]);
    qp.manage.mockResolvedValue(answer({ exit_now: true, exit_bars_ago: 4 }));
    await manager.check(AT);
    const detail = store.publishFires.mock.calls[0][0][0].detail;
    expect(detail).toMatch(/CLOSED CBRS/);
    expect(detail).toMatch(/4 bar\(s\) ago/);
    expect(detail).toMatch(/worse than the backtest/);
  });

  test('every account holding it is closed, not just the first', async () => {
    ledger([{ destination: 'alp' }, { destination: 'ttp' }]);
    qp.manage.mockResolvedValue(answer({ exit_now: true }));
    await manager.check(AT);
    expect(sent).toHaveLength(2);
    expect(sent[0].url).not.toBe(sent[1].url);
  });
});

describe('closing on a trailing stop', () => {
  test('an ANCHORED stop that is breached closes the position', async () => {
    ledger([{}]);
    qp.manage.mockResolvedValue(answer({
      has_exit_rule: false, stop_kind: 'anchored', stop_now: 10.4,
      stop_moved: true, breached: true }));
    await manager.check(AT);
    expect(sent).toHaveLength(1);
    expect(store.publishFires.mock.calls[0][0][0].detail).toMatch(/trailing stop at 10\.4/);
  });

  /*
   * A FIXED stop is the broker's job. It is already resting there as part of
   * the bracket, and closing the position here would take it out at market at
   * whatever this bar happens to be instead of at the level.
   */
  test('a FIXED stop is left to the broker even when price is through it', async () => {
    ledger([{}]);
    qp.manage.mockResolvedValue(answer({
      has_exit_rule: false, managed: false, stop_kind: 'fixed', breached: true }));
    await manager.check(AT);
    expect(sent).toHaveLength(0);
  });
});

// ── when it must NOT act ───────────────────────────────────────────────────

describe('what it refuses to do', () => {
  test('nothing at all when the desk is disarmed', async () => {
    broker.save({ armed: false });
    ledger([{}]);
    qp.manage.mockResolvedValue(answer({ exit_now: true }));
    const r = await manager.check(AT);
    expect(r.ran).toBe(false);
    expect(sent).toHaveLength(0);
    expect(qp.manage).not.toHaveBeenCalled();
  });

  test('nothing at the weekend', async () => {
    ledger([{}]);
    const sat = Date.parse('2026-08-22T14:40:00Z');
    expect((await manager.check(sat)).ran).toBe(false);
  });

  /*
   * A strategy the broker can hold entirely — a frozen stop and no exit rule,
   * which is T2 10:00 exactly — must be cheap AND silent. A message every
   * minute saying "nothing to do" is what teaches you to stop reading the feed.
   */
  test('a strategy with nothing to manage is left alone and says nothing', async () => {
    ledger([{}]);
    qp.manage.mockResolvedValue(answer({ managed: false, has_exit_rule: false }));
    const r = await manager.check(AT);
    expect(r.acted).toHaveLength(0);
    expect(sent).toHaveLength(0);
    expect(store.publishFires).not.toHaveBeenCalled();
  });

  test('a managed position with nothing true yet is left alone', async () => {
    ledger([{}]);
    qp.manage.mockResolvedValue(answer({ exit_now: false, breached: false }));
    await manager.check(AT);
    expect(sent).toHaveLength(0);
  });

  /*
   * THE ONE THAT WOULD HURT MOST. A stop computed onto the wrong side of the
   * entry means the anchor was already past the fill — stale line, a gap. Acting
   * on it flattens a position opened minutes ago on a level that is obviously
   * wrong. It is reported loudly and LEFT ALONE.
   */
  test('a stop on the wrong side of the entry is reported, never acted on', async () => {
    ledger([{}]);
    qp.manage.mockResolvedValue(answer({
      has_exit_rule: false, stop_kind: 'anchored', stop_now: 11.0,
      breached: true, stop_wrong_side: true }));
    await manager.check(AT);
    expect(sent).toHaveLength(0);
    const detail = store.publishFires.mock.calls[0][0][0].detail;
    expect(detail).toMatch(/WRONG SIDE/);
    expect(detail).toMatch(/NOT closing/);
  });

  /* ...unless the RULE says go, which is a judgement about price, not a level. */
  test('but the exit rule still closes it', async () => {
    ledger([{}]);
    qp.manage.mockResolvedValue(answer({
      exit_now: true, stop_kind: 'anchored', stop_wrong_side: true, breached: true }));
    await manager.check(AT);
    expect(sent).toHaveLength(1);
  });
});

// ── when it cannot tell ────────────────────────────────────────────────────

describe('an unanswered question is not "hold"', () => {
  test('qp failing on one name does not stop the others', async () => {
    ledger([{ symbol: 'CBRS' }, { symbol: 'EYPT' }]);
    qp.manage
      .mockRejectedValueOnce(new Error('qp is down'))
      .mockResolvedValueOnce(answer({ exit_now: true }));
    const r = await manager.check(AT);
    expect(sent).toHaveLength(1);                       // the second one closed
    expect(r.looked.some(l => l.error === 'qp is down')).toBe(true);
  });

  test('a position whose strategy has vanished is recorded, not closed', async () => {
    ledger([{ setupId: 'gone' }]);
    const r = await manager.check(AT);
    expect(sent).toHaveLength(0);
    expect(r.looked[0].skipped).toMatch(/no setup/);
  });

  /*
   * A close the broker REFUSES is worse than one never attempted: the exit
   * fired, the position is still on, and the desk believes otherwise unless
   * this says so.
   */
  test('a refused close is an ERROR telling you to do it by hand', async () => {
    ledger([{}]);
    qp.manage.mockResolvedValue(answer({ exit_now: true }));
    global.fetch = jest.fn(async () => ({
      ok: false, status: 422, text: async () => JSON.stringify({ message: 'nope' }) }));
    await manager.check(AT);
    const fire = store.publishFires.mock.calls[0][0][0];
    expect(fire.level).toBe('error');
    expect(fire.detail).toMatch(/COULD NOT CLOSE/);
    expect(fire.detail).toMatch(/by hand/);
  });
});

// ── the dry run ────────────────────────────────────────────────────────────

describe('dry run', () => {
  test('decides everything and sends nothing', async () => {
    ledger([{}]);
    qp.manage.mockResolvedValue(answer({ exit_now: true }));
    const r = await manager.check(AT, { dryRun: true });
    expect(r.acted).toHaveLength(1);
    expect(r.acted[0].dryRun).toBe(true);
    expect(sent).toHaveLength(0);
    expect(store.publishFires).not.toHaveBeenCalled();
  });
});
