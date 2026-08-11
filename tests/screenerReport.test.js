/*
 * The screener scorecard.
 *
 * The question is not "was this a good trade" — there is no stop or exit here.
 * It is "does this screener find stocks that move", which is the only thing a
 * screener can be held responsible for.
 */

process.env.DB_PATH = require('path').join(require('os').tmpdir(), `sr-test-${process.pid}.db`);

const db = require('../src/db');
const { buildScreenerReport, GOOD_R } = require('../src/analysis/screenerReport');

afterAll(() => {
  try { require('fs').unlinkSync(process.env.DB_PATH); } catch { /* gone */ }
});

beforeEach(() => db.prepare('DELETE FROM r4b_train').run());

const add = (date, ticker, keys, upR, downR = 0.5) =>
  db.prepare('INSERT OR REPLACE INTO r4b_train (date, ticker, data, source, added_at) VALUES (?,?,?,?,?)')
    .run(date, ticker, JSON.stringify({ screenerKeys: keys, upR_B: upR, downR_B: downR }), 'test', Date.now());

const find = (rep, name) => rep.screeners.find(s => s.name === name);

// 6 days × 5 cards, so the result clears the "too thin to judge" floor.
// Tickers are prefixed with the screener name: the table is keyed by
// (date, ticker), so two screeners sharing ticker names would overwrite each
// other's rows rather than sit alongside them.
const bulk = (name, upRs) => {
  let i = 0;
  for (const day of ['01', '02', '03', '04', '05', '06']) {
    for (let k = 0; k < 5; k++) {
      add(`2026-07-${day}`, `${name}-${i}`, [name], upRs[i % upRs.length]);
      i++;
    }
  }
};

describe('measuring the move', () => {
  test('a screener whose stocks run is kept', () => {
    bulk('Runner', [2.5, 1.8, 0.2, 3.0, 1.5]);
    const s = find(buildScreenerReport(), 'Runner');
    expect(s.cards).toBe(30);
    expect(s.days).toBe(6);
    expect(s.goodPct).toBe(80);
    expect(s.verdict).toBe('keep');
  });

  test('a screener whose stocks sit still is dropped', () => {
    bulk('Dud', [0.3, 0.1, 0.4, 0.2, 0.5]);
    const s = find(buildScreenerReport(), 'Dud');
    expect(s.goodPct).toBe(0);
    expect(s.verdict).toBe('drop');
  });

  test('one wild day does not buy a good verdict', () => {
    // Every big move on a single day, nothing on the other five. The average
    // flatters it; consistency is what catches it.
    for (let k = 0; k < 5; k++) add('2026-07-01', `W${k}`, ['Lucky'], 6);
    for (const day of ['02', '03', '04', '05', '06']) {
      for (let k = 0; k < 5; k++) add(`2026-07-${day}`, `L${day}${k}`, ['Lucky'], 0.2);
    }
    const s = find(buildScreenerReport(), 'Lucky');
    expect(s.avgUpR).toBeGreaterThan(1);      // average looks fine
    expect(s.consistency).toBeCloseTo(16.7, 0); // one day in six
    expect(s.verdict).not.toBe('keep');
  });

  test('too little data is left unjudged rather than guessed at', () => {
    add('2026-07-01', 'A', ['New'], 4);
    add('2026-07-02', 'B', ['New'], 4);
    const s = find(buildScreenerReport(), 'New');
    expect(s.thin).toBe(true);
    expect(s.verdict).toBe('not enough data');
  });

  test('a card matched by two screeners counts for both', () => {
    add('2026-07-01', 'AAA', ['One', 'Two'], 2);
    const rep = buildScreenerReport();
    expect(find(rep, 'One').cards).toBe(1);
    expect(find(rep, 'Two').cards).toBe(1);
  });

  test('rows stored with joined keys read the same as arrays', () => {
    db.prepare('INSERT INTO r4b_train (date, ticker, data, source, added_at) VALUES (?,?,?,?,?)')
      .run('2026-07-01', 'JOIN', JSON.stringify({ screenerKeys: 'One+Two', upR_B: 2 }), 'test', Date.now());
    const rep = buildScreenerReport();
    expect(find(rep, 'One').cards).toBe(1);
    expect(find(rep, 'Two').cards).toBe(1);
  });

  test('a card with no outcome yet is skipped, not counted as a failure', () => {
    add('2026-07-01', 'A', ['X'], 2);
    db.prepare('INSERT INTO r4b_train (date, ticker, data, source, added_at) VALUES (?,?,?,?,?)')
      .run('2026-07-02', 'B', JSON.stringify({ screenerKeys: ['X'], upR_B: null }), 'test', Date.now());
    expect(find(buildScreenerReport(), 'X').cards).toBe(1);
  });

  test('the baseline pools every card, so a screener is judged against its own tool', () => {
    bulk('Runner', [2.5, 2.5, 2.5, 2.5, 2.5]);
    bulk('Dud', [0.1, 0.1, 0.1, 0.1, 0.1]);
    const rep = buildScreenerReport();
    expect(rep.baseline.days).toBe(6);
    expect(rep.baseline.goodPct).toBe(50);
  });

  test('judged screeners sort above unjudged ones', () => {
    add('2026-07-01', 'A', ['Thin'], 9);
    bulk('Solid', [2, 2, 2, 0.1, 0.1]);
    const names = buildScreenerReport().screeners.map(s => s.name);
    expect(names[0]).toBe('Solid');
  });

  test('entry A and entry B are read from their own tables', () => {
    add('2026-07-01', 'A', ['X'], 2);
    const a = buildScreenerReport({ entry: 'A' });
    expect(a.entry).toBe('A');
    expect(a.screeners).toHaveLength(0);   // nothing written to r4a_train
    expect(buildScreenerReport({ entry: 'B' }).screeners).toHaveLength(1);
  });

  test('the good-move threshold matches what the model calls a win', () => {
    expect(GOOD_R).toBe(1.3);
  });
});
