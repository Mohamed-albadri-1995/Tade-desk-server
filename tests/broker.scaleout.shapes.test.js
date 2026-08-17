/*
 * Every exit shape becomes the right set of orders — without knowing the shape.
 *
 * SignalStack places ONE bracket per order and has no scale-out of its own, so
 * a strategy that exits in three places has to become three orders: each with
 * its own share count and its own target, all sharing the stop, and the runner
 * sent with a stop and NO target so it rides to the close.
 *
 * The rule that decided whether to split was `plan.legs.length > 1` — a guess
 * about the shape rather than a reading of it — and it was wrong for the
 * commonest shape there is. `OR + VWAP 09:35` takes half off at 2R and lets
 * half ride: one leg, one runner. The condition was false, so the WHOLE
 * position went out as a single bracket with the 2R target on it and the runner
 * was silently removed. A strategy tested as "half at 2R, half to the close"
 * was placed as "all at 2R" — a different strategy, a different expectancy, and
 * nothing anywhere said so.
 *
 * These use the exit plans of the three REAL strategies, plus the shapes nobody
 * has built yet, because the point of the fix is that no shape is special.
 */

const os = require('os');
const path = require('path');
const fs = require('fs');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'legs-'));
process.env.BROKER_FILE = path.join(DIR, 'broker.json');
process.env.BROKER_LEDGER = path.join(DIR, 'orders.jsonl');

const broker = require('../src/broker/signalstack');

// A made-up hook id. The real one is a credential — anyone holding it can trade
// the account — so it lives only in data/broker.json, which is gitignored.
const HOOK = 'https://app.signalstack.com/hook/FAKEhook0000000000000a';
const DAY = '2026-08-17';

let cfg;
beforeEach(() => {
  fs.rmSync(process.env.BROKER_FILE, { force: true });
  fs.rmSync(process.env.BROKER_LEDGER, { force: true });
  broker.save({
    destinations: [{ id: 'ttp', name: 'TTP', dialect: 'ttp', webhookUrl: HOOK,
                     buyingPower: 1000000, ratio: 1, mode: 'auto', setups: [] }],
    enabled: true,
  });
  broker.save({ armed: true, allowShort: true });
  cfg = broker.destinationCfg('ttp');
});
afterAll(() => { fs.rmSync(DIR, { recursive: true, force: true }); });

/** What would go on the wire for one signal, as a list of bodies. */
function wire(plan, { quantity = 137, signal = 'LONG', price = 50,
                      stop = 49, target = 52 } = {}) {
  const p = broker.planOrder({ symbol: 'DINO', signal, quantity, price, stop,
                               target, date: DAY, plan, cfg });
  if (p.blocked) return { blocked: p.blocked, reason: p.reason };
  return { bodies: p.orders && p.orders.length ? p.orders : [p.body] };
}

const qty = b => b.reduce((n, x) => n + x.quantity, 0);

// ── the three that exist ───────────────────────────────────────────────────

describe('Test — 10% at 3R, 80% at 6R, 10% runner', () => {
  const PLAN = {
    legs: [{ fraction: 0.1, r_multiple: 3, price: 53 },
           { fraction: 0.8, r_multiple: 6, price: 56 }],
    runner: 0.1, stop_kind: 'trailing', trail: null,
  };

  test('three orders, three share counts, two targets and a runner', () => {
    const { bodies } = wire(PLAN);
    expect(bodies).toHaveLength(3);
    expect(bodies.map(b => b.quantity)).toEqual([13, 109, 15]);
    expect(bodies.map(b => b.take_profit_price)).toEqual([53, 56, undefined]);
  });

  test('every order carries the same stop, the runner included', () => {
    const { bodies } = wire(PLAN);
    for (const b of bodies) expect(b.stop_loss_price).toBe(49);
  });

  test('the runner has NO target — it is what rides to the close', () => {
    const { bodies } = wire(PLAN);
    expect('take_profit_price' in bodies[2]).toBe(false);
  });
});

/*
 * The shape the old rule got wrong. One leg and a runner is not "a single
 * bracket": it is two orders, and half the position must have no target.
 */
describe('OR + VWAP 09:35 — 50% at 2R, 50% runner', () => {
  const PLAN = { legs: [{ fraction: 0.5, r_multiple: 2, price: 52 }],
                 runner: 0.5, stop_kind: 'fixed', trail: null };

  test('TWO orders, not one — the runner is a separate order', () => {
    const { bodies } = wire(PLAN);
    expect(bodies).toHaveLength(2);
    expect(bodies.map(b => b.quantity)).toEqual([68, 69]);
  });

  test('only the first half carries the 2R target', () => {
    const { bodies } = wire(PLAN);
    expect(bodies[0].take_profit_price).toBe(52);
    expect('take_profit_price' in bodies[1]).toBe(false);
  });

  test('the whole position is NOT sent at the target', () => {
    const { bodies } = wire(PLAN);
    const atTarget = bodies.filter(b => b.take_profit_price != null);
    expect(qty(atTarget)).toBe(68);          // half, not 137
  });
});

describe('T2 10:00 — 100% at 2R, no runner', () => {
  test('stays ONE order, because that is what it is', () => {
    const { bodies } = wire({ legs: [{ fraction: 1, r_multiple: 2, price: 52 }],
                              runner: 0, stop_kind: 'fixed', trail: null });
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatchObject({ quantity: 137, stop_loss_price: 49,
                                      take_profit_price: 52 });
  });
});

// ── the shapes nobody has built yet ────────────────────────────────────────

describe('shapes that do not exist yet still work', () => {
  test('a pure runner — a stop and no target at all', () => {
    const { bodies } = wire({ legs: [], runner: 1, stop_kind: 'fixed' });
    expect(bodies).toHaveLength(1);
    expect(bodies[0].quantity).toBe(137);
    expect('take_profit_price' in bodies[0]).toBe(false);
  });

  test('four legs and no runner', () => {
    const { bodies } = wire({
      legs: [{ fraction: 0.25, price: 51 }, { fraction: 0.25, price: 52 },
             { fraction: 0.25, price: 53 }, { fraction: 0.25, price: 54 }],
      runner: 0,
    });
    expect(bodies).toHaveLength(4);
    expect(qty(bodies)).toBe(137);
    expect(bodies.map(b => b.take_profit_price)).toEqual([51, 52, 53, 54]);
  });

  /*
   * Each leg may keep its own stop — the protocol allows "2 SL / 2 TP", where
   * the second half's stop has already been moved to break-even. The stop
   * travels with the leg rather than being assumed shared.
   */
  test('a per-leg stop travels with its own leg', () => {
    const { bodies } = wire({
      // The second half's stop moved up, but NOT to the entry: a stop at the
      // entry price is refused by validateBody, and rightly — as an order it
      // is one tick from an instant exit.
      legs: [{ fraction: 0.5, price: 52, stop: 49 },
             { fraction: 0.5, price: 54, stop: 49.8 }],
      runner: 0,
    });
    expect(bodies.map(b => b.stop_loss_price)).toEqual([49, 49.8]);
  });

  test('a short splits the same way, on the other side', () => {
    const { bodies } = wire(
      { legs: [{ fraction: 0.5, r_multiple: 2, price: 48 }], runner: 0.5 },
      { signal: 'SHORT', price: 50, stop: 51, target: 48 });
    expect(bodies).toHaveLength(2);
    expect(bodies.every(b => b.action === 'sell')).toBe(true);
    expect(bodies[0].take_profit_price).toBe(48);
    expect('take_profit_price' in bodies[1]).toBe(false);
  });
});

// ── the invariant, on every shape ──────────────────────────────────────────

/*
 * EVERY SHARE THAT WAS SIZED IS ORDERED, AND NO MORE.
 *
 * The fractions add to one on the qp side and the shares must add to the sized
 * quantity here. Off by one in either direction is a position that is not the
 * one the risk settings chose, and it looks exactly like one that is — so this
 * is checked across awkward share counts, not just round ones.
 */
describe('the share count is never lost or invented', () => {
  const SHAPES = {
    'three legs + runner': { legs: [{ fraction: 0.1, price: 53 },
                                    { fraction: 0.8, price: 56 }], runner: 0.1 },
    'one leg + runner': { legs: [{ fraction: 0.5, price: 52 }], runner: 0.5 },
    'thirds': { legs: [{ fraction: 1 / 3, price: 51 }, { fraction: 1 / 3, price: 52 },
                       { fraction: 1 / 3, price: 53 }], runner: 0 },
    'whole position': { legs: [{ fraction: 1, price: 52 }], runner: 0 },
  };
  for (const [name, plan] of Object.entries(SHAPES)) {
    test(`${name} — every awkward size adds up`, () => {
      for (const n of [1, 2, 3, 7, 11, 99, 137, 1001]) {
        const out = wire(plan, { quantity: n });
        if (out.blocked) continue;           // too small to place is a real answer
        expect(qty(out.bodies)).toBe(n);
        for (const b of out.bodies) expect(Number.isInteger(b.quantity)).toBe(true);
        for (const b of out.bodies) expect(b.quantity).toBeGreaterThan(0);
      }
    });
  }

  /*
   * A leg too small to be a whole share must not be dropped silently: the
   * shares it would have had go somewhere, and the total still matches.
   */
  test('a leg under one share does not lose its shares', () => {
    const { bodies } = wire({ legs: [{ fraction: 0.02, price: 53 },
                                     { fraction: 0.98, price: 56 }], runner: 0 },
                            { quantity: 10 });
    expect(qty(bodies)).toBe(10);
  });
});
