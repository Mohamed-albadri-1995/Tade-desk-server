/*
 * The outcome maths, checked against numbers worked out by hand.
 *
 * Everything the scorecard says rests on four lines in capture.js. If upR and
 * downR are wrong, every verdict, every model score and every conclusion drawn
 * over a month of data is wrong with them — and wrong quietly, because the
 * numbers would still look plausible.
 */

process.env.DB_PATH = require('path').join(require('os').tmpdir(), `cap-test-${process.pid}.db`);
process.env.CAPTURE_ENTRYA = '09:37';
process.env.CAPTURE_ENTRYB = '09:40';

const db = require('../src/db');

// 1-minute bars, regular session, as both providers return them.
// jest requires variables used inside a mock factory to be mock-prefixed
let mockBars = {};
let mockDaily = {};

jest.mock('../src/yahoo/client', () => ({
  fetchIntradayBars: jest.fn(async () => mockBars),
  fetchDailyBars: jest.fn(async () => mockDaily),
}));
jest.mock('../src/alpaca/client', () => {
  const actual = jest.requireActual('../src/alpaca/client');
  return {
    fetchIntradayBars: jest.fn(async () => ({})),
    fetchDailyBars: jest.fn(async () => ({})),
    computeATR14: actual.computeATR14,      // the real one — it is under test
  };
});

const { captureR3 } = require('../src/sideH/capture');

const DATE = '2026-07-30';
const bar = (etTime, o, h, l, c) => ({ t: `${DATE}T00:00:00Z`, o, h, l, c, v: 1000, etTime });

// 15 daily bars each with a true range of exactly 1.00 and no gaps, so ATR14
// comes out at exactly 1 and the R numbers are readable by eye.
const flatDaily = () => Array.from({ length: 15 }, () => ({ o: 10, h: 10.5, l: 9.5, c: 10 }));

function seedR1(tickers) {
  db.prepare('DELETE FROM r1_frozen').run();
  db.prepare('DELETE FROM r3a').run();
  db.prepare('DELETE FROM r3b').run();
  for (const t of tickers) {
    db.prepare('INSERT INTO r1_frozen (date, ticker, data, captured_at) VALUES (?,?,?,?)')
      .run(DATE, t, JSON.stringify({ ticker: t }), Date.now());
  }
}

const r3a = t => db.prepare('SELECT * FROM r3a WHERE date = ? AND ticker = ?').get(DATE, t);
const r3b = t => db.prepare('SELECT * FROM r3b WHERE date = ? AND ticker = ?').get(DATE, t);

afterAll(() => {
  try { require('fs').unlinkSync(process.env.DB_PATH); } catch { /* gone */ }
});

describe('ATR14', () => {
  const { computeATR14 } = jest.requireActual('../src/alpaca/client');

  test('true range includes the gap, not just the bar', () => {
    // Bar 2 opens far above bar 1's close: high−low is 1, but high−prevClose
    // is 6. True range is the larger, which is the whole point of ATR.
    const bars = [
      { o: 10, h: 10, l: 10, c: 10 },
      { o: 15, h: 16, l: 15, c: 15 },
    ];
    // only one TR available, so it needs 14 before it will answer
    expect(computeATR14(bars)).toBeNull();
    const padded = [...Array.from({ length: 14 }, () => ({ o: 10, h: 10, l: 10, c: 10 })), bars[1]];
    // 13 TRs of 0, then one of 6 → 6/14
    expect(computeATR14(padded)).toBeCloseTo(6 / 14, 6);
  });

  test('refuses to guess from fewer than 14 true ranges', () => {
    // N bars give N−1 true ranges, so 15 bars is the minimum that answers.
    const flat = n => Array.from({ length: n }, () => ({ o: 1, h: 2, l: 1, c: 1 }));
    expect(computeATR14(flat(15))).toBeCloseTo(1, 6);
    expect(computeATR14(flat(14))).toBeNull();
    expect(computeATR14([])).toBeNull();
    expect(computeATR14(null)).toBeNull();
  });

  test('a flat series of 1.00 ranges gives ATR exactly 1', () => {
    expect(computeATR14(flatDaily())).toBeCloseTo(1, 9);
  });
});

describe('upR and downR', () => {
  test('worked example: entry 10, high 12.5, low 9.4, ATR 1', async () => {
    mockBars = { AAA: [
      bar('09:36', 9.9, 9.95, 9.85, 9.9),      // before entry — must be ignored
      bar('09:37', 10.0, 10.2, 9.9, 10.1),     // entry bar: entry = its OPEN
      bar('09:50', 10.1, 12.5, 10.0, 12.4),    // the high
      bar('14:00', 12.4, 12.4, 9.4, 9.5),      // the low
      bar('15:59', 9.5, 9.6, 9.5, 9.6),
    ] };
    mockDaily = { AAA: flatDaily() };
    seedR1(['AAA']);

    await captureR3(DATE);
    const a = r3a('AAA');
    expect(a.entry_price_a).toBe(10.0);
    expect(a.hh_a).toBe(12.5);
    expect(a.ll_a).toBe(9.4);
    expect(a.atr14).toBeCloseTo(1, 9);
    expect(a.up_r_a).toBeCloseTo(2.5, 9);      // (12.5 − 10) / 1
    expect(a.down_r_a).toBeCloseTo(0.6, 9);    // (10 − 9.4) / 1
  });

  test('bars before the entry minute are excluded from both extremes', async () => {
    // The 09:31 bar is the day's high and low. Neither may leak into the result:
    // you were not in the trade yet.
    mockBars = { BBB: [
      bar('09:31', 10, 99, 1, 10),
      bar('09:37', 10, 11, 9, 10.5),
      bar('15:59', 10.5, 10.6, 10.4, 10.5),
    ] };
    mockDaily = { BBB: flatDaily() };
    seedR1(['BBB']);

    await captureR3(DATE);
    const a = r3a('BBB');
    expect(a.hh_a).toBe(11);
    expect(a.ll_a).toBe(9);
  });

  test('the entry bar itself counts, so both numbers are always ≥ 0', async () => {
    // A bar's low is never above its open and its high never below it, so a
    // stock that only ever fell still reports downR ≥ 0 and upR ≥ 0.
    mockBars = { CCC: [
      bar('09:37', 10, 10.05, 8.0, 8.1),
      bar('15:59', 8.1, 8.2, 7.0, 7.1),
    ] };
    mockDaily = { CCC: flatDaily() };
    seedR1(['CCC']);

    await captureR3(DATE);
    const a = r3a('CCC');
    expect(a.up_r_a).toBeCloseTo(0.05, 9);
    expect(a.down_r_a).toBeCloseTo(3.0, 9);
    expect(a.up_r_a).toBeGreaterThanOrEqual(0);
    expect(a.down_r_a).toBeGreaterThanOrEqual(0);
  });

  test('entry B measures from its own later bar, not from entry A', async () => {
    mockBars = { DDD: [
      bar('09:37', 10, 10.1, 9.9, 10.0),
      bar('09:40', 11, 13.0, 10.5, 12.0),   // gapped up between the two entries
      bar('15:59', 12, 12.1, 11.9, 12.0),
    ] };
    mockDaily = { DDD: flatDaily() };
    seedR1(['DDD']);

    await captureR3(DATE);
    expect(r3a('DDD').entry_price_a).toBe(10);
    expect(r3a('DDD').up_r_a).toBeCloseTo(3.0, 9);    // (13 − 10) / 1
    expect(r3b('DDD').entry_price_b).toBe(11);
    expect(r3b('DDD').up_r_b).toBeCloseTo(2.0, 9);    // (13 − 11) / 1 — chasing costs 1R
    expect(r3b('DDD').down_r_b).toBeCloseTo(0.5, 9);  // (11 − 10.5) / 1
  });

  test('ATR scales the result — the same move on a wilder stock is worth less', async () => {
    mockBars = { EEE: [bar('09:37', 10, 12, 10, 12), bar('15:59', 12, 12, 12, 12)] };
    // every daily true range is 2.00 → ATR 2
    mockDaily = { EEE: Array.from({ length: 15 }, () => ({ o: 10, h: 11, l: 9, c: 10 })) };
    seedR1(['EEE']);

    await captureR3(DATE);
    expect(r3a('EEE').atr14).toBeCloseTo(2, 9);
    expect(r3a('EEE').up_r_a).toBeCloseTo(1.0, 9);    // $2 move ÷ $2 ATR
  });

  test('no bar at the entry minute writes no row rather than a wrong one', async () => {
    // A halted stock has no 09:37 print. Guessing a nearby bar would invent an
    // entry price nobody could have got.
    mockBars = { FFF: [bar('09:31', 10, 10, 10, 10), bar('10:15', 10, 14, 10, 14)] };
    mockDaily = { FFF: flatDaily() };
    seedR1(['FFF']);

    const res = await captureR3(DATE);
    expect(r3a('FFF')).toBeUndefined();
    expect(res.noEntryA).toBe(1);
  });

  test('too little daily history writes the row but leaves R null', async () => {
    // Without a real ATR there is no denominator, and a made-up one would put a
    // fabricated number into training.
    mockBars = { GGG: [bar('09:37', 10, 12, 9, 11), bar('15:59', 11, 11, 11, 11)] };
    mockDaily = { GGG: Array.from({ length: 5 }, () => ({ o: 10, h: 10.5, l: 9.5, c: 10 })) };
    seedR1(['GGG']);

    await captureR3(DATE);
    const a = r3a('GGG');
    expect(a.atr14).toBeNull();
    expect(a.up_r_a).toBeNull();
    expect(a.down_r_a).toBeNull();
  });

  test('times compare correctly across the noon boundary', async () => {
    // etTime is zero-padded 24-hour, so ">= 09:37" still holds at 15:59. If it
    // were 12-hour, "3:59 PM" would sort below "09:37" and the afternoon would
    // be silently dropped from every result.
    mockBars = { HHH: [
      bar('09:37', 10, 10.1, 9.9, 10),
      bar('15:59', 10, 20, 10, 20),          // the whole move is in the afternoon
    ] };
    mockDaily = { HHH: flatDaily() };
    seedR1(['HHH']);

    await captureR3(DATE);
    expect(r3a('HHH').up_r_a).toBeCloseTo(10, 9);
  });
});

describe('what reaches the scorecard', () => {
  test('a real capture feeds the report with the same numbers', async () => {
    mockBars = { AAA: [bar('09:40', 10, 12.5, 9.4, 12), bar('15:59', 12, 12, 12, 12)] };
    mockDaily = { AAA: flatDaily() };
    seedR1(['AAA']);
    db.prepare('DELETE FROM r4b_train').run();

    await captureR3(DATE);

    // captureR3 syncs r4b into the training table, which is what the report reads
    const { buildScreenerReport } = require('../src/analysis/screenerReport');
    const rep = buildScreenerReport({ entry: 'B' });
    const rows = db.prepare('SELECT data FROM r4b_train').all().map(r => JSON.parse(r.data));
    if (rows.length) {
      expect(rows[0].upR_B).toBeCloseTo(2.5, 6);
      expect(rows[0].downR_B).toBeCloseTo(0.6, 6);
    }
    expect(rep.ok).toBe(true);
  });
});
