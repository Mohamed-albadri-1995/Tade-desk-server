/*
 * The same name, from the same setup, twice in one day.
 *
 * WHAT HAPPENED. A watch setup is asked the same question on every bar of its
 * window. `Test` runs 09:30–15:55, so that is several hundred asks, and a
 * condition that stays true is true for a lot of them. The runner had a latch
 * for exactly this — drop any name this setup has already ALERTED on today —
 * and the latch reads the alert feed.
 *
 * The alert is written after the order is sent.
 *
 * describePick() threw on a strategy with take-profit switched off. It threw
 * AFTER placeOrder had returned, so:
 *
 *     bar 1   order sent  →  alert throws  →  no fire, no latch
 *     bar 2   order sent  →  alert throws  →  no fire, no latch
 *     bar 3   ...
 *
 * every minute, at the per-order fee each time, on a desk that was armed. The
 * crash is fixed. This is about the shape of the mistake underneath it: a latch
 * that lives one step further along than the thing it is supposed to hold back
 * can always be jumped, and every future error on that step jumps it again.
 *
 * So the guard moved onto the LEDGER, which is written by the same call that
 * sends. Nothing can run between them and nothing can restart between them.
 */

const os = require('os');
const path = require('path');
const fs = require('fs');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'broker-repeat-'));
process.env.BROKER_FILE = path.join(DIR, 'broker.json');
process.env.BROKER_LEDGER = path.join(DIR, 'orders.jsonl');

jest.mock('../src/alpaca/client', () => ({
  checkShortable: jest.fn(async () => ({ ok: true, checked: true, shortable: true })),
}));

const broker = require('../src/broker/signalstack');

// Made-up hook ids — the real ones are credentials and live only in
// data/broker.json, which is gitignored.
const HOOK = 'https://app.signalstack.com/hook/FAKEhook0000000000000a';
const HOOK2 = 'https://app.signalstack.com/hook/TESTfake0000000000000000000';
const DAY = '2026-08-17';

let sent;
beforeEach(() => {
  fs.rmSync(process.env.BROKER_FILE, { force: true });
  fs.rmSync(process.env.BROKER_LEDGER, { force: true });
  sent = [];
  global.fetch = jest.fn(async (url, opts) => {
    sent.push({ url, body: JSON.parse(opts.body) });
    return { ok: true, status: 201,
             text: async () => JSON.stringify({ id: 'ID1', status: 'filled', price: 10 }) };
  });
});
afterAll(() => { fs.rmSync(DIR, { recursive: true, force: true }); });

function armed({ two = false } = {}) {
  broker.save({
    destinations: [
      { id: 'alp', name: 'Alpaca paper', dialect: 'alpaca', webhookUrl: HOOK,
        buyingPower: 100000, ratio: 1, mode: 'auto', setups: [] },
      ...(two ? [{ id: 'ttp', name: 'TTP', dialect: 'ttp', webhookUrl: HOOK2,
                   buyingPower: 100000, ratio: 1, mode: 'auto', setups: [] }] : []),
    ],
    enabled: true,
  });
  broker.save({ armed: true, allowShort: true });
  return broker.destinationCfg('alp');
}

const entry = (over = {}) => ({
  symbol: 'VIK', signal: 'LONG', quantity: 48, price: 10,
  stop: 9.5, target: 11, date: DAY, setupId: 'test-strategy', ...over,
});

// ── the failure that cost money ────────────────────────────────────────────

describe('a second order for a name this setup already traded', () => {
  test('the first one goes out', async () => {
    const cfg = armed();
    const out = await broker.placeOrder({ ...entry(), cfg });
    expect(out.sent).toBe(true);
    expect(sent).toHaveLength(1);
  });

  test('THE SECOND ONE DOES NOT', async () => {
    const cfg = armed();
    await broker.placeOrder({ ...entry(), cfg });
    const again = await broker.placeOrder({ ...entry(), cfg });

    expect(again.sent).toBe(false);
    expect(again.skipped).toMatch(/already traded by this setup today/i);
    expect(sent).toHaveLength(1);                 // still one on the wire
  });

  /*
   * The exact live sequence: the alert never got written, so the runner's own
   * latch never closed. The ledger holds it anyway — that is the entire point
   * of moving the guard.
   */
  test('and it holds when nothing else does — no alert, no memory, a restart', async () => {
    const cfg = armed();
    await broker.placeOrder({ ...entry(), cfg });

    // A restart: everything in memory is gone, the ledger file is not.
    jest.resetModules();
    const fresh = require('../src/broker/signalstack');
    const out = await fresh.placeOrder({ ...entry(), cfg: fresh.destinationCfg('alp') });

    expect(out.sent).toBe(false);
    expect(out.skipped).toMatch(/already traded/i);
    expect(sent).toHaveLength(1);
  });

  test('it is refused BEFORE the wire, not after — a preview says so too', async () => {
    const cfg = armed();
    await broker.placeOrder({ ...entry(), cfg });
    const plan = broker.planOrder({ ...entry(), cfg });
    expect(plan.blocked).toBe('repeat');
    expect(plan.body).toBeUndefined();
  });
});

// ── what must still get through ────────────────────────────────────────────

describe('what the guard must not block', () => {
  test('a DIFFERENT name from the same setup', async () => {
    const cfg = armed();
    await broker.placeOrder({ ...entry(), cfg });
    const out = await broker.placeOrder({ ...entry({ symbol: 'CLBT' }), cfg });
    expect(out.sent).toBe(true);
    expect(sent).toHaveLength(2);
  });

  test('the same name from a DIFFERENT setup', async () => {
    const cfg = armed();
    await broker.placeOrder({ ...entry(), cfg });
    const out = await broker.placeOrder({ ...entry({ setupId: 'or-vwap-0935-long' }), cfg });
    expect(out.sent).toBe(true);
  });

  /*
   * Two accounts on one signal is two orders ON PURPOSE. The account cap is
   * scoped per destination for the same reason, and a guard that was not would
   * silently make the second account stop trading.
   */
  test('the same signal into a second account', async () => {
    armed({ two: true });
    await broker.placeOrder({ ...entry(), cfg: broker.destinationCfg('alp') });
    const out = await broker.placeOrder({ ...entry(), cfg: broker.destinationCfg('ttp') });
    expect(out.sent).toBe(true);
    expect(sent).toHaveLength(2);
    expect(sent[0].url).not.toBe(sent[1].url);
  });

  test('the same name TOMORROW', async () => {
    const cfg = armed();
    await broker.placeOrder({ ...entry(), cfg });
    const out = await broker.placeOrder({ ...entry({ date: '2026-08-18' }), cfg });
    expect(out.sent).toBe(true);
  });

  /*
   * A SCALE-OUT is several orders and one signal. Its legs go out inside one
   * placeOrder call, so they pass the guard once — a guard that counted legs
   * would let leg 1 in and refuse the rest, which is not a smaller version of
   * the tested trade, it is a different one.
   */
  test('every leg of a scale-out, in one call', async () => {
    const cfg = armed();
    const out = await broker.placeOrder({
      ...entry({ quantity: 30 }),
      // Entry 10, stop 9.50 — so 1R is 10.50 and 2R is 11.00. A leg needs a
      // PRICE to be a resting order; `runner` is the fraction that rides on.
      plan: { legs: [{ fraction: 0.34, r_multiple: 1, price: 10.5 },
                     { fraction: 0.33, r_multiple: 2, price: 11 }],
              runner: 0.33 },
      cfg,
    });
    expect(out.sent).toBe(true);
    expect(sent.length).toBeGreaterThan(1);
    // ...and the whole scale-out counts as ONE trade against the name.
    const again = await broker.placeOrder({ ...entry({ quantity: 30 }), cfg });
    expect(again.sent).toBe(false);
    expect(again.skipped).toMatch(/already traded/i);
  });

  /*
   * The exit is not a repeat of the entry it closes. `close` never carries a
   * setupId and is recorded as kind:'flatten' — if the guard reached it, an
   * armed desk would hold positions overnight, which is worse than the bug it
   * exists to stop.
   */
  test('the end-of-session close', async () => {
    const cfg = armed();
    await broker.placeOrder({ ...entry(), cfg });
    const out = await broker.closePosition('VIK', DAY, cfg);
    expect(out.sent).toBe(true);
    expect(sent).toHaveLength(2);
    expect(sent[1].body).toMatchObject({ symbol: 'VIK', action: 'close' });
  });

  /*
   * A REFUSED order opened nothing. Counting it would retire the name for the
   * rest of the day on the strength of a trade that never happened — the same
   * class of mistake in the opposite direction.
   */
  test('a retry after a refusal', async () => {
    const cfg = armed();
    global.fetch = jest.fn(async () => ({
      ok: false, status: 422,
      text: async () => JSON.stringify({ message: 'rejected' }),
    }));
    const first = await broker.placeOrder({ ...entry(), cfg });
    expect(first.sent).toBe(false);

    sent = [];
    global.fetch = jest.fn(async (url, opts) => {
      sent.push({ url, body: JSON.parse(opts.body) });
      return { ok: true, status: 201,
               text: async () => JSON.stringify({ id: 'ID2', status: 'filled', price: 10 }) };
    });
    const second = await broker.placeOrder({ ...entry(), cfg });
    expect(second.sent).toBe(true);
    expect(sent).toHaveLength(1);
  });

  /*
   * A setup that does not name itself cannot be tracked, and must not be
   * lumped in with every other unnamed one — "no setupId" is not a setup.
   */
  test('an order with no setupId at all', async () => {
    const cfg = armed();
    await broker.placeOrder({ ...entry({ setupId: null }), cfg });
    const out = await broker.placeOrder({ ...entry({ setupId: null }), cfg });
    expect(out.sent).toBe(true);
    expect(sent).toHaveLength(2);
  });
});

// ── the question on its own ────────────────────────────────────────────────

describe('sentAlready', () => {
  test('answers no on an empty ledger, and no for a name it has not seen', async () => {
    armed();
    expect(broker.sentAlready(DAY, 'test-strategy', 'VIK', 'alp')).toBe(false);
    await broker.placeOrder({ ...entry(), cfg: broker.destinationCfg('alp') });
    expect(broker.sentAlready(DAY, 'test-strategy', 'VIK', 'alp')).toBe(true);
    expect(broker.sentAlready(DAY, 'test-strategy', 'CLBT', 'alp')).toBe(false);
  });

  test('the symbol is matched case-insensitively', async () => {
    armed();
    await broker.placeOrder({ ...entry(), cfg: broker.destinationCfg('alp') });
    expect(broker.sentAlready(DAY, 'test-strategy', 'vik', 'alp')).toBe(true);
  });

  test('a missing setup or symbol is never a repeat', () => {
    expect(broker.sentAlready(DAY, null, 'VIK', 'alp')).toBe(false);
    expect(broker.sentAlready(DAY, 'test-strategy', null, 'alp')).toBe(false);
  });
});
