/*
 * The orders the broker refused, and the reasons it gave.
 *
 * Three real rejection emails, on the same morning, from one live account:
 *
 *   STKH · sell 11 · SL 5.34 · TP 2.16
 *     From Alpaca: asset "STKH" cannot be sold short
 *   LBGJ · sell 18 · SL 3.67 · TP 1.63
 *     From Alpaca: asset "LBGJ" cannot be sold short
 *   NE   · buy 119 · SL 44.90 · TP 45.21
 *     From Alpaca: take_profit.limit_price must be >= base_price + 0.01
 *
 * What makes these expensive is not that they failed — it is HOW. SignalStack
 * accepts the POST and the broker refuses afterwards, so the alert is marked
 * sent, the position does not exist, and the only record is an email read
 * hours later. Both causes are knowable BEFORE sending, which is the whole
 * point of these tests.
 */

const os = require('os');
const path = require('path');
const fs = require('fs');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'broker-rej-'));
process.env.BROKER_FILE = path.join(DIR, 'broker.json');
process.env.BROKER_LEDGER = path.join(DIR, 'orders.jsonl');

jest.mock('../src/alpaca/client', () => ({ checkShortable: jest.fn() }));

const alpaca = require('../src/alpaca/client');
const broker = require('../src/broker/signalstack');

// A made-up hook id. The real one is a credential — anyone holding it can
// place orders in the account it is wired to — so it lives only in
// data/broker.json, which is gitignored.
const HOOK = 'https://app.signalstack.com/hook/FAKEhook0000000000000a';
const DAY = '2026-08-17';

const filled = () => ({
  ok: true, status: 201,
  text: async () => JSON.stringify({ id: 'ID1', status: 'filled', price: 10 }),
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
  alpaca.checkShortable.mockReset();
  alpaca.checkShortable.mockResolvedValue({ ok: true, checked: true, shortable: true,
                                            easyToBorrow: true });
});
afterAll(() => { fs.rmSync(DIR, { recursive: true, force: true }); });

/** An armed Alpaca account with room for these trades. */
function armedAlpaca() {
  broker.save({
    destinations: [{
      id: 'alp', name: 'Alpaca paper', dialect: 'alpaca', webhookUrl: HOOK,
      buyingPower: 100000, ratio: 1, mode: 'auto', setups: [],
    }],
    enabled: true,
  });
  broker.save({ armed: true, allowShort: true });
  return broker.destinationCfg('alp');
}

// ── "asset cannot be sold short" ───────────────────────────────────────────

describe('a short in a name the broker will not borrow', () => {
  test('is refused here, before anything is sent', async () => {
    const cfg = armedAlpaca();
    alpaca.checkShortable.mockResolvedValue({
      ok: false, checked: true, shortable: false, easyToBorrow: false,
      reason: 'Alpaca will not short STKH — the asset is not shortable',
    });

    const out = await broker.placeOrder({
      symbol: 'STKH', signal: 'SHORT', quantity: 11, price: 5.10,
      stop: 5.34, target: 2.16, date: DAY, cfg,
    });

    expect(out.sent).toBe(false);
    expect(out.skipped).toMatch(/not shortable/i);
    expect(global.fetch).not.toHaveBeenCalled();
    expect(alpaca.checkShortable).toHaveBeenCalledWith('STKH');
  });

  test('a shortable name goes out exactly as before', async () => {
    const cfg = armedAlpaca();
    const out = await broker.placeOrder({
      symbol: 'ZTG', signal: 'SHORT', quantity: 11, price: 5.10,
      stop: 5.34, target: 4.62, date: DAY, cfg,
    });
    expect(out.sent).toBe(true);
    expect(sent[0].body).toMatchObject({ symbol: 'ZTG', action: 'sell', quantity: 11 });
  });

  /*
   * A check that cannot run must not block the order. No credentials, a network
   * blip, or a symbol Alpaca does not list would otherwise stop every short on
   * the box — a far worse failure than the emails this exists to prevent.
   */
  test('an unanswerable check sends anyway and lets the broker decide', async () => {
    const cfg = armedAlpaca();
    alpaca.checkShortable.mockResolvedValue({
      ok: true, checked: false, reason: 'Alpaca credentials not set',
    });
    const out = await broker.placeOrder({
      symbol: 'ZTG', signal: 'SHORT', quantity: 11, price: 5.10,
      stop: 5.34, target: 4.62, date: DAY, cfg,
    });
    expect(out.sent).toBe(true);
  });

  /* A LONG is not a borrow question, and asking would waste a call per order. */
  test('a long is never asked about', async () => {
    const cfg = armedAlpaca();
    await broker.placeOrder({
      symbol: 'NE', signal: 'LONG', quantity: 10, price: 45.00,
      stop: 44.90, target: 45.30, date: DAY, cfg,
    });
    expect(alpaca.checkShortable).not.toHaveBeenCalled();
  });

  /*
   * Trade The Pool is a prop desk that shorts what it lists. Asking Alpaca
   * about an account Alpaca does not hold answers the wrong question, and a
   * false "not shortable" there would silently kill every prop short.
   */
  test('a non-Alpaca account is not asked about Alpaca', async () => {
    broker.save({
      destinations: [{ id: 'ttp', name: 'TTP', dialect: 'ttp', webhookUrl: HOOK,
                       buyingPower: 100000, ratio: 1, mode: 'auto', setups: [] }],
      enabled: true,
    });
    broker.save({ armed: true, allowShort: true });
    const out = await broker.placeOrder({
      symbol: 'STKH', signal: 'SHORT', quantity: 11, price: 5.10,
      stop: 5.34, target: 4.62, date: DAY, cfg: broker.destinationCfg('ttp'),
    });
    expect(alpaca.checkShortable).not.toHaveBeenCalled();
    expect(out.sent).toBe(true);
  });
});

// ── "take_profit.limit_price must be >= base_price + 0.01" ─────────────────

describe('a target too close to the entry', () => {
  /*
   * The NE order, as it actually went out. The broker's complaint was the cent
   * of clearance; the trade's problem is bigger than that — thirty cents of
   * risk for one cent of reward is not the strategy that was tested, it is the
   * strategy after the move already happened.
   */
  test('the real NE order is refused, and the reason names the R', async () => {
    const cfg = armedAlpaca();
    const out = await broker.placeOrder({
      symbol: 'NE', signal: 'LONG', quantity: 119, price: 45.20,
      stop: 44.90, target: 45.21, date: DAY, cfg,
    });
    expect(out.sent).toBe(false);
    expect(out.skipped).toMatch(/clearance|0\.\d\dR/);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('a target inside a cent of the entry is refused on either side', async () => {
    const cfg = armedAlpaca();
    for (const t of [
      { signal: 'LONG', price: 10.00, stop: 9.00, target: 10.005 },
      { signal: 'SHORT', price: 10.00, stop: 11.00, target: 9.995 },
    ]) {
      const out = await broker.placeOrder({ symbol: 'ZTG', quantity: 10, date: DAY,
                                            cfg, ...t });
      expect(out.sent).toBe(false);
    }
  });

  /*
   * The floor is a tenth of the stop distance — a level no strategy here aims
   * at and which cannot pay a commission. It is a floor on arithmetic that has
   * plainly gone wrong, not a view on what a good target is: 0.5R is a thin
   * trade and it still goes out, because that is the trader's call.
   */
  test('below a tenth of R is refused', async () => {
    const cfg = armedAlpaca();
    const out = await broker.placeOrder({
      symbol: 'ZTG', signal: 'LONG', quantity: 10, price: 50.00,
      stop: 49.00, target: 50.05, date: DAY, cfg,       // 0.05R
    });
    expect(out.sent).toBe(false);
    expect(out.skipped).toMatch(/0\.05R/);
  });

  test('a thin but deliberate target still goes out', async () => {
    const cfg = armedAlpaca();
    const out = await broker.placeOrder({
      symbol: 'ZTG', signal: 'LONG', quantity: 10, price: 50.00,
      stop: 49.00, target: 50.50, date: DAY, cfg,       // 0.5R
    });
    expect(out.sent).toBe(true);
  });

  test('an ordinary 2R target is untouched', async () => {
    const cfg = armedAlpaca();
    const out = await broker.placeOrder({
      symbol: 'LIFE', signal: 'LONG', quantity: 40, price: 29.05,
      stop: 27.68, target: 31.79, date: DAY, cfg,
    });
    expect(out.sent).toBe(true);
    expect(sent[0].body).toMatchObject({ stop_loss_price: 27.68, take_profit_price: 31.79 });
  });
});

/*
 * WHEN THE BORROW CHECK ITSELF DOES NOT RUN.
 *
 * CAPR, live: sent as a short, refused by Alpaca with "asset cannot be sold
 * short" — and the very same lookup, run by hand a few hours later, answered
 * `{ ok: false, checked: true, shortable: false }`. The check was right. It
 * just did not happen, at 09:36:18, in the same second as everything else the
 * box does.
 *
 * It still must not block: refusing every short because Alpaca did not answer
 * is a worse failure than the rejection this prevents. So two things changed
 * instead — ask twice, and carry "did not run" onto the order, because a
 * protective check that silently did not happen looks exactly like one that
 * passed.
 */
describe('a borrow check that could not run', () => {
  test('the order still goes — an unanswerable check never blocks', async () => {
    const cfg = armedAlpaca();
    alpaca.checkShortable.mockResolvedValue({
      ok: true, checked: false, reason: 'Alpaca asset CAPR 500: upstream' });
    const out = await broker.placeOrder({
      symbol: 'CAPR', signal: 'SHORT', quantity: 40, price: 7.58,
      stop: 7.89, target: 6.96, date: DAY, cfg });
    expect(out.sent).toBe(true);
  });

  /* ...and SAYS SO, on the row the alert is built from. */
  test('the order carries "not checked", with the reason', async () => {
    const cfg = armedAlpaca();
    alpaca.checkShortable.mockResolvedValue({
      ok: true, checked: false, reason: 'Alpaca asset CAPR 500: upstream' });
    const out = await broker.placeOrder({
      symbol: 'CAPR', signal: 'SHORT', quantity: 40, price: 7.58,
      stop: 7.89, target: 6.96, date: DAY, cfg });
    expect(out.borrowUnchecked).toMatch(/500: upstream/);

    const { orderLine } = require('../src/setups/runner');
    expect(orderLine(out)).toMatch(/BORROW NOT CHECKED/);
    expect(orderLine(out)).toMatch(/cannot be sold short/);
  });

  test('a check that DID run leaves no note at all', async () => {
    const cfg = armedAlpaca();
    const out = await broker.placeOrder({
      symbol: 'ZTG', signal: 'SHORT', quantity: 40, price: 7.58,
      stop: 7.89, target: 6.96, date: DAY, cfg });
    expect(out.borrowUnchecked).toBeNull();
    expect(require('../src/setups/runner').orderLine(out)).not.toMatch(/BORROW NOT CHECKED/);
  });

  test('shortable but hard to borrow is said too, and still sends', async () => {
    const cfg = armedAlpaca();
    alpaca.checkShortable.mockResolvedValue({
      ok: true, checked: true, shortable: true, easyToBorrow: false });
    const out = await broker.placeOrder({
      symbol: 'ZTG', signal: 'SHORT', quantity: 40, price: 7.58,
      stop: 7.89, target: 6.96, date: DAY, cfg });
    expect(out.sent).toBe(true);
    expect(require('../src/setups/runner').orderLine(out)).toMatch(/HARD to borrow/);
  });

  /* A long is never asked about borrow, so it never carries the note. */
  test('a long carries no borrow note', async () => {
    const cfg = armedAlpaca();
    alpaca.checkShortable.mockResolvedValue({ ok: true, checked: false, reason: 'x' });
    const out = await broker.placeOrder({
      symbol: 'EYPT', signal: 'LONG', quantity: 40, price: 5.39,
      stop: 5.03, target: 6.10, date: DAY, cfg });
    expect(out.borrowUnchecked).toBeNull();
    expect(alpaca.checkShortable).not.toHaveBeenCalled();
  });
});
