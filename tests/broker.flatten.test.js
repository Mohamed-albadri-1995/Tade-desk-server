/*
 * Closing what the box opened, before the bell.
 *
 * THE HOLE THIS FILLS. A strategy can leave part of a position with no exit the
 * broker can hold. "Take half at 2R and let the rest run" — the 09:35
 * opening-range setup does exactly this — sends a runner with a stop and no
 * target. A backtest closes it at the session's end. A broker does not: it sits
 * there overnight, in an account that is not allowed to hold overnight, and
 * nothing anywhere says so.
 */

const os = require('os');
const path = require('path');
const fs = require('fs');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'flatten-'));
process.env.BROKER_FILE = path.join(DIR, 'broker.json');
process.env.BROKER_LEDGER = path.join(DIR, 'orders.jsonl');
process.env.ALERT_RULES_FILE = path.join(DIR, 'rules.json');
process.env.ALERT_FIRES_FILE = path.join(DIR, 'fires.json');
process.env.ALERT_HISTORY_DIR = path.join(DIR, 'history');

jest.mock('../src/broker/reconcile', () => ({
  // Unasked by default: the flatten then behaves exactly as it did before the
  // broker was consulted at all — today's ledger and nothing else.
  carriedOver: jest.fn(async () => ({ ok: false, error: 'not asked' })),
  alpacaDestinations: jest.fn(() => ['alp']),
}));

const broker = require('../src/broker/signalstack');
const reconcile = require('../src/broker/reconcile');
const flattener = require('../src/alerts/flattener');
const store = require('../src/alerts/store');

const HOOK = 'https://app.signalstack.com/hook/FAKEhook0000000000000a';
const DAY = '2026-08-10';                       // a Monday
const ok = () => ({ ok: true, status: 201, text: async () => '{"id":"C1","status":"filled"}' });

let sent;
function armed(extra = {}) {
  broker.save({ webhookUrl: HOOK, buyingPower: 100000, enabled: true, ...extra });
  broker.save({ armed: true });
}

beforeEach(() => {
  for (const f of ['broker.json', 'orders.jsonl', 'fires.json']) {
    fs.rmSync(path.join(DIR, f), { force: true });
  }
  flattener.reset();
  sent = [];
  global.fetch = jest.fn(async (url, opts) => {
    sent.push(JSON.parse(opts.body)); return ok();
  });
  reconcile.carriedOver.mockReset();
  reconcile.carriedOver.mockResolvedValue({ ok: false, error: 'not asked' });
});
afterAll(() => { fs.rmSync(DIR, { recursive: true, force: true }); });

const buy = (symbol, over = {}) => broker.placeOrder({
  symbol, signal: 'LONG', quantity: 10, price: 29.05, stop: 27.68,
  date: DAY, ...over,
});

// ── what is believed to be open ───────────────────────────────────────────

test('a symbol that was bought is believed open', async () => {
  armed();
  await buy('LIFE');
  expect(broker.openSymbols(DAY)).toEqual(['LIFE']);
});

test('a symbol that was refused is not', async () => {
  armed();
  global.fetch = jest.fn(async () => ({
    ok: false, status: 400, text: async () => '{"status":"ValidationError","message":"no"}',
  }));
  await buy('LIFE');
  expect(broker.openSymbols(DAY)).toEqual([]);
});

test('a symbol already closed is not offered again', async () => {
  armed();
  await buy('LIFE');
  await broker.closePosition('LIFE', DAY);
  expect(broker.openSymbols(DAY)).toEqual([]);
});

/* A scale-out is several orders in one symbol and one position to close. */
test('a scale-out counts once', async () => {
  armed();
  await buy('LIFE', { quantity: 40, target: 31.79, plan: {
    runner: 0.5, legs: [{ fraction: 0.5, price: 31.79 }] } });
  expect(broker.openSymbols(DAY)).toEqual(['LIFE']);
});

test("yesterday's positions are not today's problem", async () => {
  armed();
  await buy('LIFE', { date: '2026-08-07' });
  expect(broker.openSymbols(DAY)).toEqual([]);
});

// ── closing ───────────────────────────────────────────────────────────────

test('close takes no quantity — the whole position goes', async () => {
  armed();
  await broker.closePosition('LIFE', DAY);
  expect(sent[0]).toEqual({ symbol: 'LIFE', action: 'close' });
});

test('nothing is closed when the box was never armed', async () => {
  broker.save({ webhookUrl: HOOK, buyingPower: 100, enabled: true });
  const out = await broker.closePosition('LIFE', DAY);
  expect(out.sent).toBe(false);
  expect(global.fetch).not.toHaveBeenCalled();
});

// ── the clock ─────────────────────────────────────────────────────────────

/** 15:50 ET on Monday 2026-08-10 (EDT, UTC−4). */
const AT_1550 = Date.UTC(2026, 7, 10, 19, 50);
const AT_1500 = Date.UTC(2026, 7, 10, 19, 0);
const SATURDAY = Date.UTC(2026, 7, 8, 19, 50);

test('it closes everything at the configured minute', async () => {
  armed();
  await buy('LIFE'); await buy('LSCC');
  sent = [];

  const out = await flattener.check(AT_1550);
  expect(out.closed.sort()).toEqual(['LIFE', 'LSCC']);
  expect(sent).toEqual([
    { symbol: 'LIFE', action: 'close' }, { symbol: 'LSCC', action: 'close' },
  ]);
  expect(broker.openSymbols(DAY)).toEqual([]);
});

test('it does nothing at any other minute', async () => {
  armed();
  await buy('LIFE');
  sent = [];
  expect((await flattener.check(AT_1500)).ran).toBe(false);
  expect(sent).toEqual([]);
});

test('it does not run at the weekend', async () => {
  armed();
  await buy('LIFE');
  sent = [];
  expect((await flattener.check(SATURDAY)).ran).toBe(false);
});

/* A minute tick can fire twice inside the same minute. Closing twice is not
 * harmful at the broker, but it is two alerts and two ledger lines saying
 * different things about one event. */
test('it runs once a session', async () => {
  armed();
  await buy('LIFE');
  await flattener.check(AT_1550);
  sent = [];
  expect((await flattener.check(AT_1550)).ran).toBe(false);
  expect(sent).toEqual([]);
});

test('it can be switched off, and then nothing closes', async () => {
  armed({ flatten: false });
  await buy('LIFE');
  sent = [];
  expect((await flattener.check(AT_1550)).ran).toBe(false);
});

test('the time is configurable and must look like a time', () => {
  armed();
  broker.save({ flattenAt: '15:45' });
  expect(broker.settings().flattenAt).toBe('15:45');
  expect(() => broker.save({ flattenAt: 'soon' })).toThrow(/15:50/);
});

// ── saying so ─────────────────────────────────────────────────────────────

test('a clean close is reported, not silent', async () => {
  armed();
  await buy('LIFE');
  await flattener.check(AT_1550);
  const f = store.recentFires(DAY).find(x => x.rule === 'End of session');
  expect(f.level).toBe('info');
  expect(f.detail).toMatch(/Closed at 15:50: LIFE/);
});

/*
 * The one that matters. A position that could not be closed is ten minutes from
 * being an overnight hold, and from a phone that must not look like the clean
 * case or like nothing having happened.
 */
test('a close that fails is an error alert naming the symbol', async () => {
  armed();
  await buy('LIFE');
  global.fetch = jest.fn(async () => ({
    ok: false, status: 400,
    text: async () => '{"status":"ExecutionError","message":"TradeThePool: no position"}',
  }));
  const out = await flattener.check(AT_1550);
  expect(out.failed).toHaveLength(1);

  const f = store.recentFires(DAY).find(x => x.rule === 'End of session');
  expect(f.level).toBe('error');
  expect(f.detail).toMatch(/COULD NOT CLOSE LIFE/);
  expect(f.detail).toMatch(/before the bell/);
});

test('a quiet day closes nothing and says nothing', async () => {
  armed();
  const out = await flattener.check(AT_1550);
  expect(out.closed).toEqual([]);
  expect(store.recentFires(DAY)).toHaveLength(0);
});

// ── the hole that let two positions sit in the account ─────────────────────
/*
 * WHAT WAS FOUND BY OPENING THE BROKER'S APP: two names still open that should
 * have been flat days earlier.
 *
 * This function read openSymbols(TODAY), and the ledger is keyed by day. A
 * position not closed on the day it was opened — this process down at 15:50,
 * the desk disarmed, a close refused — is invisible to every flatten that
 * follows: the next day asks about a new date, finds nothing, closes nothing.
 * Not missed once. Missed for good.
 *
 * So it now also asks Alpaca what is actually held, and closes what THIS DESK
 * opened on an earlier day. What it did not open, it names and leaves.
 */
describe('a position carried in from an earlier session', () => {
  const carried = (symbol = 'VIK', over = {}) => ({
    ok: true, running: [], foreign: [],
    carried: [{ symbol, qty: 100, side: 'long', openedOn: '2026-08-07',
                setupId: 'S@09:35', destinations: ['alp'], ...over }],
  });

  test('is closed, even though today\'s ledger is empty', async () => {
    armed();
    reconcile.carriedOver.mockResolvedValue(carried());
    const out = await flattener.check(AT_1550);
    expect(out.ran).toBe(true);
    expect(sent.map(b => b.symbol)).toEqual(['VIK']);
    expect(sent[0].action).toBe('close');
  });

  test('and the alert says it came from an earlier day', async () => {
    armed();
    reconcile.carriedOver.mockResolvedValue(carried());
    await flattener.check(AT_1550);
    const said = store.recentFires(DAY).find(f => f.rule === 'End of session');
    expect(said.detail).toMatch(/EARLIER session/);
    expect(said.detail).toMatch(/VIK/);
  });

  test('one already in today\'s ledger is not closed twice', async () => {
    armed();
    await buy('LIFE');
    reconcile.carriedOver.mockResolvedValue({
      ok: true, running: [], foreign: [],
      carried: [{ symbol: 'LIFE', qty: 10, openedOn: DAY, destinations: ['alp'] }],
    });
    sent.length = 0;
    await flattener.check(AT_1550);
    expect(sent.filter(b => b.symbol === 'LIFE' && b.action === 'close')).toHaveLength(1);
  });

  /*
   * A POSITION THIS DESK NEVER OPENED IS NOT THIS DESK'S TO CLOSE. It may be a
   * trade taken by hand. Named at error level, and left exactly where it is.
   */
  test('one nothing here opened is named and NOT closed', async () => {
    armed();
    reconcile.carriedOver.mockResolvedValue({
      ok: true, running: [], carried: [],
      foreign: [{ symbol: 'NVDA', qty: 50, why: 'nothing in this ledger ever opened it' }],
    });
    const out = await flattener.check(AT_1550);
    expect(out.ran).toBe(true);
    expect(sent).toHaveLength(0);
    const said = store.recentFires(DAY).find(f => f.rule === 'End of session');
    expect(said.level).toBe('error');
    expect(said.detail).toMatch(/ALPACA STILL HOLDS NVDA \(50\)/);
    expect(said.detail).toMatch(/NOT closed/);
  });

  /*
   * An unreachable broker must not read as a clean account. Today's ledger is
   * still closed — that half never depended on Alpaca — and the alert says the
   * other half could not be checked.
   */
  test('an unreachable Alpaca still closes today, and says what it could not check', async () => {
    armed();
    await buy('LIFE');
    reconcile.carriedOver.mockResolvedValue({ ok: false, error: 'timed out' });
    sent.length = 0;
    await flattener.check(AT_1550);
    expect(sent.map(b => b.symbol)).toEqual(['LIFE']);
    const said = store.recentFires(DAY).find(f => f.rule === 'End of session');
    expect(said.detail).toMatch(/could not ask Alpaca what is really open \(timed out\)/);
  });

  test('nothing anywhere is still nothing to do', async () => {
    armed();
    reconcile.carriedOver.mockResolvedValue({ ok: true, carried: [], foreign: [], running: [] });
    const out = await flattener.check(AT_1550);
    expect(out.closed).toEqual([]);
    expect(sent).toHaveLength(0);
  });
});
