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
jest.mock('../src/broker/reconcile', () => ({
  carriedOver: jest.fn(async () => ({ ok: false, error: 'not asked' })),
  flatSymbols: jest.fn(async () => null),
  alpacaDestinations: jest.fn(() => ['alp']),
}));

const qp = require('../src/setups/qpClient');
const catalog = require('../src/setups/catalog');
const store = require('../src/alerts/store');
const reconcile = require('../src/broker/reconcile');
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
  // Unasked by default — the loop then behaves exactly as it did before Alpaca
  // was consulted at all.
  reconcile.flatSymbols.mockReset();
  reconcile.flatSymbols.mockResolvedValue(null);
  reconcile.carriedOver.mockReset();
  reconcile.carriedOver.mockResolvedValue(unreachable());
  reconcile.alpacaDestinations.mockReturnValue(['alp']);
});
afterAll(() => { fs.rmSync(DIR, { recursive: true, force: true }); });

/*
 * What Alpaca is holding, in the shape reconcile.carriedOver() returns it.
 *
 * `running` is a position opened TODAY — the normal case. `carried` survived an
 * earlier session, `foreign` was never opened by this desk at all, and the two
 * are treated very differently: one gets closed, the other never is.
 */
const holds = (...symbols) => ({
  ok: true, carried: [], foreign: [],
  running: symbols.map(s => ({ symbol: s, qty: 100, side: 'long', openedOn: DAY })),
});
/* Alpaca answered and is holding nothing — NOT the same as not answering. */
const holdsNothing = () => ({ ok: true, carried: [], foreign: [], running: [] });
/* Alpaca could not be asked. Nothing may be filtered on this answer. */
const unreachable = (error = 'down') => ({ ok: false, error });

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

// ── the closed loop ────────────────────────────────────────────────────────
/*
 * The ledger is what we SENT minus what we CLOSED. It cannot see a stop or a
 * target that filled, so it over-reports by design — safe for the 15:50
 * flatten, wrong here: a close sent for a position that ended an hour ago is a
 * per-order fee and an "exit" alert for a trade that was already out.
 *
 * Alpaca will simply say. These are about believing it exactly as far as it can
 * be believed, and no further.
 */
describe('what the broker says is actually held', () => {
  test('a position Alpaca is FLAT in is not closed again', async () => {
    ledger([{}]);
    qp.manage.mockResolvedValue(answer({ exit_now: true }));
    reconcile.carriedOver.mockResolvedValue(holdsNothing());   // holding nothing
    const r = await manager.check(AT);
    expect(sent).toHaveLength(0);
    expect(r.acted[0].alreadyFlat).toBe(1);
  });

  test('a position Alpaca still holds IS closed', async () => {
    ledger([{}]);
    qp.manage.mockResolvedValue(answer({ exit_now: true }));
    reconcile.carriedOver.mockResolvedValue(holds('CBRS'));
    await manager.check(AT);
    expect(sent).toHaveLength(1);
  });

  /*
   * PER DESTINATION. Only Alpaca can be asked; Trade The Pool is behind
   * TraderEvolution and invisible. A name held in both and flat at Alpaca must
   * STILL be closed at the prop account — dropping the whole position would
   * leave that one holding it into the night.
   */
  test('an unverifiable account is still closed when Alpaca is flat', async () => {
    ledger([{ destination: 'alp' }, { destination: 'ttp' }]);
    qp.manage.mockResolvedValue(answer({ exit_now: true }));
    reconcile.carriedOver.mockResolvedValue(holdsNothing());
    await manager.check(AT);
    expect(sent).toHaveLength(1);                     // ttp only
    expect(sent[0].url).toContain('TESTfake');        // the TTP hook
  });

  /*
   * THE DISTINCTION THAT MATTERS MOST. "Alpaca says you hold nothing" and
   * "Alpaca did not answer" are opposite instructions, and a caller that cannot
   * tell them apart will eventually act on the wrong one. Unasked, nothing is
   * filtered.
   */
  test('an UNANSWERED question filters nothing — it is not an empty set', async () => {
    ledger([{}]);
    qp.manage.mockResolvedValue(answer({ exit_now: true }));
    reconcile.carriedOver.mockResolvedValue(unreachable());
    await manager.check(AT);
    expect(sent).toHaveLength(1);
  });

  test('and neither does Alpaca throwing', async () => {
    ledger([{}]);
    qp.manage.mockResolvedValue(answer({ exit_now: true }));
    reconcile.carriedOver.mockRejectedValue(new Error('down'));
    await manager.check(AT);
    expect(sent).toHaveLength(1);
  });

  test('it is asked ONCE per pass, not once per position', async () => {
    ledger([{ symbol: 'CBRS' }, { symbol: 'EYPT' }]);
    qp.manage.mockResolvedValue(answer({ exit_now: true }));
    reconcile.carriedOver.mockResolvedValue(holds('CBRS', 'EYPT'));
    await manager.check(AT);
    expect(reconcile.carriedOver).toHaveBeenCalledTimes(1);
    expect(sent).toHaveLength(2);
  });
});

// ── the one that was found by opening the broker's app ─────────────────────
/*
 * TWO POSITIONS WERE SITTING IN THE ALPACA ACCOUNT that should not have been.
 *
 * The 15:50 flatten reads openSymbols(TODAY), and the ledger is keyed by day.
 * So a position not closed on the day it was opened — the alerts process down
 * at 15:50, the desk disarmed, a close refused — is invisible to every flatten
 * that follows: the next morning asks about a new date, finds nothing, closes
 * nothing. It was not missed once. It was missed for good.
 *
 * And this loop could not see it either, because it asked Alpaca AFTER an early
 * return for "the ledger says nothing is open today" — which is exactly the
 * state a carried-over position produces.
 */
describe('a position that survived its own session', () => {
  const carried = (over = {}) => ({
    ok: true, foreign: [], running: [],
    carried: [{ symbol: 'VIK', qty: 100, side: 'long', openedOn: '2026-08-17',
                setupId: 'S@09:35', destinations: ['alp'], ...over }],
  });
  const foreign = (over = {}) => ({
    ok: true, carried: [], running: [],
    foreign: [{ symbol: 'VIK', qty: 100, side: 'long',
                why: 'nothing in this ledger ever opened it', ...over }],
  });

  test('is announced even when today\'s ledger is completely empty', async () => {
    ledger([]);
    reconcile.carriedOver.mockResolvedValue(carried());
    await manager.check(AT);
    const said = store.publishFires.mock.calls.flatMap(c => c[0]);
    expect(said.some(f => /ALPACA STILL HOLDS/.test(f.detail))).toBe(true);
  });

  /*
   * BEFORE the positions are counted. The old order asked Alpaca only after an
   * early return that a carried-over position guarantees you reach.
   */
  test('Alpaca is asked before the ledger decides there is nothing to do', async () => {
    ledger([]);
    reconcile.carriedOver.mockResolvedValue(holdsNothing());
    await manager.check(AT);
    expect(reconcile.carriedOver).toHaveBeenCalledTimes(1);
  });

  // A name of its own, because `announced` is per-process by design — a person
  // is told once, and these tests share one process.
  test('it says which day it was opened on, so the gap can be found', async () => {
    ledger([]);
    reconcile.carriedOver.mockResolvedValue(carried({ symbol: 'DAYSTAMP' }));
    await manager.check(AT);
    const said = store.publishFires.mock.calls.flatMap(c => c[0]);
    expect(said[0].detail).toMatch(/2026-08-17/);
    expect(said[0].level).toBe('error');
  });

  /*
   * A POSITION THIS DESK NEVER OPENED IS NOT THIS DESK'S TO CLOSE. It may be a
   * trade taken by hand for reasons no algorithm here knows about, and
   * flattening somebody's deliberate position without being asked is worse than
   * leaving it. Said loudly, and said to be left alone.
   */
  test('one nothing here opened is reported as NOT going to be closed', async () => {
    ledger([]);
    reconcile.carriedOver.mockResolvedValue(foreign());
    await manager.check(AT);
    const said = store.publishFires.mock.calls.flatMap(c => c[0]);
    expect(said[0].detail).toMatch(/NOTHING HERE OPENED IT/);
    expect(said[0].detail).toMatch(/will NOT be closed automatically/);
  });

  test('the two are never described the same way', async () => {
    ledger([]);
    reconcile.carriedOver.mockResolvedValue(carried({ symbol: 'MINE1' }));
    await manager.check(AT);
    const mine = store.publishFires.mock.calls.flatMap(c => c[0])[0].detail;
    store.publishFires.mockReset();
    reconcile.carriedOver.mockResolvedValue(foreign({ symbol: 'ZZZZ' }));
    await manager.check(AT);
    const theirs = store.publishFires.mock.calls.flatMap(c => c[0])[0].detail;
    expect(mine).toMatch(/WILL be closed/);
    expect(theirs).toMatch(/will NOT be closed/);
  });

  /* Once per name. Told every minute, a person stops reading. */
  test('it is said once, not once a minute', async () => {
    ledger([]);
    reconcile.carriedOver.mockResolvedValue(carried({ symbol: 'ONCEONLY' }));
    await manager.check(AT);
    await manager.check(AT + 60000);
    await manager.check(AT + 120000);
    const said = store.publishFires.mock.calls.flatMap(c => c[0])
      .filter(f => f.ticker === 'ONCEONLY');
    expect(said).toHaveLength(1);
  });

  /* An unreachable broker says nothing rather than inventing a clean account. */
  test('nothing is announced when Alpaca could not be asked', async () => {
    ledger([]);
    reconcile.carriedOver.mockResolvedValue(unreachable());
    await manager.check(AT);
    expect(store.publishFires).not.toHaveBeenCalled();
  });

  /*
   * A position running normally, opened today, is not a finding. Announcing
   * every healthy trade here would bury the two that matter.
   */
  test('a position opened today is not announced', async () => {
    ledger([]);
    reconcile.carriedOver.mockResolvedValue(holds('CBRS'));
    await manager.check(AT);
    expect(store.publishFires).not.toHaveBeenCalled();
  });
});

// ── the hour a live position went unwatched ────────────────────────────────
/*
 * WHAT HAPPENED. qp runs as a systemd service that the deploy does not touch,
 * so when the manager shipped, /api/strategy/manage did not exist on the
 * running process. Every pass got a 404 for an hour, with a real short open and
 * nothing evaluating its exit rule or moving its stop.
 *
 * The alert feed said NOTHING. The failure went to console.error, and a
 * position nobody was managing looked exactly like one that was fine. It was
 * found by grepping a pm2 log, and only because somebody thought to look.
 *
 * "An unanswered question is not hold" was already written in the comment above
 * that catch. It just was not true of anything a person would see.
 */
describe('a position that cannot be judged', () => {
  test('raises an alert, at error level, naming the position', async () => {
    ledger([{}]);
    qp.manage.mockRejectedValue(new Error('Request failed with status code 404'));
    await manager.check(AT);
    const said = store.publishFires.mock.calls.flatMap(c => c[0])
      .filter(f => f.ticker === 'CBRS');
    expect(said).toHaveLength(1);
    expect(said[0].level).toBe('error');
    expect(said[0].detail).toMatch(/NOBODY IS MANAGING THIS POSITION/);
  });

  /* The reason is carried, or the alert cannot be acted on. */
  test('it says what qp actually answered', async () => {
    ledger([{ symbol: 'WHYME' }]);
    qp.manage.mockRejectedValue(new Error('Request failed with status code 404'));
    await manager.check(AT);
    expect(store.publishFires.mock.calls.flatMap(c => c[0])[0].detail)
      .toMatch(/status code 404/);
  });

  /*
   * And what DOES still apply, because the answer to "so is it unprotected"
   * is no — the broker's fixed stop and the flatten are untouched. An alarm
   * that leaves that ambiguous gets acted on wrongly.
   */
  test('it says what still protects the position', async () => {
    ledger([{ symbol: 'STILLOK' }]);
    qp.manage.mockRejectedValue(new Error('down'));
    await manager.check(AT);
    expect(store.publishFires.mock.calls.flatMap(c => c[0])[0].detail)
      .toMatch(/fixed stop at the broker and the 15:50 flatten still apply/);
  });

  /* ONCE. A message a minute is what teaches you to stop reading the feed. */
  test('it is said once, not once a minute', async () => {
    ledger([{ symbol: 'NOISY' }]);
    qp.manage.mockRejectedValue(new Error('down'));
    await manager.check(AT);
    await manager.check(AT + 60000);
    await manager.check(AT + 120000);
    expect(store.publishFires.mock.calls.flatMap(c => c[0])
      .filter(f => f.ticker === 'NOISY')).toHaveLength(1);
  });

  /*
   * AND REARMED BY A RECOVERY. Unlike the carried-over alarm, "qp is down" is a
   * CONDITION rather than a fact: it can end and start again, and the second
   * outage is as worth knowing as the first. Latching it for the session would
   * make exactly one outage a day visible.
   */
  test('a later failure is announced again after a recovery', async () => {
    ledger([{ symbol: 'AGAIN' }]);
    qp.manage.mockRejectedValue(new Error('down'));
    await manager.check(AT);
    qp.manage.mockResolvedValue(answer({}));          // recovered
    await manager.check(AT + 60000);
    qp.manage.mockRejectedValue(new Error('down again'));
    await manager.check(AT + 120000);
    expect(store.publishFires.mock.calls.flatMap(c => c[0])
      .filter(f => f.ticker === 'AGAIN')).toHaveLength(2);
  });

  /* A healthy position says nothing at all — that is the common case. */
  test('nothing is said while it can be judged', async () => {
    ledger([{ symbol: 'FINE' }]);
    qp.manage.mockResolvedValue(answer({}));
    await manager.check(AT);
    expect(store.publishFires).not.toHaveBeenCalled();
  });

  /*
   * ONE POSITION MUST NOT STOP THE OTHERS — the others may be the ones that
   * need closing. The alert is per symbol for the same reason.
   */
  test('one unjudgeable position does not stop the rest of the pass', async () => {
    ledger([{ symbol: 'BROKEN' }, { symbol: 'WORKS' }]);
    qp.manage.mockImplementation(async ({ symbol }) => {
      if (symbol === 'BROKEN') throw new Error('down');
      return answer({ exit_now: true });
    });
    reconcile.carriedOver.mockResolvedValue(holds('WORKS'));
    const r = await manager.check(AT);
    expect(sent).toHaveLength(1);                      // WORKS was still closed
    expect(r.looked.find(p => p.symbol === 'BROKEN').error).toBeTruthy();
  });
});

describe('the deploy keeps qp in step', () => {
  const SH = fs.readFileSync(
    path.join(__dirname, '..', 'deploy-tools.sh'), 'utf8');

  /*
   * The warning that already existed fired only when quant-platform/ changed in
   * THAT pull — silent on every deploy afterwards. A note missed once was missed
   * for good while the desk stayed broken. A warning about an event cannot
   * detect a STATE.
   */
  test('it asks qp what it is RUNNING, not what the pull changed', () => {
    expect(SH).toMatch(/api\/health/);
    expect(SH).toMatch(/git rev-parse --short HEAD/);
    expect(SH).toMatch(/A warning about an event cannot detect a STATE/);
  });

  test('a stale qp is restarted, not mentioned', () => {
    expect(SH).toMatch(/sudo systemctl restart qp-chart/);
    expect(SH).toMatch(/STALE — running/);
  });

  test('and the restart is verified rather than assumed', () => {
    expect(SH).toMatch(/AFTER=/);
    expect(SH).toMatch(/STILL \$\{AFTER:-not answering\}/);
  });

  /*
   * NEVER FATAL. Running the screeners without qp is a normal setup, and a
   * failure here must not fail a deploy that otherwise worked.
   */
  test('no qp at all is not an error', () => {
    expect(SH).toMatch(/if \[ -d quant-platform \]; then/);
    expect(SH).toMatch(/no qp-chart service/);
  });
});

describe('the deploy re-runs itself when it changes', () => {
  const SH = fs.readFileSync(
    path.join(__dirname, '..', 'deploy-tools.sh'), 'utf8');

  /*
   * THE TRAP, walked into on the deploy that shipped the qp check itself. This
   * script pulls the repo, and the repo contains this script. `git reset --hard`
   * replaces the FILE, but bash is part-way through reading the OLD one through
   * an open handle — so it finishes with the old code and the change appears to
   * have done nothing. The qp section simply never printed, and the natural
   * reading of that is "it is broken", not "it is not there yet".
   *
   * A deploy script that only takes effect on the NEXT deploy is a trap with no
   * floor: every fix to it is silently one run late, including this one.
   */
  test('it notices when the pull changed it', () => {
    expect(SH).toMatch(/SELF_BEFORE=\$\(md5sum "\$SELF"/);
    expect(SH).toMatch(/SELF_AFTER=\$\(md5sum "\$SELF"/);
    expect(SH).toMatch(/bash is part-way through reading the OLD one/);
  });

  /* The hash has to be taken BEFORE the pull, or there is nothing to compare. */
  test('the before-hash is taken before the pull, not after', () => {
    expect(SH.indexOf('SELF_BEFORE=')).toBeLessThan(SH.indexOf('git fetch origin'));
  });

  test('and starts again so the new one runs', () => {
    expect(SH).toMatch(/exec bash "\$SELF" "\$@"/);
  });

  /*
   * GUARDED AGAINST LOOPING. The second run finds the file unchanged by its own
   * pull and falls through; the env var is belt to that brace, in a script
   * whose job is restarting a live desk.
   */
  test('it cannot loop', () => {
    expect(SH).toMatch(/\[ -z "\$\{DEPLOY_REEXECED:-\}" \]/);
    expect(SH).toMatch(/export DEPLOY_REEXECED=1/);
  });

  /* The arguments survive, or `deploy-tools.sh T2` would become a full deploy. */
  test('the arguments are carried across', () => {
    const at = SH.indexOf('exec bash "$SELF"');
    expect(SH.slice(at, at + 40)).toMatch(/"\$@"/);
  });
});
