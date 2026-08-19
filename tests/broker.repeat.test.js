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

// ── the cap counts POSITIONS ───────────────────────────────────────────────
/*
 * THE FAULT THIS FOUND, on a live session.
 *
 * OR + VWAP took CBRS at 09:36 into both accounts. Forty seconds later BRUN
 * qualified and was refused, in both, with
 *
 *     this setup's limit of 2 order(s) a day is already used
 *
 * — because the cap counted LEDGER ROWS and a row is written per account. Two
 * accounts turned one trade into two of the allowance, so a cap of 2 meant one
 * trade, and the message pointed at a setting that was not the problem.
 *
 * The scale-out half was already right: three legs go out inside one call and
 * write one row. Counting distinct SYMBOLS makes the cap mean the same thing
 * however many accounts are wired up and however many ways out a strategy has.
 */
describe("a setup's daily cap is counted in positions", () => {
  const two = () => { armed({ two: true }); return ['alp', 'ttp']; };

  test('one signal into two accounts spends ONE of the allowance', async () => {
    for (const d of two()) {
      await broker.placeOrder({ ...entry({ symbol: 'CBRS', maxPerDay: 2 }),
        cfg: broker.destinationCfg(d) });
    }
    expect(broker.positionsToday(DAY, 'test-strategy')).toBe(1);
    expect(sent).toHaveLength(2);
  });

  /* The second NAME must still get through — this is the trade that was lost. */
  test('a second name still trades under a cap of 2', async () => {
    for (const d of two()) {
      await broker.placeOrder({ ...entry({ symbol: 'CBRS', maxPerDay: 2 }),
        cfg: broker.destinationCfg(d) });
    }
    sent = [];
    for (const d of ['alp', 'ttp']) {
      const out = await broker.placeOrder({ ...entry({ symbol: 'BRUN', maxPerDay: 2 }),
        cfg: broker.destinationCfg(d) });
      expect(out.sent).toBe(true);
    }
    expect(sent).toHaveLength(2);
    expect(broker.positionsToday(DAY, 'test-strategy')).toBe(2);
  });

  /*
   * THE NEAR-MISS. Counting positions alone reproduced the original bug one
   * step later: CBRS counted, BRUN counted, and then BRUN'S SECOND ACCOUNT
   * refused as the "third position" when it is the second half of the second.
   * The desk would trade every signal in one account and the last one in
   * neither — which looks like a cap working.
   */
  test('the LAST name still reaches its second account when the cap is full', async () => {
    two();
    await broker.placeOrder({ ...entry({ symbol: 'CBRS', maxPerDay: 2 }),
      cfg: broker.destinationCfg('alp') });
    await broker.placeOrder({ ...entry({ symbol: 'CBRS', maxPerDay: 2 }),
      cfg: broker.destinationCfg('ttp') });
    // BRUN fills the cap on its first account...
    const first = await broker.placeOrder({ ...entry({ symbol: 'BRUN', maxPerDay: 2 }),
      cfg: broker.destinationCfg('alp') });
    expect(first.sent).toBe(true);
    expect(broker.positionsToday(DAY, 'test-strategy')).toBe(2);
    // ...and its second account must STILL get it. Same trade, not a third one.
    const second = await broker.placeOrder({ ...entry({ symbol: 'BRUN', maxPerDay: 2 }),
      cfg: broker.destinationCfg('ttp') });
    expect(second.sent).toBe(true);
    expect(second.skipped).toBeFalsy();
  });

  test('the THIRD name is refused — the cap still means something', async () => {
    two();
    for (const sym of ['CBRS', 'BRUN']) {
      for (const d of ['alp', 'ttp']) {
        await broker.placeOrder({ ...entry({ symbol: sym, maxPerDay: 2 }),
          cfg: broker.destinationCfg(d) });
      }
    }
    const out = await broker.placeOrder({ ...entry({ symbol: 'VIK', maxPerDay: 2 }),
      cfg: broker.destinationCfg('alp') });
    expect(out.sent).toBe(false);
    expect(out.skipped).toMatch(/limit of 2 position\(s\) a day/);
  });

  /*
   * A three-leg scale-out is one position, not three. Already true before this
   * change, and pinned here because the two rules now share a counter.
   */
  test('a scale-out spends one of the allowance, not one per leg', async () => {
    const cfg = armed();
    await broker.placeOrder({
      ...entry({ symbol: 'CBRS', quantity: 30, maxPerDay: 2 }),
      plan: { legs: [{ fraction: 0.34, r_multiple: 1, price: 10.5 },
                     { fraction: 0.33, r_multiple: 2, price: 11 }], runner: 0.33 },
      cfg });
    expect(broker.positionsToday(DAY, 'test-strategy')).toBe(1);
    const out = await broker.placeOrder({ ...entry({ symbol: 'BRUN', maxPerDay: 2 }), cfg });
    expect(out.sent).toBe(true);
  });

  /*
   * A REPEAT is refused as a repeat, not as a cap. The two messages send you to
   * different settings, and "your daily limit is used" about a name you are
   * already holding is the wrong one.
   */
  test('a repeat says repeat, even when the cap is also full', async () => {
    const cfg = armed();
    for (const sym of ['CBRS', 'BRUN']) {
      await broker.placeOrder({ ...entry({ symbol: sym, maxPerDay: 2 }), cfg });
    }
    const out = await broker.placeOrder({ ...entry({ symbol: 'CBRS', maxPerDay: 2 }), cfg });
    expect(out.sent).toBe(false);
    expect(out.skipped).toMatch(/already traded by this setup today/);
    expect(out.skipped).not.toMatch(/limit/);
  });

  test('a refused order never spends the allowance', async () => {
    const cfg = armed();
    global.fetch = jest.fn(async () => ({
      ok: false, status: 422, text: async () => JSON.stringify({ message: 'no' }) }));
    await broker.placeOrder({ ...entry({ symbol: 'CBRS', maxPerDay: 1 }), cfg });
    expect(broker.positionsToday(DAY, 'test-strategy')).toBe(0);
  });
});

// ── the floor on a position ────────────────────────────────────────────────
/*
 * Under three shares an account sits the trade out.
 *
 * WHY, from a live session: TTP5k is at ratio 0.05, so on a $238 stock it was
 * sized to ONE share — and one share cannot be split 50/50. splitLegs gave the
 * whole thing to one part, so the account placed a SINGLE-EXIT version of a
 * two-leg strategy. Nothing about that looks wrong in the ledger: an order went,
 * it filled, the shares add up.
 *
 * Three because it is the fewest that can be split three ways, which is the
 * widest shape anything here runs. The other two reasons are arithmetic: the
 * per-order fee is fixed, so on one share it is most of the move; and flooring
 * 1.4 to 1 is a 29% sizing error the risk settings never asked for.
 */
describe('a position too small to hold the strategy', () => {
  test('one share is not sent', async () => {
    const cfg = armed();
    const out = await broker.placeOrder({ ...entry({ quantity: 1 }), cfg });
    expect(out.sent).toBe(false);
    expect(out.skipped).toMatch(/under this account's minimum of 3/);
    expect(sent).toHaveLength(0);
  });

  test('two are not sent either', async () => {
    const cfg = armed();
    const out = await broker.placeOrder({ ...entry({ quantity: 2 }), cfg });
    expect(out.sent).toBe(false);
    expect(sent).toHaveLength(0);
  });

  test('three are', async () => {
    const cfg = armed();
    const out = await broker.placeOrder({ ...entry({ quantity: 3 }), cfg });
    expect(out.sent).toBe(true);
    expect(sent[0].body.quantity).toBe(3);
  });

  /*
   * PER ACCOUNT, because the sizing is per account. The same signal is ninety
   * shares in one and one in the other, and only the second sits it out — a
   * desk-wide rule would stop the account that could hold the trade perfectly
   * well.
   */
  test('the big account still trades what the small one skipped', async () => {
    armed({ two: true });
    const small = await broker.placeOrder({ ...entry({ quantity: 1 }),
      cfg: broker.destinationCfg('alp') });
    const big = await broker.placeOrder({ ...entry({ quantity: 90 }),
      cfg: broker.destinationCfg('ttp') });
    expect(small.sent).toBe(false);
    expect(big.sent).toBe(true);
    expect(sent).toHaveLength(1);
  });

  /*
   * Checked AFTER the buying-power fit, so it counts what would REALLY be sent.
   * A 90-share order cut to 2 by a nearly empty account is exactly the case
   * this exists for — and it is what the whole of yesterday afternoon looked
   * like once the duplicate entries had drained both accounts.
   */
  test('an order CUT to under three by buying power is not sent', async () => {
    broker.save({
      destinations: [{ id: 'alp', name: 'Alpaca paper', dialect: 'alpaca', webhookUrl: HOOK,
        buyingPower: 25, ratio: 1, mode: 'auto', setups: [] }],
      enabled: true });
    broker.save({ armed: true, allowShort: true });
    const out = await broker.placeOrder({ ...entry({ quantity: 90 }),
      cfg: broker.destinationCfg('alp') });
    expect(out.sent).toBe(false);
    expect(out.skipped).toMatch(/under this account's minimum/);
    expect(sent).toHaveLength(0);
  });

  test('an account can set its own floor', async () => {
    broker.save({
      destinations: [{ id: 'alp', name: 'Alpaca paper', dialect: 'alpaca', webhookUrl: HOOK,
        buyingPower: 100000, ratio: 1, mode: 'auto', setups: [], minShares: 10 }],
      enabled: true });
    broker.save({ armed: true, allowShort: true });
    const out = await broker.placeOrder({ ...entry({ quantity: 5 }),
      cfg: broker.destinationCfg('alp') });
    expect(out.sent).toBe(false);
    expect(out.skipped).toMatch(/minimum of 10/);
  });

  /* A floor of 1 is the old behaviour, for a desk that really does want it. */
  test('a floor of one switches it off', async () => {
    broker.save({
      destinations: [{ id: 'alp', name: 'Alpaca paper', dialect: 'alpaca', webhookUrl: HOOK,
        buyingPower: 100000, ratio: 1, mode: 'auto', setups: [], minShares: 1 }],
      enabled: true });
    broker.save({ armed: true, allowShort: true });
    const out = await broker.placeOrder({ ...entry({ quantity: 1 }),
      cfg: broker.destinationCfg('alp') });
    expect(out.sent).toBe(true);
  });

  /*
   * A skipped account must not consume the setup's allowance or retire the
   * name — it took no position, so tomorrow's counters and today's other
   * account both have to be unaffected.
   */
  test('sitting it out spends nothing', async () => {
    const cfg = armed();
    await broker.placeOrder({ ...entry({ quantity: 1, maxPerDay: 2 }), cfg });
    expect(broker.positionsToday(DAY, 'test-strategy')).toBe(0);
    expect(broker.sentAlready(DAY, 'test-strategy', 'VIK', 'alp')).toBe(false);
    // ...and the name can still be taken when it IS big enough.
    const out = await broker.placeOrder({ ...entry({ quantity: 40, maxPerDay: 2 }), cfg });
    expect(out.sent).toBe(true);
  });

  test('a preview says the same thing the wire would', () => {
    const cfg = armed();
    const plan = broker.planOrder({ ...entry({ quantity: 2 }), cfg });
    expect(plan.blocked).toBe('min-size');
    expect(plan.body).toBeUndefined();
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

// ── what the trade assumed versus what it got ──────────────────────────────
/*
 * Everything about a trade is derived from `price` — the close of the bar the
 * strategy decided on. The order goes to market a minute or so later, so R,
 * both targets and the share count are all measured from a price that was never
 * traded. qp calls the fill model this uses "optimistic by ~one spread"; the
 * gap had simply never been measured, and an unmeasured cost is not a small one,
 * it is an unknown one.
 */
describe('slippage, signed against the position', () => {
  const s = (action, price, fill) =>
    broker.slipOf({ action, price }, { fillPrice: fill });

  test('a long that paid more got a WORSE price', () => {
    expect(s('buy', 5.39, 5.42).slip).toBeCloseTo(0.03, 6);
  });

  test('a long that paid less got a BETTER one', () => {
    expect(s('buy', 5.39, 5.36).slip).toBeCloseTo(-0.03, 6);
  });

  /*
   * THE SIGN IS THE POINT. Selling a short at 5.42 when it was priced at 5.39
   * is three cents BETTER; buying a long at 5.42 on the same numbers is three
   * cents worse. An unsigned difference reports the two identically and makes
   * the whole measurement useless on a desk that trades both ways.
   */
  test('a short that sold higher got a BETTER price — the mirror of the long', () => {
    expect(s('sell', 5.39, 5.42).slip).toBeCloseTo(-0.03, 6);
    expect(s('sell', 5.39, 5.36).slip).toBeCloseTo(0.03, 6);
  });

  test('it is also reported as a percentage of the price', () => {
    expect(s('buy', 100, 101).slipPct).toBeCloseTo(1.0, 6);
  });

  /*
   * A number invented from a missing fill is indistinguishable from a perfect
   * one, which is the worst available answer to "how much is this costing me".
   */
  test('an unconfirmed order has no slippage, not zero slippage', () => {
    expect(broker.slipOf({ action: 'buy', price: 5.39 }, null).slip).toBeNull();
    expect(broker.slipOf({ action: 'buy', price: 5.39 }, {}).slip).toBeNull();
    expect(broker.slipOf({ action: 'buy', price: null }, { fillPrice: 5.4 }).slip).toBeNull();
    expect(broker.slipOf({ action: 'buy', price: 0 }, { fillPrice: 5.4 }).slipPct).toBeNull();
  });

  test('it reaches the reconciled view, beside the price it is measured from', async () => {
    const cfg = armed();
    const out = await broker.placeOrder({ ...entry({ price: 10 }), cfg });
    broker.receiveCallback({ id: out.orderId, status: 'filled', price: 10.05 });
    const row = broker.reconciled(DAY).find(r => r.orderId === out.orderId);
    expect(row.confirmed).toBe(true);
    expect(row.slip).toBeCloseTo(0.05, 6);
  });
});
