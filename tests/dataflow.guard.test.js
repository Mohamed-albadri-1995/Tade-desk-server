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
const R0_COLUMNS = [
  'ticker', 'date', 'liveNow', 'inShortlist', '_score',
  'price', 'prevClose', 'open', 'change', 'gapPct', 'vwap', 'sma5',
  'ema9', 'ema13', 'ema20', 'ema50', 'rvol', 'atr', 'adrPct',
  'dayHigh', 'dayLow', 'monthHigh', 'monthLow', 'monthRangePos',
  'mcap', 'floatShares', 'shortFloat', 'pmHigh', 'pmLow', 'pmRange', 'pmAdrRatio',
  'sector', 'industry', 'screenerKeys',
  'regime', 'regimeLabel', 'longTerm', 'midTerm', 'shortTerm', 'broadResolved',
  'secBias', 'secScore', 'secHot', 'themes', 'bias',
  'vsEma9', 'vsEma13', 'vsEma20', 'vsEma50', 'vsSma5', 'vsVwap',
  'vsPrevClose', 'vsOpen', 'vsPmHigh', 'vsPmLow',
  'maStack', 'monthQuarter', 'pmAdrBand',
  'distEma9', 'distEma13', 'distEma20', 'distEma50', 'distSma5', 'distVwap',
  'distPrevClose', 'distOpen', 'distPmHigh', 'distPmLow',
  'maStackScore', 'dayRangePos', 'aboveAllMas', 'belowAllMas',
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
  test('the range-bar fields stay out of the register', () => {
    const today = seedOneRow();
    const row = getRegisterData('R0', today)[0];
    for (const f of ['quarterHigh', 'quarterLow', 'quarterRangePos',
                     'yearHigh', 'yearLow', 'yearRangePos', 'allTimeHigh']) {
      expect(row).not.toHaveProperty(f);
    }
    // …while still being on the row the card reads, or the bars would be empty
    const stock = r0.getRow('AAA').stock;
    expect(stock.quarterRangePos).not.toBeNull();
    expect(stock.allTimeHigh).toBe(99);
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
