/*
 * Reading the account: positions, orders, fills.
 *
 * THE BUG THIS WAS WRITTEN AFTER. The fills request asked for `page_size=500`
 * because that looked generous. Alpaca's maximum is 100, and asking for more
 * does not return 100 — it returns
 *
 *     422 {"code":40010001,"message":"tried to set the page size to 500,
 *          but the maximum is 100"}
 *
 * so the whole day came back as an error rather than as a first page. It was
 * caught the first time the endpoint was called against the real account, by
 * which point it had been written, tested and shipped: every test stubbed the
 * transport, so nothing had ever seen Alpaca's own rules.
 *
 * These are the rules, written down. They still stub the transport — there is
 * no account here — but they now stub what Alpaca ACTUALLY does, including
 * refusing the request that was being sent.
 */

const path = require('path');

let mockDbRows = {};
jest.mock('../src/db', () => ({
  prepare: sql => ({
    get: () => (/trading_brokers/.test(sql) ? mockDbRows.profile : undefined),
    all: () => (/settings/.test(sql) ? (mockDbRows.settings || []) : []),
  }),
}));

const account = require('../src/alpaca/account');

let calls;
beforeEach(() => {
  mockDbRows = { profile: { config: JSON.stringify({ key: 'PKTEST', secret: 'shhh' }) } };
  calls = [];
});

/** Serve a canned reply, recording every URL asked for. */
function serve(fn) {
  global.fetch = jest.fn(async (url) => {
    calls.push(String(url));
    const r = fn(String(url), calls.length);
    return { ok: r.ok !== false, status: r.status || 200,
             text: async () => JSON.stringify(r.body) };
  });
}

const q = (url, key) => new URL(url).searchParams.get(key);

// ── the page size ──────────────────────────────────────────────────────────

describe('the fills page size', () => {
  /*
   * ALPACA'S RULE, not a preference. Anything above 100 is a 422 and loses the
   * whole day.
   */
  test('never asks for more than 100', async () => {
    serve(() => ({ body: [] }));
    await account.fills();
    expect(Number(q(calls[0], 'page_size'))).toBeLessThanOrEqual(100);
  });

  test('the exact request that used to fail is no longer sent', async () => {
    serve(url => (Number(q(url, 'page_size')) > 100
      ? { ok: false, status: 422,
          body: { code: 40010001, message: 'tried to set the page size to 500, but the maximum is 100' } }
      : { body: [] }));
    const r = await account.fills();
    expect(r.ok).toBe(true);
  });

  /* And if it ever is again, the failure is reported rather than swallowed. */
  test('a 422 is an error, not an empty day', async () => {
    serve(() => ({ ok: false, status: 422, body: { message: 'nope' } }));
    const r = await account.fills();
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/422/);
  });
});

// ── paging ─────────────────────────────────────────────────────────────────

describe('more fills than fit in a page', () => {
  const row = i => ({ id: `f${i}`, order_id: 'o1', symbol: 'EYPT', side: 'buy',
                      qty: 1, price: 5, transaction_time: 't', type: 'fill' });

  /*
   * A day CAN exceed a page: a three-leg scale-out in two accounts is six
   * orders, each able to fill in several prints.
   */
  test('a full page is followed, a short page ends it', async () => {
    serve((url, n) => ({ body: n === 1
      ? Array.from({ length: 100 }, (_, i) => row(i))
      : [row(100), row(101)] }));
    const r = await account.fills();
    expect(r.fills).toHaveLength(102);
    expect(calls).toHaveLength(2);
  });

  test('the second page continues from the last row it saw', async () => {
    serve((url, n) => ({ body: n === 1
      ? Array.from({ length: 100 }, (_, i) => row(i))
      : [] }));
    await account.fills();
    expect(q(calls[0], 'page_token')).toBeNull();
    expect(q(calls[1], 'page_token')).toBe('f99');
  });

  test('one short page is one request', async () => {
    serve(() => ({ body: [row(0)] }));
    await account.fills();
    expect(calls).toHaveLength(1);
  });

  /*
   * BOUNDED. An endpoint that never returns a short page would otherwise spin
   * forever, on a timer, against a rate limit.
   */
  test('it stops even if every page comes back full', async () => {
    serve(() => ({ body: Array.from({ length: 100 }, (_, i) => row(i)) }));
    await account.fills();
    expect(calls.length).toBeGreaterThan(1);
    expect(calls.length).toBeLessThanOrEqual(20);
  });

  /*
   * A failure PART WAY THROUGH is reported, never returned as a partial day —
   * half a day's fills look exactly like a quiet day.
   */
  test('a failure on page two loses the request, not the truth', async () => {
    serve((url, n) => (n === 1
      ? { body: Array.from({ length: 100 }, (_, i) => row(i)) }
      : { ok: false, status: 500, body: { message: 'boom' } }));
    const r = await account.fills();
    expect(r.ok).toBe(false);
  });

  test('the window asked for is carried onto every page', async () => {
    serve((url, n) => ({ body: n === 1
      ? Array.from({ length: 100 }, (_, i) => row(i)) : [] }));
    await account.fills({ after: '2026-08-19T08:00:00.000Z' });
    expect(q(calls[0], 'after')).toBe('2026-08-19T08:00:00.000Z');
    expect(q(calls[1], 'after')).toBe('2026-08-19T08:00:00.000Z');
  });
});

// ── the other two reads ────────────────────────────────────────────────────

describe('positions', () => {
  test('a short comes back signed, and side-labelled', async () => {
    serve(() => ({ body: [{ symbol: 'capr', qty: '-100', avg_entry_price: '7.5',
                            market_value: '-750', unrealized_pl: '12',
                            current_price: '7.38' }] }));
    const r = await account.positions();
    expect(r.positions[0]).toMatchObject({ symbol: 'CAPR', qty: -100, side: 'short' });
  });

  test('an empty account is ok:true with nothing in it', async () => {
    serve(() => ({ body: [] }));
    const r = await account.positions();
    expect(r.ok).toBe(true);
    expect(r.positions).toEqual([]);
  });

  /*
   * "No positions" and "could not ask" are opposite facts, and everything
   * downstream depends on being able to tell them apart.
   */
  test('an unreachable broker is ok:false, never an empty list', async () => {
    serve(() => ({ ok: false, status: 503, body: { message: 'down' } }));
    const r = await account.positions();
    expect(r.ok).toBe(false);
    expect(r.positions).toBeUndefined();
  });

  test('missing credentials are a reason, not a crash', async () => {
    mockDbRows = { profile: undefined, settings: [] };
    serve(() => ({ body: [] }));
    const r = await account.positions();
    // Either it found shared credentials and asked, or it says why it could not.
    if (!r.ok) expect(r.error).toMatch(/credential/i);
  });
});

describe('orders', () => {
  test('bracket legs come back nested, not flattened into siblings', async () => {
    serve(() => ({ body: [{ id: 'p', symbol: 'EYPT', side: 'buy', qty: '175',
      filled_qty: '175', filled_avg_price: '5.42', status: 'filled',
      order_class: 'bracket',
      legs: [{ id: 'l1', symbol: 'EYPT', side: 'sell', qty: '175',
               filled_qty: '0', status: 'held', type: 'limit', limit_price: '6.10' }] }] }));
    const r = await account.orders();
    expect(q(calls[0], 'nested')).toBe('true');
    expect(r.orders[0].legs[0]).toMatchObject({ id: 'l1', limitPrice: 6.10 });
  });

  test('an unfilled order has no fill price rather than a zero', async () => {
    serve(() => ({ body: [{ id: 'p', symbol: 'X', side: 'buy', qty: '10',
      filled_qty: '0', filled_avg_price: null, status: 'new' }] }));
    expect((await account.orders()).orders[0].filledAvg).toBeNull();
  });
});

describe('the account itself', () => {
  test('a block is surfaced as a boolean, not left in the raw status', async () => {
    serve(() => ({ body: { equity: '1', cash: '1', buying_power: '0',
      daytrade_count: '0', trading_blocked: true, account_blocked: false,
      pattern_day_trader: false, status: 'ACTIVE' } }));
    const r = await account.account();
    expect(r.account.tradingBlocked).toBe(true);
  });
});
