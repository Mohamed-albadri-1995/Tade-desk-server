/*
 * THE SECOND PICK OF A BAR SPENT THE FIRST PICK'S MONEY.
 *
 * The runner sends one pick at a time, on purpose, and says why:
 *
 *     "One account at a time, and one pick at a time: each order is sized
 *      against what the previous one actually committed in THAT account, and
 *      firing them together would size every one against the full balance."
 *
 * That held for the TYPED ceiling, which subtracts `committed()` and re-reads
 * the ledger every time. It did not hold for the broker's own figure, which is
 * cached for twenty seconds and was used exactly as it came back.
 *
 * One decision bar sends several picks to the same account well inside twenty
 * seconds. So the second pick was handed a balance read BEFORE the first order
 * existed, and the two were sized against the same money. 2026-09-17:
 *
 *     LONG  BETA 1470 sh @ 21.24   = $31,222
 *     SHORT CIFR 2089 sh @ 17.88   = $37,361
 *
 * one bar, one account, both measured against the same $197,691. They fitted.
 * With the setup's `top 3` filled, or on a smaller account, they would not
 * have — and the failure is the one that has cost four sessions before:
 * "insufficient buying power", at the one second of the morning where a
 * rejection cannot be retried into the bar it was decided on.
 *
 * THE SUBTRACTION IS ONLY OF WHAT THE BROKER CANNOT YET KNOW. Alpaca reserves
 * buying power the moment it accepts an order, so a balance read at 09:35
 * already contains 09:30's position. Taking the whole day's tally off it as
 * well would charge every fill twice and shrink the next position for no
 * reason. Only orders sent AFTER the reading are invisible to it.
 *
 * On a fresh reading that subtraction is zero by construction — nothing can
 * have been sent after a moment that is now.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

let DIR;
let broker;

beforeEach(() => {
  DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'stale-power-'));
  process.env.DATA_DIR = DIR;
  process.env.BROKER_LEDGER = path.join(DIR, 'broker-orders.jsonl');
  fs.writeFileSync(process.env.BROKER_LEDGER, '');
  jest.resetModules();
  broker = require(path.join(__dirname, '..', 'src', 'broker', 'signalstack'));
});

afterEach(() => {
  delete process.env.DATA_DIR;
  delete process.env.BROKER_LEDGER;
  fs.rmSync(DIR, { recursive: true, force: true });
});

const DATE = '2026-09-17';
const DEST = 'alpaca1';

/**
 * Write a ledger row exactly as placeOrder does.
 *
 * The path is NOT guessed — BROKER_LEDGER is set in beforeEach, so the module
 * and this fixture cannot disagree about where the file is. A fixture written
 * somewhere the code does not read makes every assertion below pass against an
 * empty ledger, which is the failure this whole file is about.
 */
function sent({ at, symbol, quantity, price, destination = DEST, ok = true }) {
  const row = { at, date: DATE, symbol, quantity, price,
                destination, sent: ok };
  fs.appendFileSync(process.env.BROKER_LEDGER, `${JSON.stringify(row)}\n`);
}

describe('the ledger fixture reaches the code under test', () => {
  /*
   * THE FIRST THING TO PROVE. Every assertion in this file is about a number
   * read back from the ledger; if the fixture writes somewhere the code does
   * not read, they all pass against nothing.
   */
  test('a written order is seen by committed()', () => {
    sent({ at: 1000, symbol: 'BETA', quantity: 100, price: 10 });
    expect(broker.committedSince(0, DEST, DATE)).toBe(1000);
  });
});

describe('what the broker already knows is not subtracted twice', () => {
  test('an order sent BEFORE the reading is already in the balance', () => {
    sent({ at: 1000, symbol: 'EARLY', quantity: 100, price: 10 });
    // Reading taken at 2000 — the 09:30 position is in it.
    expect(broker.committedSince(2000, DEST, DATE)).toBe(0);
  });

  test('an order sent AFTER the reading is not', () => {
    sent({ at: 3000, symbol: 'LATER', quantity: 100, price: 10 });
    expect(broker.committedSince(2000, DEST, DATE)).toBe(1000);
  });

  test('only the ones after it are counted, out of several', () => {
    sent({ at: 1000, symbol: 'A', quantity: 100, price: 10 });   // before
    sent({ at: 3000, symbol: 'B', quantity: 200, price: 10 });   // after
    sent({ at: 4000, symbol: 'C', quantity: 300, price: 10 });   // after
    expect(broker.committedSince(2000, DEST, DATE)).toBe(5000);
  });

  /*
   * A FRESH READING SUBTRACTS NOTHING, by construction. This is what keeps the
   * ordinary case identical to the behaviour that was already right.
   */
  test('a reading taken now has nothing sent after it', () => {
    sent({ at: 1000, symbol: 'A', quantity: 100, price: 10 });
    expect(broker.committedSince(Date.now(), DEST, DATE)).toBe(0);
  });
});

describe('it is this account, and only this account', () => {
  /*
   * A POSITION IN alpaca2 DOES NOT SPEND alpaca1'S MONEY. The same bar sends
   * to both, and charging one account for the other's order would shrink every
   * position on a two-account desk.
   */
  test("another destination's order is not counted", () => {
    sent({ at: 3000, symbol: 'OTHER', quantity: 1000, price: 10,
           destination: 'alpaca2' });
    expect(broker.committedSince(2000, DEST, DATE)).toBe(0);
  });

  test('and its own still is', () => {
    sent({ at: 3000, symbol: 'OTHER', quantity: 1000, price: 10,
           destination: 'alpaca2' });
    sent({ at: 3001, symbol: 'MINE', quantity: 100, price: 10 });
    expect(broker.committedSince(2000, DEST, DATE)).toBe(1000);
  });
});

describe('a refusal took no money', () => {
  /*
   * ONLY SENT ORDERS. A rejection placed no trade and reserved nothing, and
   * counting it would shrink the next position over a position that does not
   * exist — which on 2026-09-17 would have meant the SECOND pick being cut
   * because the FIRST one failed.
   */
  test('an order that was refused is not counted', () => {
    sent({ at: 3000, symbol: 'REFUSED', quantity: 1000, price: 10, ok: false });
    expect(broker.committedSince(2000, DEST, DATE)).toBe(0);
  });
});

describe('nonsense is not a commitment', () => {
  /*
   * AN ERROR IS NEVER A ZERO — and here it must not be a large number either.
   * A row with no timestamp, or a call with no reading time, must not silently
   * subtract the whole day and refuse the next order.
   */
  /*
   * AND Number(null) IS 0, WHICH IS FINITE. A reading time of 0 counts every
   * order ever sent — so a missing timestamp would subtract the whole day from
   * the live balance, double-charging what the broker had already reserved and
   * shrinking every position after the first. Checking Number.isFinite alone
   * does not catch null, '' or false.
   */
  test('no reading time means no subtraction', () => {
    sent({ at: 3000, symbol: 'A', quantity: 1000, price: 10 });
    expect(broker.committedSince(null, DEST, DATE)).toBe(0);
    expect(broker.committedSince(undefined, DEST, DATE)).toBe(0);
    expect(broker.committedSince('', DEST, DATE)).toBe(0);
    expect(broker.committedSince(false, DEST, DATE)).toBe(0);
    expect(broker.committedSince('not a time', DEST, DATE)).toBe(0);
  });

  test('and remaining() does not shrink a balance it cannot date', () => {
    sent({ at: 3000, symbol: 'A', quantity: 1000, price: 10 });
    expect(broker.remaining(DATE, { destinationId: DEST, dialect: 'alpaca',
      buyingPower: null, liveBuyingPower: 50000 })).toBe(50000);
  });

  test('a row with no timestamp is not counted', () => {
    sent({ at: null, symbol: 'A', quantity: 1000, price: 10 });
    expect(broker.committedSince(2000, DEST, DATE)).toBe(0);
  });

  test('an empty ledger is zero, not an error', () => {
    expect(broker.committedSince(2000, DEST, DATE)).toBe(0);
  });
});

/* ── and the whole point: remaining() sees the earlier order ─────────────── */

describe('the money left, with the first pick already sent', () => {
  const CFG = { destinationId: DEST, dialect: 'alpaca', buyingPower: null };

  /*
   * THE ONE THAT WAS BROKEN. Both picks of the 09:34 bar read the same cached
   * $197,691, because the second one's reading was taken before the first
   * order existed.
   */
  test('a cached balance is reduced by what was sent since', () => {
    sent({ at: 3000, symbol: 'BETA', quantity: 1470, price: 21.24 }); // $31,222
    const left = broker.remaining(DATE, {
      ...CFG, liveBuyingPower: 197691, liveBuyingPowerAt: 2000,
    });
    expect(Math.round(left)).toBe(Math.round(197691 - 1470 * 21.24));
  });

  test('a fresh balance is used whole', () => {
    sent({ at: 1000, symbol: 'EARLY', quantity: 1470, price: 21.24 });
    const left = broker.remaining(DATE, {
      ...CFG, liveBuyingPower: 197691, liveBuyingPowerAt: Date.now(),
    });
    expect(Math.round(left)).toBe(197691);
  });

  /*
   * IT CANNOT GO NEGATIVE. A balance that has been over-committed is zero left,
   * not a negative allowance — fitQuantity floors `left / price`, and a
   * negative would produce a negative share count.
   */
  test('over-committing leaves zero, never less', () => {
    sent({ at: 3000, symbol: 'BIG', quantity: 100000, price: 100 });
    const left = broker.remaining(DATE, {
      ...CFG, liveBuyingPower: 50000, liveBuyingPowerAt: 2000,
    });
    expect(left).toBe(0);
  });

  /*
   * THE TYPED CEILING NEVER HAD THIS PROBLEM and must keep working: it
   * subtracts the whole day's tally, because it is a limit this side invented
   * and only this side counts against it.
   */
  test('the typed ceiling still subtracts the whole day', () => {
    sent({ at: 1000, symbol: 'EARLY', quantity: 100, price: 10 });   // $1,000
    const left = broker.remaining(DATE, {
      ...CFG, buyingPower: 5000, liveBuyingPower: 999999,
      liveBuyingPowerAt: Date.now(),
    });
    expect(left).toBe(4000);
  });

  test('and the smaller of the two still wins', () => {
    sent({ at: 3000, symbol: 'A', quantity: 100, price: 10 });       // $1,000
    // ceiling 5000 - 1000 = 4000; live 3000 - 1000 = 2000
    const left = broker.remaining(DATE, {
      ...CFG, buyingPower: 5000, liveBuyingPower: 3000, liveBuyingPowerAt: 2000,
    });
    expect(left).toBe(2000);
  });

  test('no live reading at all falls back to the typed ceiling', () => {
    sent({ at: 3000, symbol: 'A', quantity: 100, price: 10 });
    expect(broker.remaining(DATE, { ...CFG, buyingPower: 5000 })).toBe(4000);
  });

  test('neither one means no limit from here', () => {
    expect(broker.remaining(DATE, CFG)).toBeNull();
  });
});

describe('the reading carries the moment it was true', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'broker', 'signalstack.js'), 'utf8');

  /*
   * WITHOUT readAt THE SUBTRACTION CANNOT HAPPEN. A balance with no timestamp
   * is indistinguishable from a fresh one, which is exactly the state this
   * fixes — so the wiring is asserted, not assumed.
   */
  test('liveBuyingPower returns when the reading was taken', () => {
    expect(src).toMatch(/return \{ \.\.\.answer, readAt: now \}/);
    expect(src).toMatch(/readAt: hit\.at/);
  });

  test('and the send path puts it on the cfg that sizes the order', () => {
    expect(src).toMatch(/liveBuyingPowerAt: power\.readAt/);
  });

  test('remaining reads it', () => {
    expect(src).toMatch(/committedSince\(cfg\.liveBuyingPowerAt/);
  });
});
