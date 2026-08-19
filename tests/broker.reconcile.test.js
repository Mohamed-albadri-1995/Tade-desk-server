/*
 * What we believe, against what the broker says.
 *
 * The ledger is a record of INTENTIONS — what was sent, and what SignalStack
 * replied. It cannot see a stop that filled, so "what do I hold" has always
 * been *sent minus closed*, which over-reports on purpose.
 *
 * Alpaca will simply say, and the credentials were already here. This is about
 * the join between the two, and about the four ways they can disagree — each of
 * which costs something different when it is guessed instead:
 *
 *   we think open, Alpaca flat     a wasted close, and an "exit" alert for a
 *                                  trade that ended an hour ago
 *   Alpaca holds it, we do not     THE DANGEROUS ONE: the 15:50 flatten only
 *                                  closes what this side opened, so it goes
 *                                  overnight
 *   the quantity disagrees         a leg did not fill; not the tested shape
 *   the account is blocked         every order today fails, one at a time
 */

const os = require('os');
const path = require('path');
const fs = require('fs');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'reconcile-'));
process.env.BROKER_FILE = path.join(DIR, 'broker.json');
process.env.BROKER_LEDGER = path.join(DIR, 'orders.jsonl');

jest.mock('../src/alpaca/account', () => ({
  positions: jest.fn(),
  account: jest.fn(),
  fills: jest.fn(),
}));

const alpaca = require('../src/alpaca/account');
const broker = require('../src/broker/signalstack');
const reconcile = require('../src/broker/reconcile');

const HOOK = 'https://app.signalstack.com/hook/FAKEhook0000000000000a';
const HOOK2 = 'https://app.signalstack.com/hook/TESTfake0000000000000000000';
const DAY = '2026-08-18';

beforeEach(() => {
  fs.rmSync(process.env.BROKER_LEDGER, { force: true });
  fs.rmSync(process.env.BROKER_FILE, { force: true });
  broker.save({
    destinations: [
      { id: 'alp', name: 'Alpaca', dialect: 'alpaca', webhookUrl: HOOK,
        buyingPower: 100000, ratio: 1, mode: 'auto', setups: [] },
      // Trade The Pool sits behind TraderEvolution — invisible to all of this.
      { id: 'ttp', name: 'TTP', dialect: 'ttp', webhookUrl: HOOK2,
        buyingPower: 5000, ratio: 0.05, mode: 'auto', setups: [] },
    ],
    enabled: true,
  });
  broker.save({ armed: true });
  alpaca.positions.mockReset();
  alpaca.account.mockReset();
  alpaca.fills.mockReset();
  alpaca.account.mockResolvedValue({ ok: true, account: {
    equity: 50000, cash: 50000, buyingPower: 100000, daytradeCount: 0,
    tradingBlocked: false, accountBlocked: false, patternDayTrader: false,
    status: 'ACTIVE' } });
});
afterAll(() => { fs.rmSync(DIR, { recursive: true, force: true }); });

const ledger = rows => fs.writeFileSync(process.env.BROKER_LEDGER,
  rows.map(r => JSON.stringify({
    date: DAY, at: Date.now(), sent: true, symbol: 'CBRS', signal: 'LONG',
    action: 'buy', price: 10, quantity: 20, setupId: 'S@09:35',
    destination: 'alp', ...r })).join('\n'));

const holds = rows => alpaca.positions.mockResolvedValue({ ok: true,
  positions: rows.map(r => ({ symbol: 'CBRS', qty: 20, side: 'long',
    avgEntry: 10, marketValue: 200, unrealised: 0, current: 10, ...r })) });

const finding = (r, kind) => r.findings.find(f => f.kind === kind);

// ── the four disagreements ─────────────────────────────────────────────────

describe('what we believe against what Alpaca holds', () => {
  test('they agree — nothing is reported', async () => {
    ledger([{}]);
    holds([{}]);
    const r = await reconcile.compare(DAY);
    expect(r.reachable).toBe(true);
    expect(r.findings).toHaveLength(0);
  });

  /*
   * The stop or a target filled. Not an alarm — it is the normal end of a
   * trade — but the manager must not send a close for it and the flatten must
   * not pay to close it again.
   */
  test('we think open, Alpaca is FLAT → already closed', async () => {
    ledger([{}]);
    holds([]);
    const f = finding(await reconcile.compare(DAY), 'already-closed');
    expect(f).toBeTruthy();
    expect(f.level).toBe('info');
    expect(f.detail).toMatch(/Alpaca is FLAT/);
  });

  /*
   * THE DANGEROUS DIRECTION. The 15:50 flatten closes what the LEDGER says was
   * opened, so a position this side never recorded is one nothing will close.
   */
  test('Alpaca holds it and we do not know → an ERROR about going overnight', async () => {
    fs.writeFileSync(process.env.BROKER_LEDGER, '');
    holds([{ symbol: 'NVDA', qty: 100 }]);
    const f = finding(await reconcile.compare(DAY), 'unknown-position');
    expect(f.level).toBe('error');
    expect(f.detail).toMatch(/DOES NOT KNOW IT/);
    expect(f.detail).toMatch(/OVERNIGHT/);
  });

  /* ...including one we closed here that did not actually take. */
  test('closed here but still held there is the same error, worded for it', async () => {
    ledger([{}, { kind: 'flatten', action: 'close' }]);
    holds([{}]);
    const f = finding(await reconcile.compare(DAY), 'unknown-position');
    expect(f.level).toBe('error');
    expect(f.detail).toMatch(/the close did not take/);
  });

  test('a quantity that disagrees is a warning about the shape', async () => {
    ledger([{ quantity: 20 }]);
    holds([{ qty: 12 }]);
    const f = finding(await reconcile.compare(DAY), 'qty');
    expect(f.level).toBe('warn');
    expect(f.detail).toMatch(/holds 12.*sent 20/);
  });

  /*
   * AND IT MUST NOT CRY WOLF. The ledger's total spans every account; Alpaca
   * holds only its own share. Compared naively, every two-account signal would
   * report a mismatch — and a reconciliation that is wrong on the common case
   * is one that stops being read.
   */
  test('a two-account signal is NOT a quantity mismatch', async () => {
    ledger([{ destination: 'alp', quantity: 20 }, { destination: 'ttp', quantity: 2 }]);
    holds([{ qty: 20 }]);
    const r = await reconcile.compare(DAY);
    expect(finding(r, 'qty')).toBeFalsy();
  });

  /*
   * A short is held as a negative quantity and was sent as a `sell`. Compared
   * without signs, a 20-share short would look like a 20-share long.
   */
  test('a short lines up with a negative position', async () => {
    ledger([{ signal: 'SHORT', action: 'sell', quantity: 20 }]);
    holds([{ qty: -20, side: 'short' }]);
    expect(finding(await reconcile.compare(DAY), 'qty')).toBeFalsy();
  });
});

// ── the account itself ─────────────────────────────────────────────────────

describe('the account', () => {
  test('a blocked account is one line at the top, not one rejection per order', async () => {
    ledger([{}]);
    holds([{}]);
    alpaca.account.mockResolvedValue({ ok: true, account: {
      equity: 1, cash: 1, buyingPower: 0, daytradeCount: 0,
      tradingBlocked: true, accountBlocked: false, status: 'ACCOUNT_BLOCKED' } });
    const f = finding(await reconcile.compare(DAY), 'blocked');
    expect(f.level).toBe('error');
    expect(f.detail).toMatch(/BLOCKED THIS ACCOUNT/);
  });
});

// ── when it cannot ask ─────────────────────────────────────────────────────

describe('when Alpaca does not answer', () => {
  /*
   * THE MOST DANGEROUS THING THIS COULD GET WRONG. An empty position list reads
   * as "you hold nothing"; a failed request means "nobody knows". They must
   * never be the same value.
   */
  test('an unreachable broker is NOT an empty account', async () => {
    ledger([{}]);
    alpaca.positions.mockResolvedValue({ ok: false, error: 'timeout' });
    const r = await reconcile.compare(DAY);
    expect(r.reachable).toBe(false);
    expect(r.positions).toHaveLength(0);
    expect(finding(r, 'unreachable')).toBeTruthy();
    // ...and it must NOT have concluded anything about what is open.
    expect(finding(r, 'already-closed')).toBeFalsy();
    expect(finding(r, 'unknown-position')).toBeFalsy();
  });

  test('flatSymbols answers null rather than an empty set', async () => {
    alpaca.positions.mockResolvedValue({ ok: false, error: 'down' });
    expect(await reconcile.flatSymbols()).toBeNull();
  });

  test('...and a real empty account IS an empty set', async () => {
    alpaca.positions.mockResolvedValue({ ok: true, positions: [] });
    const held = await reconcile.flatSymbols();
    expect(held).toBeInstanceOf(Set);
    expect(held.size).toBe(0);
  });

  test('a held name is in it', async () => {
    holds([{ symbol: 'CBRS', qty: 20 }]);
    expect([...(await reconcile.flatSymbols())]).toEqual(['CBRS']);
  });
});

// ── scope ──────────────────────────────────────────────────────────────────

describe('one account only, and it says so', () => {
  test('the unverifiable destinations are named', async () => {
    ledger([{}]);
    holds([{}]);
    const r = await reconcile.compare(DAY);
    expect(r.scope).toEqual(['alp']);
    expect(r.unverifiable).toEqual(['ttp']);
  });

  /*
   * A name held only at Trade The Pool cannot be checked at all, and MUST NOT
   * be reported as "Alpaca is flat" — that would tell the manager to stop
   * managing a position that is still on.
   */
  test('a position held only at the prop account is not judged', async () => {
    ledger([{ destination: 'ttp' }]);
    holds([]);
    const r = await reconcile.compare(DAY);
    expect(finding(r, 'already-closed')).toBeFalsy();
    expect(finding(r, 'qty')).toBeFalsy();
  });
});

// ── the fills, for a journal ───────────────────────────────────────────────

describe('the fills', () => {
  const fills = rows => alpaca.fills.mockResolvedValue({ ok: true, fills: rows });

  test('grouped per symbol, with the average each way', async () => {
    fills([
      { symbol: 'EYPT', side: 'buy', qty: 100, price: 5.40 },
      { symbol: 'EYPT', side: 'buy', qty: 100, price: 5.42 },
      { symbol: 'EYPT', side: 'sell', qty: 200, price: 5.60 },
    ]);
    const r = await reconcile.fillsFor(DAY);
    const g = r.symbols[0];
    expect(g.bought).toBe(200);
    expect(g.avgBuy).toBeCloseTo(5.41, 6);
    expect(g.avgSell).toBeCloseTo(5.60, 6);
  });

  /*
   * A realised number on a half-closed position is not a result, it is a
   * fragment that reads like one. It says which it is instead.
   */
  test('realised P&L only once the position is round-tripped', async () => {
    fills([
      { symbol: 'EYPT', side: 'buy', qty: 200, price: 5.40 },
      { symbol: 'EYPT', side: 'sell', qty: 100, price: 5.60 },
    ]);
    const g = (await reconcile.fillsFor(DAY)).symbols[0];
    expect(g.closed).toBe(false);
    expect(g.realised).toBeNull();
  });

  test('and it is the money, not the percentage', async () => {
    fills([
      { symbol: 'EYPT', side: 'buy', qty: 100, price: 5.00 },
      { symbol: 'EYPT', side: 'sell', qty: 100, price: 5.25 },
    ]);
    const g = (await reconcile.fillsFor(DAY)).symbols[0];
    expect(g.closed).toBe(true);
    expect(g.realised).toBeCloseTo(25, 6);
  });

  test('a short round-trips the same way', async () => {
    fills([
      { symbol: 'CAPR', side: 'sell_short', qty: 100, price: 7.50 },
      { symbol: 'CAPR', side: 'buy', qty: 100, price: 7.20 },
    ]);
    const g = (await reconcile.fillsFor(DAY)).symbols[0];
    expect(g.closed).toBe(true);
    expect(g.realised).toBeCloseTo(30, 6);
  });

  test('an unreachable broker is an error, not an empty day', async () => {
    alpaca.fills.mockResolvedValue({ ok: false, error: 'down' });
    const r = await reconcile.fillsFor(DAY);
    expect(r.ok).toBe(false);
    expect(r.error).toBe('down');
  });
});
