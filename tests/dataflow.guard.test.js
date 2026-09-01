/*
 * Guards on the boundary between "what the card shows" and "what gets collected".
 *
 * The whole point of the month-long run is that the data means one thing for
 * the whole month. A change made to the display — a new bar on the card, a
 * number someone wanted to see — must not quietly change what is scanned,
 * stored, frozen or trained on, or the run is comparing the first half of the
 * month against the second.
 *
 * These tests fail loudly when that boundary is crossed. If you are here
 * because one broke, the question is not "how do I update the expected list" —
 * it is "did I mean to change the dataset". Sometimes the answer is yes; then
 * the run starts over from that day, deliberately.
 */

const { getRegisterData } = require('../src/warehouse/registers');
const { computeDerivedFields } = require('../src/sideB/calculations');
const { computeRelations } = require('../src/sideB/relations');
const { mapTVRow, COMMON_COLUMNS } = require('../src/sideA/tvScanner');
const r0 = require('../src/r0/registry');
const { toETDate } = require('../src/utils/time');

jest.mock('../src/db', () => ({
  prepare: () => ({ get: () => undefined, all: () => [], run: jest.fn() }),
  transaction: (fn) => (...a) => fn(...a),
}));
jest.mock('../src/sideD/engine', () => ({ getLatestSnapshot: () => null }));

// Every column R0 carried before the range bars were added. This list IS the
// dataset — the training CSVs are built from it — so it is written out in full
// rather than derived, because a derived list would move when the code moves
// and guard nothing.
/*
 * DELIBERATELY WIDENED ON 2026-09-01, on an explicit instruction: "you need to
 * check all registers and upgrade them because the cards have more fields and
 * all of them supposed to be part of the registers".
 *
 * This is the case the note above describes — "sometimes the answer is yes;
 * then the run starts over from that day, deliberately". Anything trained
 * across 2026-09-01 is reading two different datasets, and the honest thing is
 * to treat that date as the start of the run rather than to pretend the widen
 * did not happen.
 *
 * Three families were added, all of them things the card had been showing and
 * the dataset had not been keeping:
 *
 *   the range windows   week / quarter / year / all-time, and their positions.
 *                       They were on the row and marked display-only.
 *   short interest      daysToCover and the basis, now that there is a source
 *                       for it at all — and note shortFloat itself, an
 *                       existing column, goes from always-null to carrying
 *                       values on the same date.
 *   the seven letters   cs* — every CANSLIM reading. These never touched a row
 *                       before: each arrives in the BROWSER from a different
 *                       shared file, so the card knew all seven and the
 *                       dataset knew none.
 */
const R0_COLUMNS = [
  'ticker', 'date', 'liveNow', 'inShortlist', '_score',
  'price', 'prevClose', 'open', 'change', 'gapPct', 'vwap', 'sma5',
  'ema9', 'ema13', 'ema20', 'ema50', 'rvol', 'atr', 'adrPct',
  'dayHigh', 'dayLow', 'monthHigh', 'monthLow', 'monthRangePos',
  'mcap', 'floatShares', 'shortFloat',
  'daysToCover', 'shortBasis', 'shortAsOf',
  'weekHigh', 'weekLow', 'weekRangePos',
  'quarterHigh', 'quarterLow', 'quarterRangePos',
  'yearHigh', 'yearLow', 'yearRangePos', 'allTimeHigh',
  'pmHigh', 'pmLow', 'pmRange', 'pmAdrRatio',
  'sector', 'industry', 'screenerKeys',
  'regime', 'regimeLabel', 'longTerm', 'midTerm', 'shortTerm', 'broadResolved',
  'secBias', 'secScore', 'secHot', 'themes', 'bias',
  'vsEma9', 'vsEma13', 'vsEma20', 'vsEma50', 'vsSma5', 'vsVwap',
  'vsPrevClose', 'vsOpen', 'vsPmHigh', 'vsPmLow',
  'maStack', 'monthQuarter', 'pmAdrBand',
  'distEma9', 'distEma13', 'distEma20', 'distEma50', 'distSma5', 'distVwap',
  'distPrevClose', 'distOpen', 'distPmHigh', 'distPmLow',
  'maStackScore', 'dayRangePos', 'aboveAllMas', 'belowAllMas',
  // The CANSLIM block, from its single source of truth so this list and the
  // register cannot drift apart.
  ...require('../src/sideA/canslimRow').COLUMNS,
  'catalyst', 'canslim', 'shortlistedElsewhere', 'foundMinsFromOpen', 'lastUpdated',
];

function seedOneRow() {
  const stock = computeDerivedFields({
    ticker: 'AAA', price: 50, change: 2, open: 49, pmHigh: 51, pmLow: 48, atr: 2,
    monthHigh: 60, monthLow: 40,
    // the display-only fields — present on the row, and expected NOT to travel
    quarterHigh: 70, quarterLow: 30, yearHigh: 80, yearLow: 20, allTimeHigh: 99,
  });
  const today = toETDate(Date.now());
  r0.restore([{ ticker: 'AAA', date: today, stock, signals: computeRelations(stock), context: {} }]);
  return today;
}

describe('the collected dataset does not move when the card does', () => {

  test('R0 carries exactly the columns it carried before', () => {
    const today = seedOneRow();
    const rows = getRegisterData('R0', today);
    expect(Object.keys(rows[0])).toEqual(R0_COLUMNS);
  });

  // Named separately from the list above, because this is the specific thing
  // that was added for the card and the specific thing that must not leak.
  /*
   * THIS TEST USED TO ASSERT THE OPPOSITE.
   *
   * The range windows were added to the card as display-only and deliberately
   * kept out of the dataset, so that adding a bar to a card could not quietly
   * change what was being trained on. That was the right default.
   *
   * It was reversed on 2026-09-01 by explicit instruction — "the cards have
   * more fields and all of them supposed to be part of the registers" — which
   * is the case the file header describes: the answer is sometimes yes, and
   * then the run starts from that date. Kept as a test rather than deleted,
   * because the fields travelling is now the thing worth protecting.
   */
  test('the range-bar fields are collected, as of 2026-09-01', () => {
    const today = seedOneRow();
    const row = getRegisterData('R0', today)[0];
    for (const f of ['quarterHigh', 'quarterLow', 'quarterRangePos',
                     'yearHigh', 'yearLow', 'yearRangePos', 'allTimeHigh']) {
      expect(row).toHaveProperty(f);
    }
    expect(row.allTimeHigh).toBe(99);
    // …and still on the row the card reads, or the bars would be empty
    expect(r0.getRow('AAA').stock.quarterRangePos).not.toBeNull();
  });

  test('a row with no CANSLIM reading still carries the columns', () => {
    /*
     * Absent keys give a RAGGED table: a stock with filings would have thirty
     * more columns than one without, the CSV header would depend on which row
     * came first, and a model would read "column missing" and "column null" as
     * the same thing.
     */
    const today = seedOneRow();
    const row = getRegisterData('R0', today)[0];
    const cs = require('../src/sideA/canslimRow').COLUMNS;
    for (const f of cs) expect(row).toHaveProperty(f);
    expect(row.csGroupRank).toBeNull();
  });

  test('monthRangePos still answers 0 for a flat range, as the model expects', () => {
    // Changing this to null would be defensible and would also split the
    // training set at the day it shipped. The wider ranges are allowed to say
    // null precisely because nothing trains on them.
    const out = computeDerivedFields({
      price: 50, change: 0, open: 50, pmHigh: 0, pmLow: 0, atr: 1,
      monthHigh: 50, monthLow: 50,
    });
    expect(out.monthRangePos).toBe(0);
  });
});

describe('added columns cannot silently shift the data', () => {

  // Requests go out with ignore_unknown_fields:true and mapTVRow reads by
  // index. A dropped column that also shortens the response would move every
  // field after it — ATR reading a market cap — with nothing to show for it.
  test('a short response is refused rather than mapped', async () => {
    const axios = require('axios');
    jest.spyOn(axios, 'post').mockResolvedValue({
      data: { data: [{ s: 'NASDAQ:AAA', d: new Array(COMMON_COLUMNS.length - 1).fill(1) }] },
    });
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});

    const { runScreener } = require('../src/sideA/tvScanner');
    const out = await runScreener({
      name: 'x', key: 'x', filters: [], sort: { sortBy: 'change', sortOrder: 'desc' },
    });

    expect(out.rows).toEqual([]);
    expect(out.misaligned).toBe(true);
    expect(spy.mock.calls[0][0]).toMatch(/ABORT/);

    spy.mockRestore();
    axios.post.mockRestore();
  });

  // An all-null fixture trips the type check, which is the type check doing its
  // job — it is not what these tests are about, so it is quietened here.
  let warn;
  beforeEach(() => { warn = jest.spyOn(console, 'warn').mockImplementation(() => {}); });
  afterEach(() => warn.mockRestore());

  test('a correctly sized response is mapped as normal', async () => {
    const axios = require('axios');
    const d = new Array(COMMON_COLUMNS.length).fill(null);
    d[COMMON_COLUMNS.indexOf('close')] = 12;
    jest.spyOn(axios, 'post').mockResolvedValue({
      data: { data: [{ s: 'NASDAQ:AAA', d }] },
    });

    const { runScreener } = require('../src/sideA/tvScanner');
    const out = await runScreener({
      name: 'x', key: 'x', filters: [], sort: { sortBy: 'change', sortOrder: 'desc' },
    });
    expect(out.misaligned).toBeUndefined();

    axios.post.mockRestore();
  });

  // The columns we ask for and the columns we read by name have to be the same
  // set, or getRaw returns undefined for a field nobody notices is missing.
  test('every field mapTVRow reads is a column that was requested', () => {
    const d = new Array(COMMON_COLUMNS.length).fill(null);
    d[COMMON_COLUMNS.indexOf('close')] = 10;
    const { stock } = mapTVRow({ s: 'NASDAQ:AAA', d });
    // If a name were misspelled in the mapping it would read undefined here
    // rather than null, since getRaw returns null only for known columns.
    for (const [, v] of Object.entries(stock)) expect(v).not.toBeUndefined();
  });
});

/*
 * THE WIDENING OF 2026-09-01, checked rather than described.
 *
 * "the cards have more fields and all of them supposed to be part of the
 * registers from r0 to r4". These tests fix what that turned out to mean for
 * each register, so a later change has to argue with something concrete.
 */
describe('every register carries what its own level is about', () => {
  const fs = require('fs');
  const path = require('path');
  const reg = fs.readFileSync(
    path.join(__dirname, '../src/warehouse/registers.js'), 'utf8');
  const cs = require('../src/sideA/canslimRow');

  test('R0 and R1 both carry the seven letters', () => {
    // Two spreads, one per register — and from the same constant, so they
    // cannot drift into carrying different columns.
    expect((reg.match(/canslim_row \|\| \{\}/g) || []).length).toBe(2);
    expect((reg.match(/\.\.\.CANSLIM_BLANK/g) || []).length).toBe(2);
  });

  test('the column set has ONE definition', () => {
    // Hand-listing thirty keys in three places is how a register and a card
    // start disagreeing about what a stock scored.
    expect(cs.COLUMNS.length).toBeGreaterThan(25);
    expect(Object.keys(cs.BLANK)).toEqual(cs.COLUMNS);
    expect(Object.values(cs.BLANK).every(v => v === null)).toBe(true);
  });

  test('R2 carries the MARKET model, because that is what R2 is', () => {
    // It is on every stock row as well, but there it is the same value on 150
    // rows. Here it is one row per snapshot, which is what it actually is.
    for (const f of ['oneilStatus', 'oneilDistributionDays',
                     'oneilSessionsSinceFtd', 'oneilFtdDate']) {
      expect(reg).toContain(f);
    }
  });

  test('R3 stays an OUTCOME register, with no stock description in it', () => {
    /*
     * R3A/R3B hold entry price, the highs and lows after it, and the R
     * multiples. They join to R1 by (date, ticker), so copying the stock
     * fields in would duplicate a hundred columns to save one join — and give
     * two places for the same fact to be wrong in.
     */
    const r3 = reg.slice(reg.indexOf("case 'R3A'"), reg.indexOf("case 'R4A'"));
    expect(r3).not.toContain('canslim_row');
    expect(r3).not.toMatch(/stock\?\./);
    expect(r3).toContain('upR_A');
  });

  test('the market model is READ, never recomputed for the register', () => {
    // Recomputing would give the register a chance to disagree with the card
    // and the market tab about one fact.
    expect(reg).toContain("require('../sideD/oneil').read()");
  });
});
