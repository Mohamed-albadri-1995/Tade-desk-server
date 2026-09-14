/*
 * WRITE DOWN WHAT THE BROKER PAID, WHILE IT WILL STILL SAY.
 *
 * The desk's own ledger for four live sessions, 2026-09-08 to 09-11:
 *
 *     PL   |2702|17.75 |17.935|-|SENT|1351@17.38=acc 1351@runner=acc
 *     DOCU | 791|65.71 |66.275|-|SENT| 395@64.58=acc  396@runner=acc
 *     AXTI | 263|73.17 |71.273|-|SENT| 131@76.97=acc  132@runner=acc
 *     QCOM | 204|179.61|177.17|-|SENT| 102@184.49=acc 102@runner=acc
 *
 * Every fill price a dash. Real orders, real positions, and no record anywhere
 * of what a single one of them cost.
 *
 * On a paper account SignalStack sends no callback, so the ONLY record is
 * Alpaca's, and `reconcile.confirmed()` has always fetched it — into memory,
 * and thrown it away. Alpaca does not keep prints forever, so the gap cannot be
 * filled in later.
 *
 * Without it there is nothing to compare a backtest to: the backtest knows what
 * it paid and the desk knows only what it hoped to pay.
 */

const os = require('os');
const path = require('path');
const fs = require('fs');

const FILE = path.join(os.tmpdir(), `savefill-cfg-${process.pid}.json`);
const LEDGER = path.join(os.tmpdir(), `savefill-led-${process.pid}.jsonl`);
process.env.BROKER_FILE = FILE;
process.env.BROKER_LEDGER = LEDGER;

jest.mock('../src/broker/reconcile', () => ({ confirmed: jest.fn() }));

const reconcile = require('../src/broker/reconcile');
const broker = require('../src/broker/signalstack');
const { saveDay } = require('../scripts/save-fills');
const SAVE_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'scripts', 'save-fills.js'), 'utf8');

/* PL as it really went out: decided 17.75, stop 17.935, never confirmed. */
const PL = { at: 1, date: '2026-09-08', symbol: 'PL', action: 'sell', sent: true,
             price: 17.75, stop: 17.935, quantity: 2702, orderId: 'o-PL' };

const write = (rows) => fs.writeFileSync(
  LEDGER, rows.map(r => JSON.stringify(r)).join('\n') + '\n');

const answers = (rows, extra = {}) => reconcile.confirmed.mockResolvedValue(
  { ok: true, verifiable: true, rows, ...extra });

beforeEach(() => {
  try { fs.unlinkSync(LEDGER); } catch { /* absent */ }
  reconcile.confirmed.mockReset();
  write([PL]);
});
afterAll(() => {
  for (const f of [FILE, LEDGER]) { try { fs.unlinkSync(f); } catch { /* absent */ } }
});

/* ── the gap being closed ────────────────────────────────────────────────── */

describe('before it runs, the desk cannot say what it paid', () => {
  test('a sent order with no callback reports no fill price', () => {
    const r = broker.reconciled('2026-09-08')[0];
    expect(r.sent).toBe(true);
    expect(r.finalPrice).toBeNull();
    expect(r.confirmed).toBe(false);
    expect(r.slipR).toBeNull();
  });
});

describe('after it runs, the price is in the ledger for good', () => {
  beforeEach(() => answers([{ ...PL, confirmed: true, confirmedBy: 'alpaca',
                              finalPrice: 17.515, filledQty: 2702, prints: 3 }]));

  test('it saves the broker\'s price', async () => {
    const out = await saveDay('2026-09-08');
    expect(out.ok).toBe(true);
    expect(out.wrote).toHaveLength(1);
    const r = broker.reconciled('2026-09-08')[0];
    expect(r.finalPrice).toBe(17.515);
    expect(r.confirmed).toBe(true);
    expect(r.confirmedBy).toBe('alpaca');
  });

  /*
   * AND THE SLIP BECOMES MEASURABLE, which is the entire point. 0.235 on an R
   * of 0.185 is 1.27R — the trade started more than a whole R behind, and until
   * the price was stored nothing could say so.
   */
  test('and the slip is then measurable, in R', async () => {
    await saveDay('2026-09-08');
    const r = broker.reconciled('2026-09-08')[0];
    expect(r.slip).toBeCloseTo(0.235, 4);
    expect(r.slipR).toBeCloseTo(1.27, 2);
    expect(r.slipNote).toMatch(/1\.27R before the trade started/);
  });

  /*
   * THE ORDER ROW IS NEVER EDITED. It records what this side INTENDED, and that
   * is the other half of every slip measurement — rewriting it in place would
   * destroy the number the comparison is made against.
   */
  test('the order row is untouched — the fill is a new row', async () => {
    await saveDay('2026-09-08');
    const raw = fs.readFileSync(LEDGER, 'utf8').trim().split('\n').map(JSON.parse);
    expect(raw).toHaveLength(2);
    expect(raw[0]).toMatchObject({ symbol: 'PL', price: 17.75, orderId: 'o-PL' });
    expect(raw[0].fillPrice).toBeUndefined();
    expect(raw[1]).toMatchObject({ kind: 'fill', orderId: 'o-PL', fillPrice: 17.515 });
  });

  test('a stored fill is not itself an order', async () => {
    await saveDay('2026-09-08');
    expect(broker.reconciled('2026-09-08')).toHaveLength(1);
  });

  test('running it twice writes nothing the second time', async () => {
    await saveDay('2026-09-08');
    const again = await saveDay('2026-09-08');
    expect(again.wrote).toHaveLength(0);
    expect(again.skipped).toEqual(['PL']);
    expect(fs.readFileSync(LEDGER, 'utf8').trim().split('\n')).toHaveLength(2);
  });

  test('--dry shows the fill and writes nothing', async () => {
    const out = await saveDay('2026-09-08', { dry: true });
    expect(out.wrote).toHaveLength(1);
    expect(fs.readFileSync(LEDGER, 'utf8').trim().split('\n')).toHaveLength(1);
  });
});

/* ── a day that could not be asked is not a day that filled at the plan ──── */

describe('an unanswerable day keeps its dashes', () => {
  test('the broker refusing is reported, and nothing is written', async () => {
    reconcile.confirmed.mockResolvedValue({ ok: false, error: 'bad keys' });
    const out = await saveDay('2026-09-08');
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/bad keys/);
    expect(fs.readFileSync(LEDGER, 'utf8').trim().split('\n')).toHaveLength(1);
  });

  /*
   * "verifiable: false" is reconcile refusing to answer rather than answering
   * wrongly — two Alpaca accounts and no way to tell whose fill is whose. It
   * must not be read as "this day had no fills".
   */
  test('an account that cannot be asked is not an account with no fills', async () => {
    reconcile.confirmed.mockResolvedValue({ ok: true, verifiable: false, rows: [] });
    const out = await saveDay('2026-09-08');
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/no account here could be asked/);
  });

  test('a throw is caught and named, not swallowed', async () => {
    reconcile.confirmed.mockRejectedValue(new Error('timed out'));
    expect((await saveDay('2026-09-08')).error).toMatch(/timed out/);
  });

  test('a row Alpaca has no fill for is counted, never invented', async () => {
    answers([{ ...PL, confirmed: false, confirmedBy: null, finalPrice: null }]);
    const out = await saveDay('2026-09-08');
    expect(out.wrote).toHaveLength(0);
    expect(out.unmatched).toBe(1);
    expect(broker.reconciled('2026-09-08')[0].finalPrice).toBeNull();
  });

  /*
   * A CALLBACK IS THE DIRECT REPLY TO THIS ORDER and is left in place. Two
   * sources disagreeing is worth seeing rather than silently resolving.
   */
  /*
   * AN EXIT FILL IS NOT AN ENTRY WITH A MISSING PRICE. A flatten has no decided
   * price — nothing decided it, the clock did — so the line used to read
   * "decided NaN … slip —", which looks like a broken entry. It is the price
   * the position CLOSED at: AXTI on 2026-09-09 came back 71.2765, its stop to
   * four places, and that is the other half of every comparison against a
   * backtest's exit.
   */
  test('a flatten is still saved, and printed as a close rather than a slip',
       async () => {
    write([{ ...PL, kind: 'flatten', price: undefined, stop: undefined,
             orderId: 'o-FLAT' }]);
    answers([{ ...PL, kind: 'flatten', price: undefined, orderId: 'o-FLAT',
               confirmed: true, confirmedBy: 'alpaca', finalPrice: 71.2765 }]);
    const out = await saveDay('2026-09-08');
    expect(out.wrote).toHaveLength(1);
    expect(broker.slipOf(out.wrote[0], { fillPrice: 71.2765 }).slip).toBeNull();
    expect(SAVE_SRC).toMatch(/CLOSED at/);
    expect(SAVE_SRC).toMatch(/AN EXIT FILL IS NOT AN ENTRY WITH A MISSING PRICE/);
  });

  test('a real callback still wins over a stored fill', async () => {
    write([PL, { at: 2, kind: 'callback', orderId: 'o-PL',
                 status: 'filled', fillPrice: 17.60 }]);
    answers([{ ...PL, confirmed: true, confirmedBy: 'alpaca', finalPrice: 17.515 }]);
    await saveDay('2026-09-08');
    const r = broker.reconciled('2026-09-08')[0];
    expect(r.finalPrice).toBe(17.60);
    expect(r.confirmedBy).toBe('signalstack');
  });
});
