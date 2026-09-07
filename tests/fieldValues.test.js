/*
 * IS THE FIELD STILL THERE, OR IS THE MARKET JUST QUIET.
 *
 * why-empty named `relative_volume_10d_calc > 10` as the rule emptying Big
 * Move: 0 alone, 511 without it. The trader's answer was the right one:
 *
 *     "considering the complete market the 10x is not rare"
 *
 * He is right — across the whole US market a handful of names trade at ten
 * times their average volume most days. So ZERO is two findings that a COUNT
 * cannot tell apart, because both print as "0":
 *
 *     the values are real and today's top is 3.2   → the rule is rare, not broken
 *     TradingView changed the column                → nothing will ever match it
 *
 * Only the VALUES separate them, so field-values.js asks for those.
 *
 * The counts come from TradingView and cannot be tested here. What is tested
 * is the part that could quietly lie: where the number is read from, and a
 * verdict that must never call a quiet market a broken field.
 */

const fs = require('fs');
const path = require('path');
const fv = require('../scripts/field-values');
const { COMMON_COLUMNS } = require('../src/sideA/tvScanner');

const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'scripts', 'field-values.js'), 'utf8');

/** A raw TradingView row: `d` positional against COMMON_COLUMNS. */
const rawRow = (overrides = {}) => {
  const d = COMMON_COLUMNS.map(() => 0);
  for (const [col, v] of Object.entries(overrides)) {
    d[COMMON_COLUMNS.indexOf(col)] = v;
  }
  return { s: 'NASDAQ:AAA', d };
};

describe('the value is read by position from the raw response', () => {
  test('it returns the column asked for, not its neighbour', () => {
    const row = rawRow({ relative_volume_10d_calc: 12.5, close: 99 });
    expect(fv.valueOf(row, 'relative_volume_10d_calc')).toEqual(
      { misaligned: false, value: 12.5 });
    expect(fv.valueOf(row, 'close')).toEqual({ misaligned: false, value: 99 });
  });

  /*
   * NULL IS AN ANSWER AND IT IS NOT ZERO. A column TradingView has stopped
   * populating comes back empty; reporting that as 0 would put it below every
   * threshold and read as a quiet market forever.
   */
  test('an empty column comes back as null, never as a zero', () => {
    const r = fv.valueOf(rawRow({ relative_volume_10d_calc: null }),
                         'relative_volume_10d_calc');
    expect(r.value).toBeNull();
    expect(r.value).not.toBe(0);
  });

  /*
   * A SHORT RESPONSE IS REFUSED, NOT READ. Positional reading against a
   * response with fewer values would print some other column's number under
   * this one's name — the silent mistake tvScanner's own alignment check
   * exists to stop, and a diagnostic must not reintroduce it.
   */
  test('a response with the wrong number of columns is refused', () => {
    const short = { s: 'NASDAQ:AAA', d: [1, 2, 3] };
    expect(fv.valueOf(short, 'close')).toEqual({ misaligned: true, value: null });
    expect(fv.valueOf({ s: 'X' }, 'close')).toEqual({ misaligned: true, value: null });
  });
});

/*
 * WHERE IT READS FROM, and this is the whole reason the script exists rather
 * than a one-line grep of the mapped rows.
 */
describe('it never reads the mapped row', () => {
  test('mapTVRow BLENDS the two relative-volume columns', () => {
    const scanner = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'sideA', 'tvScanner.js'), 'utf8');
    expect(scanner).toContain(
      "const rvol = (intraday_rvol !== null && intraday_rvol > 0) ? intraday_rvol : tenDay_rvol;");
  });

  /*
   * SO THE MAPPED ROW CANNOT ANSWER THIS QUESTION. If
   * relative_volume_10d_calc went empty, `stock.rvol` would still carry the
   * intraday value and every row would look healthy — a script reading it
   * would report a working field while the screener using the 10-day column
   * matched nothing. That is the exact failure being investigated.
   */
  test('so the script reads the raw rows, which runScreener now returns', () => {
    expect(SRC).toContain('r.rawRows');
    expect(SRC).not.toMatch(/\brow\.stock\b/);
    const scanner = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'sideA', 'tvScanner.js'), 'utf8');
    expect(scanner).toContain('totalCount, rawRows };');
    expect(scanner).toContain('ms: Date.now() - started, rows, rawRows };');
  });
});

describe('the verdict tells a quiet market from a dead field', () => {
  test('no numbers at all is reported as the FIELD, not the market', () => {
    expect(SRC).toMatch(/not one row carried a number/);
    expect(SRC).toMatch(/'FIELD, not the market/);
    expect(SRC).toMatch(/no threshold on it can ever match/);
  });

  test('numbers present is reported as the market, with the actual maximum', () => {
    expect(SRC).toMatch(/the column is live/);
    expect(SRC).toMatch(/honestly rare AT THIS MOMENT rather /);
  });

  /*
   * AND ONE READING IS ONE MOMENT. Relative volume runs far higher near the
   * open than at midday — Big Move was measured at 11:34 and captures at
   * 09:36 — so a midday zero is not evidence about the rule at all.
   */
  test('it says a single reading is one moment, and names the reason', () => {
    expect(SRC).toMatch(/ONE READING IS ONE MOMENT/);
    expect(SRC).toMatch(/higher near the open than at midday/);
  });

  test('it changes nothing — no write path exists', () => {
    expect(SRC).not.toMatch(/store\.update\(|store\.create\(|store\.save\(/);
  });
});

describe('a column the scanner never asks for is refused, not printed as null', () => {
  test('the guard names the reason and where to add it', () => {
    expect(SRC).toContain('is not one of the columns this scanner requests');
    expect(SRC).toContain('Add it to COMMON_COLUMNS in src/sideA/tvScanner.js first');
  });
});
