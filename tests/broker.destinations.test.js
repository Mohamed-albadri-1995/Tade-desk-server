/*
 * Two brokers, one order path.
 *
 * There was one hook, so "the broker" and "the account" were the same thing and
 * neither needed a name. With a prop-firm account and an Alpaca account they
 * come apart in every direction that matters: different hooks, different
 * balances, different day counts, and a body that is not quite the same shape.
 *
 * The thing being protected here is that adding the second one did NOT add a
 * second code path. planOrder, previewOrder and placeOrder already took a cfg,
 * so a destination is a cfg — every guard, every cap and every validation runs
 * exactly as it did, against this account's hook and this account's balance.
 *
 * The tests that matter are the separations. Two accounts sharing a balance, a
 * day count, or a hook would each be a way to lose money quietly.
 */

const os = require('os');
const path = require('path');
const fs = require('fs');

const FILE = path.join(os.tmpdir(), `broker-dest-${process.pid}.json`);
const LEDGER = path.join(os.tmpdir(), `broker-dest-ledger-${process.pid}.jsonl`);
process.env.BROKER_FILE = FILE;
process.env.BROKER_LEDGER = LEDGER;

const broker = require('../src/broker/signalstack');

const HOOK_A = 'https://app.signalstack.com/hook/FAKEhookAAAAAAAAAAAAa';
const HOOK_B = 'https://app.signalstack.com/hook/FAKEhookBBBBBBBBBBBBb';
const DAY = '2026-08-13';

const TWO = [
  { id: 'ttp', name: 'Trade The Pool', dialect: 'ttp', webhookUrl: HOOK_A,
    buyingPower: 5000, maxTradesPerDay: 6 },
  { id: 'alpaca', name: 'Alpaca', dialect: 'alpaca', webhookUrl: HOOK_B,
    buyingPower: 20000, maxTradesPerDay: 2 },
];

const TTP_NO_POWER = { ...TWO[0], buyingPower: undefined };

beforeEach(() => {
  for (const f of [FILE, LEDGER]) { try { fs.unlinkSync(f); } catch { /* absent */ } }
});
afterAll(() => {
  for (const f of [FILE, LEDGER]) { try { fs.unlinkSync(f); } catch { /* absent */ } }
});

/** A sent order in the ledger, as placeOrder would have written it. */
function ledger(rows) {
  fs.writeFileSync(LEDGER, rows.map(r => JSON.stringify({
    at: Date.now(), date: DAY, sent: true, kind: 'order', ...r,
  })).join('\n') + '\n');
}

// ── the migration ─────────────────────────────────────────────────────────

describe('a config written before destinations existed', () => {
  test('its single hook reads as one destination', () => {
    broker.save({ webhookUrl: HOOK_A, buyingPower: 5000, maxTradesPerDay: 4 });
    const [d, ...rest] = broker.destinations();
    expect(rest).toEqual([]);
    expect(d.id).toBe('ttp');
    expect(d.webhookUrl).toBe(HOOK_A);
    expect(d.buyingPower).toBe(5000);
    expect(d.maxTradesPerDay).toBe(4);
  });

  test('nothing configured means no destinations, not a broken one', () => {
    expect(broker.destinations()).toEqual([]);
  });

  test('the file is not rewritten just by being read', () => {
    // Migrating on read rather than on load: a broker config that silently
    // changed shape mid-morning would be a bad thing to discover.
    broker.save({ webhookUrl: HOOK_A });
    broker.destinations();
    expect(JSON.parse(fs.readFileSync(FILE, 'utf8')).destinations).toBeUndefined();
  });
});

// ── the separations ───────────────────────────────────────────────────────

describe('two accounts do not share anything they should not', () => {
  beforeEach(() => broker.save({ enabled: true, destinations: TWO }));

  test('each has its own buying power', () => {
    // $4,000 spent at the prop firm must not touch Alpaca's balance.
    ledger([{ destination: 'ttp', quantity: 40, price: 100 }]);
    expect(broker.remaining(DAY, broker.destinationCfg('ttp'))).toBe(1000);
    expect(broker.remaining(DAY, broker.destinationCfg('alpaca'))).toBe(20000);
  });

  test('each has its own daily order count', () => {
    ledger([
      { destination: 'alpaca', quantity: 1, price: 10 },
      { destination: 'alpaca', quantity: 1, price: 10 },
    ]);
    expect(broker.tradesToday(DAY, null, 'alpaca')).toBe(2);
    expect(broker.tradesToday(DAY, null, 'ttp')).toBe(0);
    // …and the cap bites on the one that used it
    const alpaca = broker.destinationCfg('alpaca');
    const plan = broker.planOrder({ symbol: 'AAPL', signal: 'LONG', quantity: 1,
      price: 10, stop: 9, date: DAY, cfg: alpaca });
    expect(plan.blocked).toBe('account-cap');
  });

  test('an order recorded before destinations existed counts for the old one', () => {
    // Otherwise the day's count restarts mid-session on the day this ships.
    ledger([{ quantity: 10, price: 100 }]);          // no destination field
    expect(broker.tradesToday(DAY, null, 'ttp')).toBe(1);
    expect(broker.tradesToday(DAY, null, 'alpaca')).toBe(0);
    expect(broker.committed(DAY, 'ttp')).toBe(1000);
    expect(broker.committed(DAY, 'alpaca')).toBe(0);
  });

  test('each sends to its own hook', () => {
    expect(broker.destinationCfg('ttp').webhookUrl).toBe(HOOK_A);
    expect(broker.destinationCfg('alpaca').webhookUrl).toBe(HOOK_B);
  });

  test('an unknown destination is nothing, not the first one', () => {
    expect(broker.destinationCfg('etrade')).toBeNull();
  });
});

// ── the dialect ───────────────────────────────────────────────────────────

describe('the body each broker receives', () => {
  beforeEach(() => broker.save({ enabled: true, destinations: TWO }));

  const plan = (id) => broker.planOrder({
    symbol: 'aapl', signal: 'LONG', quantity: 10, price: 100, stop: 99,
    target: 102, date: DAY, cfg: broker.destinationCfg(id),
  });

  test('Trade The Pool gets exactly what it always got', () => {
    expect(plan('ttp').body).toEqual({
      symbol: 'AAPL', action: 'buy', quantity: 10, quantity_type: 'fixed',
      stop_loss_price: 99, take_profit_price: 102,
    });
  });

  test('Alpaca gets the two fields it accepts and TTP does not', () => {
    const b = plan('alpaca').body;
    expect(b.class).toBe('stock');
    expect(b.duration).toBe('day');
    // and nothing else moved
    expect(b.symbol).toBe('AAPL');
    expect(b.quantity).toBe(10);
    expect(b.stop_loss_price).toBe(99);
  });

  test('a dialect only ADDS — the checked fields are identical', () => {
    const a = { ...plan('alpaca').body };
    delete a.class; delete a.duration;
    expect(a).toEqual(plan('ttp').body);
  });

  test('an unknown broker type is refused, never defaulted', () => {
    // Sending Alpaca's fields to a broker that rejects them is an order lost
    // at the one moment nobody is watching.
    expect(() => broker.save({ destinations: [{ id: 'xx', dialect: 'etrade' }] }))
      .toThrow(/unknown broker type/);
  });
});

// ── what the page is allowed to see ───────────────────────────────────────

test('no hook reaches the page, not even inside a destination', () => {
  // A hook IS the ability to place orders in the account behind it. On screen
  // it can be photographed; in a chat window it has been published.
  broker.save({ enabled: true, destinations: TWO });
  const pub = JSON.stringify(broker.publicSettings());
  expect(pub).not.toContain('FAKEhookAAAAAAAAAAAAa');
  expect(pub).not.toContain('FAKEhookBBBBBBBBBBBBb');
  const alp = broker.publicSettings().destinations.find(d => d.id === 'alpaca');
  expect(alp.hasWebhook).toBe(true);
  expect(alp.webhookUrl).toMatch(/^…\/hook\/.+…/);
});

// ── saving ────────────────────────────────────────────────────────────────

describe('saving destinations', () => {
  test('the list is replaced whole, so one can be removed', () => {
    broker.save({ destinations: TWO });
    expect(broker.destinations()).toHaveLength(2);
    broker.save({ destinations: [TWO[1]] });
    expect(broker.destinations().map(d => d.id)).toEqual(['alpaca']);
  });

  test('two destinations may not share an id', () => {
    expect(() => broker.save({ destinations: [TWO[0], { ...TWO[1], id: 'ttp' }] }))
      .toThrow(/share the id/);
  });

  test('a bad hook is refused here rather than at 09:36', () => {
    expect(() => broker.save({ destinations: [{ ...TWO[0], webhookUrl: 'https://evil.example/hook/x' }] }))
      .toThrow(/not a SignalStack hook/);
  });

  test('editing a balance does not disconnect the account', () => {
    /*
     * The page never sees a hook — publicSettings masks it, because a hook IS
     * the ability to place orders in the account behind it. So a form that
     * changes anything else on a destination cannot send the hook back, and
     * without omitted-means-keep, raising a buying power would quietly unplug
     * the broker. The next morning would alert normally and trade nothing.
     */
    broker.save({ destinations: TWO });
    broker.save({ destinations: TWO.map(d => ({
      id: d.id, name: d.name, dialect: d.dialect, buyingPower: 9999 })) });
    const [ttp, alpaca] = broker.destinations();
    expect(ttp.webhookUrl).toBe(HOOK_A);
    expect(alpaca.webhookUrl).toBe(HOOK_B);
    expect(ttp.buyingPower).toBe(9999);
  });

  test('a hook can still be removed, by saying so', () => {
    // Omitted means keep; empty means gone. Otherwise there would be no way to
    // unplug an account short of deleting it.
    broker.save({ destinations: TWO });
    broker.save({ destinations: [{ ...TWO[0], webhookUrl: '' }, TWO[1]] });
    expect(broker.destinations()[0].webhookUrl).toBeNull();
  });

  test('arming needs a live destination, and names the one that is not ready', () => {
    broker.save({ destinations: [TTP_NO_POWER, TWO[1]] });
    expect(() => broker.save({ armed: true })).toThrow(/Trade The Pool/);
    broker.save({ destinations: TWO });
    expect(() => broker.save({ armed: true })).not.toThrow();
  });

  test('an id has to be usable as an id', () => {
    expect(() => broker.save({ destinations: [{ ...TWO[0], id: 'a b!' }] }))
      .toThrow(/short id/);
  });
});
