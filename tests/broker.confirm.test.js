/*
 * Confirming an order from the BROKER'S record instead of the relay's.
 *
 * SignalStack's callback is a live-account feature — they said so when asked —
 * and this desk trades a paper account. So the callback never arrives, every
 * order read as "accepted, then silence", and `slip` — the whole measurement of
 * what the minute between the decision bar's close and the market order costs —
 * was null on every trade ever placed.
 *
 * Alpaca's own fill record answers it. What has to be pinned is the MATCHING,
 * because there is no shared id between the two systems and a wrong match is
 * silent: it produces a confident, precise, wrong number.
 *
 *   the entry must not be confirmed by the fill that CLOSED it — same symbol,
 *     hours later, a completely different price, and the slip becomes P&L;
 *   two orders on one symbol must not both claim the same fill;
 *   a fill that arrived before the order was sent belongs to something else;
 *   a partial fill is one order in three prints, not three orders;
 *   a real callback, if one ever comes, still wins.
 */

const os = require('os');
const path = require('path');
const fs = require('fs');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'confirm-'));
process.env.BROKER_FILE = path.join(DIR, 'broker.json');
process.env.BROKER_LEDGER = path.join(DIR, 'orders.jsonl');

const broker = require('../src/broker/signalstack');

// Made-up hook ids. A hook URL is a credential — anyone holding one can trade
// the account behind it — so the real ones live only in gitignored data.
const HOOK = 'https://app.signalstack.com/hook/FAKEhookCCCCCCCCCCCCc';
const DAY = '2026-08-19';
const T = (hhmm) => Date.parse(`${DAY}T${hhmm}:00-04:00`);

beforeEach(() => {
  for (const f of [process.env.BROKER_FILE, process.env.BROKER_LEDGER]) {
    fs.rmSync(f, { force: true });
  }
  broker.save({
    enabled: true,
    destinations: [
      { id: 'alp', name: 'Alpaca', dialect: 'alpaca', webhookUrl: HOOK,
        ratio: 1, buyingPower: 50000, mode: 'auto' },
      { id: 'ttp', name: 'Trade The Pool', dialect: 'ttp', webhookUrl: HOOK,
        ratio: 0.05, buyingPower: 5000, mode: 'auto' },
    ],
  });
});
afterAll(() => { fs.rmSync(DIR, { recursive: true, force: true }); });

/** A ledger row as placeOrder writes one. */
const row = (over = {}) => ({
  at: T('09:36'), date: DAY, symbol: 'WULF', action: 'sell', quantity: 541,
  price: 15.37, stop: 15.74, target: 14.63, setupId: 'S@09:35',
  destination: 'alp', sent: true, status: 'accepted', orderId: 'SS-1',
  confirmed: false, finalStatus: null, finalPrice: null, ...over,
});

/** An Alpaca FILL activity as the account statement returns one. */
const fill = (over = {}) => ({
  id: 'F1', orderId: 'AL-1', symbol: 'WULF', side: 'sell_short',
  qty: 541, price: 15.24, at: new Date(T('09:36')).toISOString(),
  type: 'fill', ...over,
});

// ── the match ─────────────────────────────────────────────────────────────

test('a fill answers the order it belongs to, and prices the slip', () => {
  const [out] = broker.confirmFromFills([row()], [fill()]);
  expect(out).toMatchObject({
    confirmed: true, confirmedBy: 'alpaca', finalStatus: 'filled',
    finalPrice: 15.24, filledQty: 541, prints: 1,
  });
  /*
   * SIGNED AGAINST THE POSITION. This is a SHORT priced at 15.37 and filled at
   * 15.24 — thirteen cents LOWER, which for a short is thirteen cents WORSE.
   * An unsigned difference would report this identically to a long that got
   * thirteen cents better, and those are opposite outcomes.
   */
  expect(out.slip).toBeCloseTo(0.13, 4);
  expect(out.slipPct).toBeGreaterThan(0);
});

/*
 * THE FAULT THIS EXISTS TO PREVENT. A long's entry fills `buy` and its stop or
 * target fills `sell`; the closing fill is the same symbol on the same day. If
 * side were not checked, the entry would be "confirmed" at the exit price and
 * `slip` would silently become the trade's P&L — a plausible-looking number
 * measuring the wrong thing entirely.
 */
test('an entry is never confirmed by the fill that closed it', () => {
  const entry = row({ action: 'buy', symbol: 'AAPL', price: 200, stop: 197, target: 206 });
  const exit = fill({ id: 'F9', orderId: 'AL-9', symbol: 'AAPL', side: 'sell',
                      qty: 541, price: 206.1, at: new Date(T('14:20')).toISOString() });
  const [out] = broker.confirmFromFills([entry], [exit]);
  expect(out.confirmed).toBe(false);
  expect(out.slip).toBeUndefined();
});

test('a fill from before the order was sent belongs to something else', () => {
  const early = fill({ at: new Date(T('09:31')).toISOString() });
  expect(broker.confirmFromFills([row()], [early])[0].confirmed).toBe(false);
});

/*
 * Clock skew between this box and Alpaca is not a mismatch. Five seconds is
 * allowed; the test asserts the boundary rather than the happy middle.
 */
test('a fill a few seconds "before" the send still matches', () => {
  const skewed = fill({ at: new Date(T('09:36') - 4000).toISOString() });
  expect(broker.confirmFromFills([row()], [skewed])[0].confirmed).toBe(true);
  const tooEarly = fill({ at: new Date(T('09:36') - 9000).toISOString() });
  expect(broker.confirmFromFills([row()], [tooEarly])[0].confirmed).toBe(false);
});

/*
 * A scale-out is several orders on one symbol at the same second. Each one has
 * its own fill and neither may take the other's, or one leg reads as unfilled
 * while the other reports double the shares.
 */
test('two orders on one symbol take one fill each, oldest first', () => {
  const rows = [
    row({ orderId: 'SS-1', quantity: 68, at: T('09:36') }),
    row({ orderId: 'SS-2', quantity: 473, at: T('09:36') + 400 }),
  ];
  const fills = [
    fill({ id: 'F1', orderId: 'AL-1', qty: 68, price: 15.24,
           at: new Date(T('09:36') + 900).toISOString() }),
    fill({ id: 'F2', orderId: 'AL-2', qty: 473, price: 15.22,
           at: new Date(T('09:36') + 1500).toISOString() }),
  ];
  const out = broker.confirmFromFills(rows, fills);
  expect(out.map(o => o.finalPrice)).toEqual([15.24, 15.22]);
  expect(out.map(o => o.filledQty)).toEqual([68, 473]);
});

/*
 * One order, three prints. Averaging only the first would report a price the
 * position never had; counting each print as an order would triple the day.
 */
test('a partial fill is one order at its weighted price', () => {
  const prints = [
    fill({ id: 'F1', orderId: 'AL-1', qty: 100, price: 15.20 }),
    fill({ id: 'F2', orderId: 'AL-1', qty: 400, price: 15.25,
           at: new Date(T('09:36') + 200).toISOString() }),
    fill({ id: 'F3', orderId: 'AL-1', qty: 41, price: 15.30,
           at: new Date(T('09:36') + 400).toISOString() }),
  ];
  const [out] = broker.confirmFromFills([row()], prints);
  expect(out.prints).toBe(3);
  expect(out.filledQty).toBe(541);
  // (100·15.20 + 400·15.25 + 41·15.30) / 541 = 8247.30 / 541
  expect(out.finalPrice).toBeCloseTo(15.2445, 4);
});

// ── the boundaries ────────────────────────────────────────────────────────

/*
 * TTP is behind TraderEvolution and Alpaca has never heard of it. A fill on the
 * same symbol in the Alpaca account must not be read as the answer to the order
 * that went to the OTHER broker — that would report a position confirmed in an
 * account nothing here can see.
 */
test('a non-Alpaca account is never confirmed from Alpaca fills', () => {
  const [out] = broker.confirmFromFills([row({ destination: 'ttp' })], [fill()]);
  expect(out.confirmed).toBe(false);
});

test('an order that was never sent is not confirmed by a coincidental fill', () => {
  const refused = row({ sent: false, status: null, skipped: 'not armed' });
  expect(broker.confirmFromFills([refused], [fill()])[0].confirmed).toBe(false);
});

/*
 * On a LIVE account the callback does arrive, and it is the more direct record
 * of the order this row is about. This must never overwrite it.
 */
test('a real callback still wins', () => {
  const already = row({ confirmed: true, confirmedBy: 'signalstack',
                        finalStatus: 'filled', finalPrice: 15.30 });
  const [out] = broker.confirmFromFills([already], [fill()]);
  expect(out).toMatchObject({ finalPrice: 15.30, confirmedBy: 'signalstack' });
});

test('rows come back in the order they went in, matched or not', () => {
  const rows = [row({ symbol: 'ZZZZ', at: T('09:40') }), row({ at: T('09:36') })];
  const out = broker.confirmFromFills(rows, [fill()]);
  expect(out.map(o => o.symbol)).toEqual(['ZZZZ', 'WULF']);
  expect(out[0].confirmed).toBe(false);
  expect(out[1].confirmed).toBe(true);
});

test('no fills at all changes nothing and throws nothing', () => {
  expect(broker.confirmFromFills([row()], [])[0].confirmed).toBe(false);
  expect(broker.confirmFromFills([row()], null)[0].confirmed).toBe(false);
  expect(broker.confirmFromFills([], [fill()])).toEqual([]);
});

/*
 * TWO ALPACA ACCOUNTS, ONE KEY PAIR.
 *
 * `alpaca/client.js` resolves credentials with `... LIMIT 1` — the default
 * broker profile. Every position and every fill therefore answers for exactly
 * one account, and nothing in the answer says which. A second Alpaca account
 * would not be uncovered, it would be MIS-attributed: B's order matched to A's
 * fill on the same symbol, same side, the same few seconds. The match succeeds
 * and the price is another account's money.
 *
 * That is not a missing number, it is a confident wrong one — and `slip`, the
 * whole measurement this feeds, would be built on it. So the answer becomes
 * unavailable instead.
 */
const reconcile = require('../src/broker/reconcile');

test('one Alpaca account is unambiguous', () => {
  expect(reconcile.credentialScope()).toMatchObject({ ambiguous: false, ids: ['alp'] });
});

test('a second Alpaca account makes attribution impossible, and says so', () => {
  broker.save({
    enabled: true,
    destinations: [
      { id: 'alp', name: 'Alpaca A', dialect: 'alpaca', webhookUrl: HOOK,
        ratio: 1, buyingPower: 50000, mode: 'auto' },
      { id: 'alp2', name: 'Alpaca B', dialect: 'alpaca', webhookUrl: HOOK,
        ratio: 1, buyingPower: 50000, mode: 'auto' },
    ],
  });
  const scope = reconcile.credentialScope();
  expect(scope.ambiguous).toBe(true);
  // Names both accounts, so the reader knows which pair is in question.
  expect(scope.reason).toMatch(/alp, alp2/);
  // The message names the FIX now, because there is one: give each account its
  // own key pair. Before per-account credentials existed the only honest thing
  // to say was that the desk holds one set; now that is the reason and not the
  // whole story.
  expect(scope.reason).toMatch(/ONE set of Alpaca credentials/);
  expect(scope.reason).toMatch(/own API key and secret/);
});

test("confirmation refuses rather than borrowing the other account's fill", async () => {
  // A real ledger line, so `confirmed()` reaches the guard instead of
  // short-circuiting on an empty day.
  fs.writeFileSync(process.env.BROKER_LEDGER, `${JSON.stringify(row())}\n`);
  broker.save({
    enabled: true,
    destinations: [
      { id: 'alp', name: 'Alpaca A', dialect: 'alpaca', webhookUrl: HOOK,
        ratio: 1, buyingPower: 50000, mode: 'auto' },
      { id: 'alp2', name: 'Alpaca B', dialect: 'alpaca', webhookUrl: HOOK,
        ratio: 1, buyingPower: 50000, mode: 'auto' },
    ],
  });

  const out = await reconcile.confirmed(DAY);
  expect(out.ok).toBe(false);
  expect(out.ambiguous).toBe(true);
  expect(out.error).toMatch(/ONE set of Alpaca credentials/);
  // The orders still come back — a day report that printed nothing because the
  // account was ambiguous would be a worse failure than one that prints the
  // orders and says the fill prices are unavailable.
  expect(out.rows).toHaveLength(1);
  expect(out.rows[0].confirmed).toBe(false);

  // And this is the danger being averted: the matcher itself would have said
  // yes. The guard is the only thing standing between a plausible number and
  // another account's money.
  expect(broker.confirmFromFills([row()], [fill()])[0].confirmed).toBe(true);
});
