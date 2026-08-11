/*
 * GET /api/card/:ticker — the full card behind a shortlist row.
 *
 * The point of the route is picking the right source: today comes from r0,
 * which is still being re-quoted, and anything older comes from r1_frozen,
 * which is the photo this tool took at its capture time. Getting that backwards
 * would show a stale price for today, or today's price against an old date —
 * the second one being the worse of the two, since it reads as history.
 */

const request = require('supertest');
const express = require('express');

let mockFrozen = [];       // [{ date, ticker, data, captured_at }]
let mockR0 = new Map();

jest.mock('../src/db', () => ({
  prepare: (sql) => ({
    get: (...args) => {
      if (/WHERE date = \? AND ticker = \?/.test(sql)) {
        const [date, ticker] = args;
        return mockFrozen.find(r => r.date === date && r.ticker === ticker);
      }
      if (/WHERE ticker = \? ORDER BY date DESC/.test(sql)) {
        const [ticker] = args;
        const hits = mockFrozen.filter(r => r.ticker === ticker)
          .sort((a, b) => b.date.localeCompare(a.date));
        return hits[0] ? { date: hits[0].date } : undefined;
      }
      return undefined;
    },
    all: () => [],
    run: jest.fn(),
  }),
  transaction: (fn) => (...args) => fn(...args),
}));

jest.mock('../src/r0/registry', () => ({
  getRow: (t) => mockR0.get(t),
}));

const TODAY = '2026-08-04';
jest.mock('../src/utils/time', () => ({
  ...jest.requireActual('../src/utils/time'),
  toETDate: () => '2026-08-04',
}));

const cardRouter = require('../src/routes/card');

const app = express();
app.use('/api/card', cardRouter);

const liveRow = { ticker: 'AAA', _score: 71, stock: { price: 42.5, change: 5.2 } };
const frozenRow = { ticker: 'AAA', _score: 64, stock: { price: 19.9, change: -2.1 } };

beforeEach(() => {
  mockR0 = new Map();
  mockFrozen = [];
});

describe('GET /api/card/:ticker', () => {

  test('today serves the live r0 row', async () => {
    mockR0.set('AAA', liveRow);
    const res = await request(app).get('/api/card/AAA');
    expect(res.status).toBe(200);
    expect(res.body.source).toBe('live');
    expect(res.body.date).toBe(TODAY);
    expect(res.body.card.stock.price).toBe(42.5);
  });

  test('lowercase ticker is upcased', async () => {
    mockR0.set('AAA', liveRow);
    const res = await request(app).get('/api/card/aaa');
    expect(res.status).toBe(200);
    expect(res.body.card.ticker).toBe('AAA');
  });

  // The whole reason "old" is a separate case: an earlier date must never be
  // answered with today's live row, which is what would happen if the route
  // checked r0 first regardless of date.
  test('an earlier date serves the frozen row, not r0', async () => {
    mockR0.set('AAA', liveRow);
    mockFrozen = [{ date: '2026-07-15', ticker: 'AAA', data: JSON.stringify(frozenRow), captured_at: 123 }];
    const res = await request(app).get('/api/card/AAA?date=2026-07-15');
    expect(res.status).toBe(200);
    expect(res.body.source).toBe('frozen');
    expect(res.body.date).toBe('2026-07-15');
    expect(res.body.capturedAt).toBe(123);
    expect(res.body.card.stock.price).toBe(19.9);
  });

  // A restart mid-session empties r0. The frozen row for today still exists,
  // and an older photo of today beats no card at all.
  test('today falls back to frozen when r0 has no row', async () => {
    mockFrozen = [{ date: TODAY, ticker: 'AAA', data: JSON.stringify(frozenRow), captured_at: 456 }];
    const res = await request(app).get('/api/card/AAA');
    expect(res.status).toBe(200);
    expect(res.body.source).toBe('frozen');
  });

  test('missing on this date says so and offers the most recent one', async () => {
    mockFrozen = [{ date: '2026-07-15', ticker: 'AAA', data: JSON.stringify(frozenRow), captured_at: 1 }];
    const res = await request(app).get('/api/card/AAA?date=2026-07-01');
    expect(res.status).toBe(404);
    expect(res.body.ok).toBe(false);
    expect(res.body.lastSeen).toBe('2026-07-15');
    expect(res.body.error).toMatch(/not on this tool on 2026-07-01/);
  });

  test('never seen is a different message and no lastSeen', async () => {
    const res = await request(app).get('/api/card/ZZZ?date=2026-07-01');
    expect(res.status).toBe(404);
    expect(res.body.lastSeen).toBeNull();
    expect(res.body.error).toMatch(/never been on this tool/);
  });
});
