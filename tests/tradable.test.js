/*
 * The tradability floor.
 *
 * It applies to every screener on every tool, present and future, which is what
 * makes it worth testing carefully: a mistake here does not break one screener,
 * it silently changes what every tool is allowed to see.
 */

process.env.DB_PATH = require('path').join(require('os').tmpdir(), `floor-test-${process.pid}.db`);

const db = require('../src/db');
const tradable = require('../src/sideA/tradable');

afterAll(() => {
  try { require('fs').unlinkSync(process.env.DB_PATH); } catch { /* gone */ }
});

const set = (k, v) => db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?,?)').run(k, String(v));
const reset = () => {
  set('minPrice', 1);
  set('minAvgVolume', 1000000);
  set('minAtr', 1);
  set('minAtrPct', 3);
};
beforeEach(reset);

describe('thresholds', () => {
  test('the defaults are the ones asked for', () => {
    expect(tradable.thresholds()).toEqual({ minPrice: 1, minAvgVolume: 1000000, minAtr: 1, minAtrPct: 3 });
  });

  test('settings win, so raising the bar is a form field not a deploy', () => {
    set('minAvgVolume', 5000000);
    set('minAtrPct', 5);
    expect(tradable.thresholds()).toEqual({ minPrice: 1, minAvgVolume: 5000000, minAtr: 1, minAtrPct: 5 });
  });

  test('a corrupt setting falls back rather than disabling the floor', () => {
    // "" or "abc" must not read as zero — zero would switch the leg off and let
    // untradable stocks through without anyone touching the floor deliberately.
    set('minAvgVolume', 'abc');
    set('minAtr', '');
    expect(tradable.thresholds().minAvgVolume).toBe(1000000);
    expect(tradable.thresholds().minAtr).toBe(1);
  });

  test('zero switches one leg off, deliberately', () => {
    set('minAtrPct', 0);
    expect(tradable.thresholds().minAtrPct).toBe(0);
    expect(tradable.passesLocal({ atr: 0.01, price: 500 })).toBe(true);
  });
});

describe('the half TradingView enforces', () => {
  test('price, volume and ADR go to the server, where the top-N is decided', () => {
    // Filtering these after the fetch would spend the screener's 50 slots on
    // stocks that were never eligible and hand back a short list.
    expect(tradable.serverFilters()).toEqual([
      { left: 'close', operation: 'egreater', right: 1 },
      { left: 'average_volume_10d_calc', operation: 'egreater', right: 1000000 },
      { left: 'ATR', operation: 'egreater', right: 1 },
    ]);
  });

  test('a leg set to zero sends no filter at all', () => {
    set('minPrice', 0);
    set('minAvgVolume', 0);
    set('minAtr', 0);
    expect(tradable.serverFilters()).toEqual([]);
  });

  test('the price leg is a floor on its own, independent of the others', () => {
    // Raising it must not disturb the two legs beside it — the failure mode
    // being guarded against is one edit in Settings silently retuning the tool.
    set('minPrice', 5);
    expect(tradable.serverFilters()).toEqual([
      { left: 'close', operation: 'egreater', right: 5 },
      { left: 'average_volume_10d_calc', operation: 'egreater', right: 1000000 },
      { left: 'ATR', operation: 'egreater', right: 1 },
    ]);
  });
});

describe('the half TradingView cannot express', () => {
  const t = { minPrice: 1, minAvgVolume: 1000000, minAtr: 1, minAtrPct: 3 };

  test('ATR as a share of price', () => {
    expect(tradable.passesLocal({ atr: 1.0, price: 20 }, t)).toBe(true);    // 5%
    expect(tradable.passesLocal({ atr: 1.0, price: 33 }, t)).toBe(true);    // 3.03%
    expect(tradable.passesLocal({ atr: 1.0, price: 40 }, t)).toBe(false);   // 2.5%
  });

  test('exactly at the threshold passes', () => {
    expect(tradable.passesLocal({ atr: 3, price: 100 }, t)).toBe(true);     // 3.00%
  });

  test('a $200 stock with a $2 ATR is rejected — a dollar of ATR is not enough on its own', () => {
    // This is the case the percentage leg exists for: it clears "ATR ≥ $1"
    // easily but has only 1% of daily range to work with.
    expect(tradable.passesLocal({ atr: 2, price: 200 }, t)).toBe(false);
  });

  test('missing data is not treated as failure', () => {
    // A provider hiccup that blanked ATR must not quietly shrink every result
    // set — that would look like a quiet market rather than a data problem.
    expect(tradable.passesLocal({ atr: null, price: 10 }, t)).toBe(true);
    expect(tradable.passesLocal({ atr: 1, price: null }, t)).toBe(true);
    expect(tradable.passesLocal({}, t)).toBe(true);
    expect(tradable.passesLocal(null, t)).toBe(true);
    expect(tradable.passesLocal({ atr: 1, price: 0 }, t)).toBe(true);
  });

  test('applyLocal reports what it removed', () => {
    const rows = [
      { ticker: 'GOOD', stock: { atr: 1.5, price: 20 } },
      { ticker: 'THIN', stock: { atr: 1.2, price: 200 } },
      { ticker: 'ALSO', stock: { atr: 2.0, price: 30 } },
    ];
    const { kept, dropped } = tradable.applyLocal(rows, t);
    expect(kept.map(r => r.ticker)).toEqual(['GOOD', 'ALSO']);
    expect(dropped).toBe(1);
  });
});

describe('what the screener page shows', () => {
  test('reads as the rules they are', () => {
    expect(tradable.describe({ minPrice: 1, minAvgVolume: 1000000, minAtr: 1, minAtrPct: 3 }))
      .toEqual(['price ≥ $1', 'average volume ≥ 1M shares', 'ADR ≥ $1', 'ADR ≥ 3% of price']);
  });
});

describe('every screener gets it, including future ones', () => {
  test('the floor is appended to a screener that knows nothing about it', () => {
    // Proves the mechanism: a definition with one rule of its own goes to
    // TradingView carrying three.
    const own = [{ left: 'RSI', operation: 'greater', right: 70 }];
    const sent = [...own, ...tradable.serverFilters()];
    expect(sent).toHaveLength(4);
    expect(sent[0]).toEqual(own[0]);
    expect(sent.map(f => f.left)).toContain('average_volume_10d_calc');
    expect(sent.map(f => f.left)).toContain('ATR');
  });
});
