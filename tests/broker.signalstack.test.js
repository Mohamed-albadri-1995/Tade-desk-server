/*
 * Sending real orders.
 *
 * This is the only code here that spends money, so what is pinned is not the
 * happy path — it is every way an order could be wrong and still look fine:
 *
 *   a fractional quantity, which the bridge does not round for us;
 *   an order larger than the account can take, sent whole to be rejected at the
 *     one second it cannot be retried;
 *   a network failure retried into a double position;
 *   an order that was refused and reported as though it went in.
 *
 * The default is OFF, and off has to be provable — a test suite for order
 * routing that does not assert the switch is not a test suite.
 */

const os = require('os');
const path = require('path');
const fs = require('fs');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'broker-'));
process.env.BROKER_FILE = path.join(DIR, 'broker.json');
process.env.BROKER_LEDGER = path.join(DIR, 'orders.jsonl');

const broker = require('../src/broker/signalstack');

/*
 * Made-up ids, deliberately. A hook URL is a credential — anyone holding one
 * can place orders in the account it is wired to — so the real ones live only
 * in data/broker.json, which is gitignored. These match the two shapes that
 * matter: an ordinary hook and a TEST- prefixed one.
 */
const HOOK = 'https://app.signalstack.com/hook/FAKEhook0000000000000a';
const TEST_HOOK = 'https://app.signalstack.com/hook/TESTfake0000000000000000000';
const DAY = '2026-08-10';

/** A configured, armed account with $10,000 to spend. */
function armed(extra = {}) {
  broker.save({ webhookUrl: HOOK, buyingPower: 10000, enabled: true, ...extra });
  broker.save({ armed: true });
}

/** SignalStack's documented replies. */
const filled = (price = 100) => ({
  ok: true, status: 201,
  text: async () => JSON.stringify({ id: 'ID12345', status: 'filled', price }),
});
const rejected = (message) => ({
  ok: false, status: 400,
  text: async () => JSON.stringify({ status: 'ValidationError', message }),
});

let sent;
beforeEach(() => {
  fs.rmSync(process.env.BROKER_FILE, { force: true });
  fs.rmSync(process.env.BROKER_LEDGER, { force: true });
  sent = [];
  global.fetch = jest.fn(async (url, opts) => {
    sent.push({ url, body: JSON.parse(opts.body) });
    return filled();
  });
});
afterAll(() => { fs.rmSync(DIR, { recursive: true, force: true }); });

const place = (over = {}) => broker.placeOrder({
  symbol: 'LIFE', signal: 'LONG', quantity: 40, price: 29.05,
  stop: 27.68, target: 31.79, date: DAY, ...over,
});

// ── the switches ──────────────────────────────────────────────────────────

test('nothing is sent until it is configured AND armed', async () => {
  expect((await place()).sent).toBe(false);
  expect(global.fetch).not.toHaveBeenCalled();

  broker.save({ webhookUrl: HOOK, buyingPower: 10000, enabled: true });
  const dry = await place();
  expect(dry.sent).toBe(false);
  expect(dry.skipped).toMatch(/not armed/);
  // …and it still says what it WOULD have sent, which is what makes arming a
  // decision rather than a leap.
  expect(dry.would).toEqual({ symbol: 'LIFE', quantity: 40, action: 'buy' });
  expect(global.fetch).not.toHaveBeenCalled();

  armed();
  expect((await place()).sent).toBe(true);
});

test('arming without a hook or without buying power is refused', () => {
  expect(() => broker.save({ armed: true })).toThrow(/webhook/i);
  broker.save({ webhookUrl: HOOK });
  expect(() => broker.save({ armed: true })).toThrow(/buying power/i);
});

test('a URL that is not a SignalStack hook is refused', () => {
  expect(() => broker.save({ webhookUrl: 'https://evil.example/hook/abc' })).toThrow();
  expect(() => broker.save({ webhookUrl: 'app.signalstack.com/hook/abc' })).toThrow();
  // The three real shapes, including the TEST prefix, are accepted.
  expect(() => broker.save({ webhookUrl: HOOK, testWebhookUrl: TEST_HOOK })).not.toThrow();
});

/* The URL is a credential: anyone holding it can trade the account. */
test('the hook URL is never returned to the page', () => {
  broker.save({ webhookUrl: HOOK, testWebhookUrl: TEST_HOOK });
  const pub = broker.publicSettings();
  expect(JSON.stringify(pub)).not.toContain('FAKEhook0000000000000a');
  expect(pub.webhookUrl).toMatch(/^…\/hook\/.+…/);
  expect(pub.hasWebhook).toBe(true);
});

// ── the body ──────────────────────────────────────────────────────────────

test('the body is the documented shape', async () => {
  armed();
  await place();
  expect(sent[0].url).toBe(HOOK);
  expect(sent[0].body).toEqual({
    symbol: 'LIFE', action: 'buy', quantity: 40, quantity_type: 'fixed',
    stop_loss_price: 27.68, take_profit_price: 31.79,
  });
});

/* 'fixed' means the number is SHARES. The alternative is 'cash', where the
 * same 40 means $40 of stock — a default that must not be left implicit. */
test('quantity_type is always stated', async () => {
  armed();
  await place();
  expect(sent[0].body.quantity_type).toBe('fixed');
});

test('a short opens with a sell', async () => {
  armed();
  await place({ signal: 'SHORT' });
  expect(sent[0].body.action).toBe('sell');
});

test('shorts can be switched off, for an account that cannot take them', async () => {
  armed({ allowShort: false });
  const out = await place({ signal: 'SHORT' });
  expect(out.sent).toBe(false);
  expect(out.skipped).toMatch(/short/i);
  expect(global.fetch).not.toHaveBeenCalled();
});

test('the bracket can be switched off, and then only the entry is sent', async () => {
  armed({ bracket: false });
  await place();
  expect(sent[0].body.stop_loss_price).toBeUndefined();
  expect(sent[0].body.take_profit_price).toBeUndefined();
  expect(sent[0].body.quantity).toBe(40);
});

// ── whole shares ──────────────────────────────────────────────────────────

describe('quantity is always a whole number', () => {
  test('a fraction is floored, never rounded up', async () => {
    armed();
    await place({ quantity: 40.9 });
    expect(sent[0].body.quantity).toBe(40);
    expect(Number.isInteger(sent[0].body.quantity)).toBe(true);
  });

  test('a quantity that floors to zero sends nothing', async () => {
    armed();
    const out = await place({ quantity: 0.6 });
    expect(out.sent).toBe(false);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('every cap still produces a whole number', async () => {
    armed({ maxOrderValue: 1000 });
    // 1000 / 29.05 = 34.42…
    await place();
    expect(sent[0].body.quantity).toBe(34);
    expect(Number.isInteger(sent[0].body.quantity)).toBe(true);
  });
});

// ── buying power ──────────────────────────────────────────────────────────

describe('fitting the buying power', () => {
  test('an order that fits is sent whole', () => {
    broker.save({ webhookUrl: HOOK, buyingPower: 10000, enabled: true });
    expect(broker.fitQuantity({ quantity: 40, price: 29.05, date: DAY }))
      .toMatchObject({ quantity: 40, reason: null });
  });

  test('an order too big is REDUCED rather than sent to be rejected', () => {
    broker.save({ webhookUrl: HOOK, buyingPower: 500, enabled: true });
    const fit = broker.fitQuantity({ quantity: 40, price: 29.05, date: DAY });
    expect(fit.quantity).toBe(17);            // floor(500 / 29.05)
    expect(fit.asked).toBe(40);
    expect(fit.reason).toMatch(/buying power/);
  });

  /* The second pick must be sized against what the first one actually spent,
   * or two orders each fit the full account and together overspend it. */
  test('what has already been sent today is subtracted', async () => {
    armed();
    broker.save({ buyingPower: 2000 });
    await place({ quantity: 40, price: 29.05 });   // spends 40 × 29.05 = 1162
    expect(broker.committed(DAY)).toBeCloseTo(1162, 0);

    const fit = broker.fitQuantity({ quantity: 40, price: 29.05, date: DAY });
    expect(fit.quantity).toBe(28);                 // floor(838 / 29.05)
  });

  test('an order that was NOT sent commits nothing', async () => {
    armed({ allowShort: false });
    broker.save({ buyingPower: 2000 });
    await place({ signal: 'SHORT' });
    expect(broker.committed(DAY)).toBe(0);
  });

  test('nothing left means nothing sent, and it says so', async () => {
    armed();
    broker.save({ buyingPower: 10 });
    const out = await place();
    expect(out.sent).toBe(false);
    expect(out.skipped).toMatch(/buying power/);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test("yesterday's orders do not shrink today's", async () => {
    armed();
    broker.save({ buyingPower: 2000 });
    await place({ date: '2026-08-07' });
    expect(broker.committed(DAY)).toBe(0);
  });
});

// ── what the broker says back ─────────────────────────────────────────────

describe('the reply', () => {
  test('the fill price and order id are recorded, not just "sent"', async () => {
    armed();
    global.fetch = jest.fn(async () => filled(29.11));
    const out = await place();
    expect(out).toMatchObject({ sent: true, status: 'filled', orderId: 'ID12345', fillPrice: 29.11 });
    // The gap between the ranked price and the fill is now visible rather than
    // assumed.
    expect(out.price).toBe(29.05);
  });

  test('accepted is not reported as filled', async () => {
    armed();
    global.fetch = jest.fn(async () => ({
      ok: true, status: 201,
      text: async () => JSON.stringify({ id: 'ID1', status: 'accepted' }),
    }));
    expect((await place()).status).toBe('accepted');
  });

  test("a refusal carries the broker's own message", async () => {
    armed();
    global.fetch = jest.fn(async () => rejected('TradeThePool: Symbol not found'));
    const out = await place();
    expect(out.sent).toBe(false);
    expect(out.message).toMatch(/Symbol not found/);
    expect(out.error).toMatch(/ValidationError/);
  });
});

// ── reducing when the BROKER refuses ──────────────────────────────────────

describe('the broker refusing for buying power', () => {
  test('the quantity is halved and tried again', async () => {
    armed();
    let n = 0;
    global.fetch = jest.fn(async (url, opts) => {
      sent.push({ url, body: JSON.parse(opts.body) });
      n += 1;
      return n === 1
        ? rejected('This order may result in an oversold/overbought position in your account')
        : filled(29.1);
    });
    const out = await place();
    expect(sent.map(s => s.body.quantity)).toEqual([40, 20]);
    expect(out.sent).toBe(true);
    expect(out.quantity).toBe(20);
    expect(out.reduced).toMatch(/refused 40/);
  });

  test('it gives up rather than looping', async () => {
    armed();
    global.fetch = jest.fn(async (url, opts) => {
      sent.push({ url, body: JSON.parse(opts.body) });
      return rejected('insufficient buying power');
    });
    const out = await place();
    expect(sent).toHaveLength(3);
    expect(out.sent).toBe(false);
  });

  /* Any OTHER refusal is not a sizing problem, and retrying it smaller would
   * turn one wrong order into three. */
  test('a different refusal is not retried', async () => {
    armed();
    global.fetch = jest.fn(async (url, opts) => {
      sent.push({ url, body: JSON.parse(opts.body) });
      return rejected('TradeThePool: Symbol not found');
    });
    await place();
    expect(sent).toHaveLength(1);
  });

  /*
   * The one that must never be retried. A timeout may mean the order arrived;
   * a second attempt would be a second position, which is worse than no
   * position and worse than a reported failure.
   */
  test('a network failure is never retried, and says the broker must be checked', async () => {
    armed();
    global.fetch = jest.fn(async () => { throw new Error('ETIMEDOUT'); });
    const out = await place();
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(out.sent).toBe(false);
    expect(out.error).toMatch(/check the broker/i);
  });

  test('the retry can be switched off', async () => {
    armed({ retryOnBuyingPower: false });
    global.fetch = jest.fn(async (url, opts) => {
      sent.push({ url, body: JSON.parse(opts.body) });
      return rejected('oversold/overbought');
    });
    await place();
    expect(sent).toHaveLength(1);
  });
});

// ── the ledger ────────────────────────────────────────────────────────────

test('every attempt is recorded, including the ones that sent nothing', async () => {
  armed({ allowShort: false });
  await place();                       // sent
  await place({ signal: 'SHORT' });    // refused by the short switch
  const day = broker.orders(DAY);
  expect(day).toHaveLength(2);
  expect(day.filter(o => o.sent)).toHaveLength(1);
  // An order that was not placed and one that was are both facts about the
  // morning; the one thing that must not happen is being unable to tell.
  expect(day.find(o => !o.sent).skipped).toMatch(/short/i);
});

test('a one-share test goes to the test hook when there is one', async () => {
  broker.save({ webhookUrl: HOOK, testWebhookUrl: TEST_HOOK, enabled: true });
  const out = await broker.test({ symbol: 'AAPL' });
  expect(sent[0].url).toBe(TEST_HOOK);
  expect(sent[0].body).toEqual({ symbol: 'AAPL', action: 'buy', quantity: 1, quantity_type: 'fixed' });
  expect(out.hook).toBe('test');
});

test('a test needs no arming — that is the point of it', async () => {
  broker.save({ webhookUrl: HOOK, enabled: true });
  expect((await broker.test({})).sent).toBe(true);
});

// ── what became of the order ──────────────────────────────────────────────
//
// SignalStack's reply to our POST says what was true in that instant — usually
// 'accepted'. Filled at another price, partly filled, rejected by the broker a
// second later: that arrives on the notification callback or nowhere. Without
// it the ledger records intentions and calls them outcomes.

describe('the order-processed callback', () => {
  test('the token is stable, and long enough not to be guessed', () => {
    const t = broker.callbackToken();
    expect(t.length).toBeGreaterThanOrEqual(32);
    expect(broker.callbackToken()).toBe(t);
    expect(broker.tokenMatches(t)).toBe(true);
  });

  test('a wrong token never matches, whatever its length', () => {
    expect(broker.tokenMatches('')).toBe(false);
    expect(broker.tokenMatches('nope')).toBe(false);
    expect(broker.tokenMatches(`${broker.callbackToken()}x`)).toBe(false);
    expect(broker.tokenMatches(broker.callbackToken().slice(0, -1))).toBe(false);
  });

  test('the URL carries the token and the documented path', () => {
    const url = broker.callbackUrl('https://desk.example/');
    expect(url).toBe(`https://desk.example/api/broker/callback/${broker.callbackToken()}`);
  });

  test('a callback updates what is known about its order', async () => {
    armed();
    const placed = await place();
    expect(placed.orderId).toBe('ID12345');

    broker.receiveCallback({ id: 'ID12345', status: 'filled', price: 29.14 });
    const [row] = broker.reconciled(DAY);
    expect(row).toMatchObject({ confirmed: true, finalStatus: 'filled', finalPrice: 29.14 });
  });

  /* The immediate reply is not a confirmation, and the two must not read the
   * same: "accepted, never heard from again" is information. */
  test('an order nobody confirmed is marked unconfirmed', async () => {
    armed();
    global.fetch = jest.fn(async () => ({
      ok: true, status: 201, text: async () => JSON.stringify({ id: 'ID9', status: 'accepted' }),
    }));
    await place();
    expect(broker.reconciled(DAY)[0]).toMatchObject({ confirmed: false, finalStatus: null });
  });

  /* The case this exists for: the alert said the order went in, and it did not. */
  test('a rejection arriving later is recognised as bad news', () => {
    const e = broker.receiveCallback({ id: 'ID1', status: 'rejected',
      message: 'TradeThePool: insufficient buying power' });
    expect(broker.callbackIsBadNews(e)).toBe(true);
    expect(broker.callbackIsBadNews(
      broker.receiveCallback({ id: 'ID2', status: 'filled', price: 10 }))).toBe(false);
  });

  /*
   * The shape of this body is not documented in what we have, so an
   * unrecognised one must be stored rather than dropped — an unread callback
   * cannot be allowed to look like an order that simply went quiet.
   */
  test('an unrecognised body is still recorded whole', () => {
    const e = broker.receiveCallback({ something: 'unexpected', nested: { a: 1 } });
    expect(e.raw).toEqual({ something: 'unexpected', nested: { a: 1 } });
    expect(e.matched).toBe(false);
    expect(broker.orders().some(o => o.kind === 'callback')).toBe(true);
  });

  test('the field names are read by their several plausible spellings', () => {
    const e = broker.receiveCallback({ order_id: 'ID7', state: 'filled', fill_price: '31.5' });
    expect(e).toMatchObject({ orderId: 'ID7', status: 'filled', fillPrice: 31.5 });
  });

  /* Orders can be placed elsewhere on the same account. That is a real event
   * worth seeing, not an error worth hiding. */
  test('a callback for an order this side never placed is kept, not discarded', () => {
    const e = broker.receiveCallback({ id: 'PLACED-BY-HAND', status: 'filled', symbol: 'TSLA' });
    expect(e.matched).toBe(false);
    expect(e.symbol).toBe('TSLA');
  });

  /* The ledger is append-only on purpose: what was believed at 10:00:03 stays
   * readable next to what turned out to be true at 10:00:09. */
  test('a callback appends rather than rewriting the order', async () => {
    armed();
    await place();
    broker.receiveCallback({ id: 'ID12345', status: 'filled', price: 29.14 });
    const all = broker.orders();
    expect(all).toHaveLength(2);
    expect(all[0].kind).toBeUndefined();
    expect(all[0].fillPrice).toBe(100);       // what the reply said at the time
    expect(all[1].kind).toBe('callback');
  });

  test('a callback does not count against the buying power tally', async () => {
    armed();
    broker.save({ buyingPower: 2000 });
    await place({ quantity: 10, price: 29.05 });
    const before = broker.committed(DAY);
    broker.receiveCallback({ id: 'ID12345', status: 'filled', price: 29.14 });
    expect(broker.committed(DAY)).toBe(before);
  });
});

// ── how many trades a day ─────────────────────────────────────────────────
//
// A cap on the DAY, which a per-order size limit cannot be. A strategy
// misfiring, a second one assigned by mistake, or simply a morning with more
// signals than usual all produce correctly-sized orders that together are not a
// day anybody chose.

describe('the day’s trade caps', () => {
  test('the account cap stops the next order and says which limit it was', async () => {
    armed();
    broker.save({ maxTradesPerDay: 2 });
    expect((await place({ symbol: 'A' })).sent).toBe(true);
    expect((await place({ symbol: 'B' })).sent).toBe(true);

    const third = await place({ symbol: 'C' });
    expect(third.sent).toBe(false);
    expect(third.skipped).toMatch(/account/);
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  test('a setup cap stops that setup while others keep going', async () => {
    armed();
    expect((await place({ symbol: 'A', setupId: 'SCALP', maxPerDay: 1 })).sent).toBe(true);

    const second = await place({ symbol: 'B', setupId: 'SCALP', maxPerDay: 1 });
    expect(second.sent).toBe(false);
    expect(second.skipped).toMatch(/this setup/);

    // A different setup is untouched — that is the point of it being per setup.
    expect((await place({ symbol: 'C', setupId: 'VWAP', maxPerDay: 1 })).sent).toBe(true);
  });

  /* Only orders that went out count. Spending the allowance on a refusal would
   * silence a setup for a trade that never happened. */
  test('an order that was refused does not use up the day', async () => {
    armed();
    broker.save({ maxTradesPerDay: 1 });
    global.fetch = jest.fn(async () => rejected('TradeThePool: Symbol not found'));
    expect((await place({ symbol: 'A' })).sent).toBe(false);
    expect(broker.tradesToday(DAY)).toBe(0);

    global.fetch = jest.fn(async (url, opts) => {
      sent.push({ url, body: JSON.parse(opts.body) }); return filled();
    });
    expect((await place({ symbol: 'B' })).sent).toBe(true);
  });

  /* Counted from the ledger, so a deploy between the two picks cannot hand the
   * allowance back — which is exactly when it would be handed back. */
  test('the count survives a restart', async () => {
    armed();
    broker.save({ maxTradesPerDay: 1 });
    await place({ symbol: 'A' });

    jest.resetModules();
    const again = require('../src/broker/signalstack');
    expect(again.tradesToday(DAY)).toBe(1);
    expect((await again.placeOrder({
      symbol: 'B', signal: 'LONG', quantity: 10, price: 10, date: DAY,
    })).sent).toBe(false);
  });

  test("yesterday's trades do not count against today", async () => {
    armed();
    broker.save({ maxTradesPerDay: 1 });
    await place({ symbol: 'A', date: '2026-08-07' });
    expect(broker.tradesToday(DAY)).toBe(0);
    expect((await place({ symbol: 'B' })).sent).toBe(true);
  });

  test('no cap set means no cap', async () => {
    armed();
    for (const symbol of ['A', 'B', 'C', 'D', 'E']) {
      expect((await place({ symbol })).sent).toBe(true);
    }
  });
});
