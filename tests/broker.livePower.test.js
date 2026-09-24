/*
 * SIZE AGAINST THE ACCOUNT, NOT AGAINST A NUMBER SOMEBODY TYPED.
 *
 * Four sessions in a row, every order the Test setup produced was refused:
 *
 *     09/08  LONG UMAC 2131 sh @ 24.30   alpaca2: FAILED — insufficient buying power
 *     09/08  LONG U    1127 sh @ 41.56   alpaca2: FAILED — insufficient buying power
 *     09/09  LONG WDAY  511 sh @ 186.10  alpaca2: FAILED — insufficient buying power
 *     09/11  LONG GEO  3142 sh @ 31.82   alpaca2: FAILED — insufficient buying power
 *
 * Nothing there is an arithmetic mistake. Each is ~$50k–$100k of stock, sized
 * correctly against `buyingPower` in the settings — a figure entered by hand
 * that the account had long since stopped matching. The number was right about
 * a different account.
 *
 * So the balance is READ, per account, and the typed figure keeps the only job
 * it can honestly do: a ceiling the trader chose.
 *
 * And the SCALE-OUT path, which is what Test sends, had no reduction at all:
 * one refusal on the first leg ended the trade, which is why every one of those
 * lines says "only 0 of 3 legs went in". It now halves the WHOLE position and
 * splits it again, so the strategy's fractions survive and only the capital
 * behind them changes.
 */

const os = require('os');
const path = require('path');
const fs = require('fs');

const FILE = path.join(os.tmpdir(), `broker-power-${process.pid}.json`);
const LEDGER = path.join(os.tmpdir(), `broker-power-ledger-${process.pid}.jsonl`);
process.env.BROKER_FILE = FILE;
process.env.BROKER_LEDGER = LEDGER;

jest.mock('../src/alpaca/account', () => ({
  account: jest.fn(),
  credsOf: (d) => (d && d.alpacaKeyId && d.alpacaSecret
    ? { keyId: d.alpacaKeyId, secret: d.alpacaSecret, paper: d.alpacaPaper !== false }
    : null),
}));
jest.mock('../src/alpaca/client', () => ({
  checkShortable: async () => ({ ok: true, checked: true, easyToBorrow: true }),
}));

const alpacaAccount = require('../src/alpaca/account');
const broker = require('../src/broker/signalstack');

const HOOK = 'https://app.signalstack.com/hook/FAKEhook0000000000000a';

const DEST = {
  id: 'alpaca2', name: 'alpaca2', dialect: 'alpaca', webhookUrl: HOOK,
  // The typed figure that was never true. 100k of headroom on paper.
  buyingPower: 100000,
  alpacaKeyId: 'PKFAKEACCOUNTAAAAAAA', alpacaSecret: 'fakesecretAAAAAAAAAAAAAAAAAAAAAA',
  mode: 'auto', setups: ['test'],
};

/** Answers the balance question with `bp`, as Alpaca would. */
const answers = (bp, extra = {}) => {
  alpacaAccount.account.mockResolvedValue({
    ok: true,
    account: { number: 'PA123', buyingPower: bp, equity: bp, cash: bp,
               tradingBlocked: false, accountBlocked: false, ...extra },
  });
};

const reset = () => {
  for (const f of [FILE, LEDGER]) { try { fs.unlinkSync(f); } catch { /* absent */ } }
  broker._forgetBuyingPower();
  alpacaAccount.account.mockReset();
  global.fetch = jest.fn();
};

beforeEach(reset);
afterAll(() => {
  for (const f of [FILE, LEDGER]) { try { fs.unlinkSync(f); } catch { /* absent */ } }
});

const cfg = () => {
  broker.save({ enabled: true, armed: true, destinations: [DEST] });
  return broker.destinationCfg('alpaca2');
};

/* ── the read itself ─────────────────────────────────────────────────────── */

describe('what the account says it can afford', () => {
  test('it reports the broker\'s own number', async () => {
    answers(12345.67);
    const r = await broker.liveBuyingPower(cfg());
    expect(r).toMatchObject({ ok: true, buyingPower: 12345.67, number: 'PA123' });
    // Attributed to THIS account's keys, not the desk-wide pair.
    expect(alpacaAccount.account.mock.calls[0][0].account)
      .toMatchObject({ keyId: DEST.alpacaKeyId });
  });

  test('a second ask inside the window does not ask again', async () => {
    answers(50000);
    const c = cfg();
    await broker.liveBuyingPower(c);
    const again = await broker.liveBuyingPower(c);
    expect(again).toMatchObject({ ok: true, buyingPower: 50000, cached: true });
    expect(alpacaAccount.account).toHaveBeenCalledTimes(1);
  });

  /*
   * A FAILED READ IS NOT A ZERO. Refusing to trade because a balance check
   * timed out replaces one silent failure with another; the reason is carried
   * and sizing falls back to the typed number.
   */
  test('an account that will not answer says so, and reports no balance', async () => {
    alpacaAccount.account.mockResolvedValue({ ok: false, reason: 'timed out' });
    const r = await broker.liveBuyingPower(cfg());
    expect(r.ok).toBe(false);
    expect(r.buyingPower).toBeUndefined();
    expect(r.reason).toMatch(/timed out/);
  });

  test('a non-Alpaca account is not asked at all', async () => {
    broker.save({ enabled: true, armed: true,
      destinations: [{ ...DEST, id: 'ttp', dialect: 'ttp' }] });
    const r = await broker.liveBuyingPower(broker.destinationCfg('ttp'));
    expect(r.ok).toBe(false);
    expect(alpacaAccount.account).not.toHaveBeenCalled();
  });
});

/* ── which of the two numbers decides ────────────────────────────────────── */

/*
 * SINCE 2026-09-24 THE ORDER PATH DOES NOT ASK. Trade The Pool, reached only
 * through SignalStack, can never be asked for a balance, so the Alpaca account
 * is sized the way TTP will be: the account size it is given, less what is
 * still open (tests/broker.capital.test.js). liveBuyingPower() above is kept
 * for the Test button, which explains a refusal after it happened.
 */
describe('the order path never asks the broker for its balance', () => {
  test('placeOrder sends without reading the account', async () => {
    answers(9000);
    global.fetch.mockImplementation(() => Promise.resolve({
      ok: true, status: 200, text: async () => JSON.stringify({ id: 'o1', status: 'accepted' }) }));
    const out = await broker.placeOrder({
      symbol: 'UMAC', signal: 'long', quantity: 100, price: 24.30, stop: 24.06,
      target: 26.0, date: '2026-09-08', setupId: 'test', cfg: cfg() });
    expect(out.sent).toBe(true);
    expect(alpacaAccount.account).not.toHaveBeenCalled();
    expect(out.liveBuyingPower).toBeUndefined();
  });

  test('a balance on the cfg is not what sizes the order', () => {
    const c = { ...cfg(), buyingPower: 100000, liveBuyingPower: 9000 };
    expect(broker.remaining('2026-09-08', c)).toBe(100000);
  });
});

/* ── the scale-out, which is the shape that was failing ───────────────────── */

describe('a refused scale-out shrinks the position, not one leg', () => {
  const PLAN = {
    legs: [{ fraction: 0.5, r_multiple: 2, price: 26.0 }],
    runner: 0.5,
  };
  const order = (extra = {}) => broker.placeOrder({
    symbol: 'UMAC', signal: 'long', quantity: 2131, price: 24.30,
    stop: 24.06, target: 26.0, date: '2026-09-08', setupId: 'test',
    plan: PLAN, cfg: { ...cfg(), ...extra },
  });

  const refusal = () => Promise.resolve({
    ok: false, status: 400, text: async () => JSON.stringify({
      status: 'error', message: 'From Alpaca: insufficient buying power' }),
  });
  const accepted = (id) => Promise.resolve({
    ok: true, status: 200, text: async () => JSON.stringify({
      id, status: 'accepted', price: 24.31 }),
  });

  test('a first-leg refusal is retried at half the position, legs re-split', async () => {
    answers(500000);                       // the balance is not the constraint here
    global.fetch
      .mockImplementationOnce(refusal)     // the first leg of 2131 — refused
      .mockImplementationOnce(() => accepted('o1'))
      .mockImplementationOnce(() => accepted('o2'));

    const out = await order();
    expect(out.sent).toBe(true);
    // Both legs went in at the smaller size — the SHAPE survived.
    expect(out.legs.filter(l => l.sent)).toHaveLength(2);
    expect(out.quantity).toBe(1065);
    expect(out.reduced).toMatch(/whole position halved/);
    expect(out.reduced).toMatch(/shape is unchanged/);
  });

  /*
   * NOT WHEN SOMETHING IS ALREADY LIVE. A later leg refused means earlier legs
   * are at the broker; re-planning the whole position would place them twice.
   */
  test('a LATER leg refused is reported, never re-planned', async () => {
    answers(500000);
    global.fetch
      .mockImplementationOnce(() => accepted('o1'))
      .mockImplementationOnce(refusal);

    const out = await order();
    expect(out.partial).toBe(true);
    expect(out.shrunk).toBeUndefined();
    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(out.error).toMatch(/only 1 of 2 legs went in/);
  });

  test('a refusal that is not about money is not retried', async () => {
    answers(500000);
    global.fetch.mockImplementation(() => Promise.resolve({
      ok: false, status: 400, text: async () => JSON.stringify({
        status: 'error', message: 'asset "XE" cannot be sold short' }),
    }));
    const out = await order();
    expect(out.sent).toBe(false);
    expect(out.shrunk).toBeUndefined();
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });


});
