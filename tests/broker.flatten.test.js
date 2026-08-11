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

const broker = require('../src/broker/signalstack');
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
