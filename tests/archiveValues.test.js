/*
 * WHAT WERE THE STOCKS THAT MATCHED READING, ON THE DAYS THEY DID.
 *
 * field-values.js proved the column is live: on 2026-09-08 the top of Big
 * Move's population was LULU at 6.41, with real ratios all the way down. So
 * `relative_volume_10d_calc > 10` matched nothing because the market's top was
 * 6.41 — not because TradingView had withdrawn the field.
 *
 * That still leaves half the trader's question:
 *
 *     "make sure it's really not having candidates because maybe tradingview
 *      changed something so we need to adopt"
 *
 * One quiet lunchtime proves nothing about a threshold. The desk's own archive
 * does: if the names that matched were reading 15, 22, 30, the rule works and
 * today is quiet. If they were reading 3 and 4, the rule as written could
 * never have produced them.
 *
 * The numbers come from the box. What is tested here is the reading of them —
 * the matching rule, the summary, and the caution that stops one field being
 * passed off as another.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

let DIR;
let av;
beforeAll(() => {
  DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'archv-'));
  process.env.DB_PATH = path.join(DIR, 'test.db');
  jest.resetModules();
  av = require('../scripts/archive-values');
});
afterAll(() => { fs.rmSync(DIR, { recursive: true, force: true }); delete process.env.DB_PATH; });

const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'scripts', 'archive-values.js'), 'utf8');

/* ── the value is fetched by its path, and an absence stays an absence ───── */

describe('reading a field out of a stored row', () => {
  test('a dotted path reaches into the row', () => {
    expect(av.pluck({ stock: { rvol: 12.5 } }, 'stock.rvol')).toBe(12.5);
    expect(av.pluck({ ticker: 'AAA' }, 'ticker')).toBe('AAA');
  });

  test('a path that is not there is undefined, not a crash and not a zero', () => {
    expect(av.pluck({ stock: {} }, 'stock.rvol')).toBeUndefined();
    expect(av.pluck({}, 'stock.deep.missing')).toBeUndefined();
    expect(av.pluck(null, 'stock.rvol')).toBeNull();
  });
});

/* ── the summary ─────────────────────────────────────────────────────────── */

describe('the summary describes the rows that carried a number', () => {
  const rows = (...vals) => vals.map((value, i) => ({ date: `d${i}`, ticker: 'A', value }));

  test('min, median and max over the numbers present', () => {
    expect(av.summarise(rows(3, 1, 2))).toEqual(
      { n: 3, missing: 0, min: 1, med: 2, max: 3 });
  });

  test('an even count takes the middle pair', () => {
    expect(av.summarise(rows(1, 2, 3, 4)).med).toBe(2.5);
  });

  /*
   * A MISSING READING IS COUNTED, NOT DROPPED. "12 of 96 rows have no value
   * for this field" is itself a finding — the column may have been added after
   * those rows were captured — and a median over the rest, presented without
   * saying so, is a statistic about a different population.
   */
  test('rows with no reading are counted separately, never skipped silently', () => {
    const s = av.summarise([...rows(10, 20), ...rows(null, undefined, 'n/a')]);
    expect(s).toEqual({ n: 2, missing: 3, min: 10, med: 15, max: 20 });
  });

  test('no numbers at all reports nothing rather than NaN', () => {
    expect(av.summarise(rows(null, null))).toEqual(
      { n: 0, missing: 2, min: null, med: null, max: null });
  });

  test('no rows at all is the same shape, not an exception', () => {
    expect(av.summarise([])).toEqual({ n: 0, missing: 0, min: null, med: null, max: null });
  });
});

/* ── which rows belong to which screener ─────────────────────────────────── */

describe('a screener\'s history is its own', () => {
  const db = () => require('../src/db');
  const put = (date, ticker, row) => db()
    .prepare('INSERT OR REPLACE INTO r1_frozen (date, ticker, data, captured_at) VALUES (?,?,?,?)')
    .run(date, ticker, JSON.stringify(row), Date.now());

  beforeAll(() => {
    put('2026-09-01', 'AAA', { ticker: 'AAA', screenerKeys: ['Big Move'], stock: { rvol: 22 } });
    put('2026-09-01', 'BBB', { ticker: 'BBB', screenerKeys: ['Big Move', 'Pre-Mkt'], stock: { rvol: 14 } });
    put('2026-09-02', 'CCC', { ticker: 'CCC', screenerKeys: ['Pre-Mkt'], stock: { rvol: 9 } });
    // The trap: a DIFFERENT screener whose name contains the first one's.
    put('2026-09-02', 'DDD', { ticker: 'DDD', screenerKeys: ['Big Move Extra'], stock: { rvol: 40 } });
  });

  test('it collects the rows carrying that screener', () => {
    const got = av.matches(['Big Move'], 'stock.rvol');
    expect(got.map(r => r.ticker).sort()).toEqual(['AAA', 'BBB']);
    expect(got.map(r => r.value).sort((a, b) => a - b)).toEqual([14, 22]);
  });

  /*
   * AND NOT A NEIGHBOUR'S. `data LIKE '%Big Move%'` would take "Big Move
   * Extra" too — one screener's history counted as another's and printed as a
   * fact. The keys are parsed and compared whole, the same rule
   * split-tool-history.js and why-empty.js use.
   */
  test('a screener whose name CONTAINS this one is not counted', () => {
    expect(av.matches(['Big Move'], 'stock.rvol').map(r => r.ticker)).not.toContain('DDD');
    expect(av.matches(['Big Move Extra'], 'stock.rvol').map(r => r.ticker)).toEqual(['DDD']);
  });

  test('newest day first, so the recent behaviour is what you read', () => {
    const got = av.matches(['Big Move', 'Pre-Mkt'], 'stock.rvol');
    expect(got[0].date >= got[got.length - 1].date).toBe(true);
  });

  test('a screener with no history returns nothing rather than throwing', () => {
    expect(av.matches(['Never Existed'], 'stock.rvol')).toEqual([]);
  });
});

/* ── the caution, which is the point of the whole script ─────────────────── */

describe('it will not pass one field off as another', () => {
  /*
   * `stock.rvol` IS A BLEND. mapTVRow stores relative_volume_intraday|5 when
   * it is above zero and relative_volume_10d_calc otherwise — so at a morning
   * capture the archived number is probably the INTRADAY ratio, not the
   * ten-day column Big Move filters on. It is still evidence about how unusual
   * the volume was; it is not the filter's own number, and printing it as
   * though it were is exactly the quiet substitution this desk keeps paying
   * for.
   */
  test('the blend is named, on every run that reads it', () => {
    const note = av.NOT_THE_FILTERS_NUMBER['stock.rvol'];
    expect(note).toMatch(/BLEND/);
    expect(note).toMatch(/relative_volume_intraday\|5/);
    expect(note).toMatch(/not the ten-day column/);
    expect(SRC).toContain('CAUTION: ${note}');
  });

  test('it says how to read the result against the rule, both ways round', () => {
    expect(SRC).toMatch(/comfortably above the /);
    expect(SRC).toMatch(/If they sit BELOW /);
    expect(SRC).toMatch(/could not have produced them/);
  });

  test('a screener that never produced a row says so, and is a stronger finding', () => {
    expect(SRC).toMatch(/It has never produced a card here/);
    expect(SRC).toMatch(/stronger finding /);
  });

  test('it changes nothing — one SELECT, no writes', () => {
    expect(SRC).not.toMatch(/INSERT|UPDATE|DELETE|DROP/);
  });
});
