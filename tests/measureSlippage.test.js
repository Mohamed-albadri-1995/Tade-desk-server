/*
 * THE COST THE BACKTEST CHARGES MUST COME FROM THE FILLS, NOT FROM A GUESS.
 *
 * The backtest's cost field is blank by default, deliberately: a figure nobody
 * chose would silently change what gets tested. But blank means ZERO, and zero
 * is a claim — that the nineteen seconds between the 09:34 close and the order
 * reaching the tape are free. They are not:
 *
 *     PL 2026-09-08   decided 17.75   paid 17.515   0.235   132 bps   1.27R
 *
 * So the number is measured off the desk's own ledger. What is tested here is
 * the reading of it, and the two ways it could quietly lie: calling an
 * unconfirmed order a zero, and presenting two fills as a distribution.
 */

const os = require('os');
const path = require('path');
const fs = require('fs');

const FILE = path.join(os.tmpdir(), `slip-cfg-${process.pid}.json`);
const LEDGER = path.join(os.tmpdir(), `slip-ledger-${process.pid}.jsonl`);
process.env.BROKER_FILE = FILE;
process.env.BROKER_LEDGER = LEDGER;

const ms = require('../scripts/measure-slippage');

const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'scripts', 'measure-slippage.js'), 'utf8');

const write = (rows) => fs.writeFileSync(
  LEDGER, rows.map(r => JSON.stringify(r)).join('\n') + '\n');

beforeEach(() => { try { fs.unlinkSync(LEDGER); } catch { /* absent */ } });
afterAll(() => {
  for (const f of [FILE, LEDGER]) { try { fs.unlinkSync(f); } catch { /* absent */ } }
});

/* PL and DOCU as they actually happened on 2026-09-08. */
const PL = { date: '2026-09-08', symbol: 'PL', action: 'sell', sent: true,
             price: 17.75, stop: 17.935, quantity: 2702, fillPrice: 17.515 };
const DOCU = { date: '2026-09-08', symbol: 'DOCU', action: 'sell', sent: true,
               price: 65.71, stop: 66.275, quantity: 791, fillPrice: 65.41 };

describe('the morning of 2026-09-08, measured', () => {
  beforeEach(() => write([PL, DOCU]));

  test('PL is 0.235 worse, 132 bps, and 1.27R', () => {
    const pl = ms.measured().find(t => t.symbol === 'PL');
    expect(pl.slip).toBeCloseTo(0.235, 4);
    expect(pl.bps).toBe(132);
    expect(pl.slipR).toBeCloseTo(1.27, 2);
  });

  test('the cost in money is on the size that really went out', () => {
    const pl = ms.measured().find(t => t.symbol === 'PL');
    expect(pl.dollars).toBeCloseTo(0.235 * 2702, 0);
  });

  test('DOCU is smaller in every unit, and still half an R', () => {
    const d = ms.measured().find(t => t.symbol === 'DOCU');
    expect(d.bps).toBe(46);
    expect(d.slipR).toBeCloseTo(0.53, 2);
  });

  test('the median of the two is what the cost field should hold', () => {
    expect(ms.med(ms.measured().map(t => t.bps))).toBe(89);
  });
});

/* ── what it refuses to call zero ────────────────────────────────────────── */

describe('an order with no fill is not a fill at no cost', () => {
  test('an accepted order that was never confirmed is left out entirely', () => {
    write([{ ...PL, fillPrice: null }]);
    expect(ms.measured()).toEqual([]);
  });

  /*
   * AND THE EMPTY CASE SAYS SO IN WORDS. On a paper account SignalStack sends
   * no callback at all, so "no rows" is the NORMAL state and printing 0 bps
   * from it would put a confident zero into the backtest — the exact
   * substitution the desk keeps paying for.
   */
  test('and the empty report says it is no measurement, not a zero', () => {
    expect(SRC).toMatch(/NOT a measurement of zero slippage/);
    expect(SRC).toMatch(/paper account SignalStack sends no callback/);
  });

  test('a refused order never counts — it filled nothing', () => {
    write([{ ...PL, sent: false }]);
    expect(ms.measured()).toEqual([]);
  });

  /*
   * A FLATTEN IS NOT AN ENTRY. It is the desk closing what it opened, and its
   * slip belongs to the exit — folding it into the entry figure would measure
   * two different delays as one.
   */
  test('a flatten is not an entry', () => {
    write([{ ...PL, kind: 'flatten' }]);
    expect(ms.measured()).toEqual([]);
  });
});

/* ── and what it refuses to overstate ────────────────────────────────────── */

describe('two fills are not a distribution', () => {
  test('it says so under ten, in the output itself', () => {
    expect(SRC).toMatch(/is not a distribution/);
    expect(SRC).toMatch(/first honest estimate, not a settled number/);
  });

  test('the R figure is reported as the one that bites', () => {
    expect(SRC).toMatch(/that is the one that bites/);
    expect(SRC).toMatch(/every target the broker holds is nearer/);
  });

  test('it changes nothing — no write path exists', () => {
    expect(SRC).not.toMatch(/placeOrder|\.save\(|writeFileSync/);
  });
});

/* ── the filters ─────────────────────────────────────────────────────────── */

describe('picking a period', () => {
  beforeEach(() => write([
    PL, DOCU,
    { ...PL, date: '2026-09-09', symbol: 'AXTI', action: 'buy',
      price: 73.17, stop: 71.27, fillPrice: 73.30 },
  ]));

  test('one date takes that date', () => {
    expect(ms.measured({ date: '2026-09-09' }).map(t => t.symbol)).toEqual(['AXTI']);
  });

  test('--since takes everything from it onward', () => {
    expect(ms.measured({ since: '2026-09-09' }).map(t => t.symbol)).toEqual(['AXTI']);
    expect(ms.measured({ since: '2026-09-08' })).toHaveLength(3);
  });

  test('a long filled ABOVE its decision is worse, and reads positive', () => {
    const a = ms.measured({ date: '2026-09-09' })[0];
    expect(a.slip).toBeCloseTo(0.13, 4);
    expect(a.slipR).toBeGreaterThan(0);
  });
});
