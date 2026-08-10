/*
 * Is the floor a filter, or only a label?
 *
 * The trader's question, and it is the right one to be suspicious about: if
 * the four common rules were merely drawn on the screen while the tools went
 * on collecting and training on stocks that fail them, every number the
 * analysis produces would describe a population the trader never sees.
 *
 * These tests pin the answer to the code rather than to a claim in a comment.
 * They are deliberately about the PATH — where a row can enter the day's
 * registry from — because that is what would have to change for the floor to
 * become cosmetic without anyone noticing.
 */

process.env.DB_PATH = require('path').join(require('os').tmpdir(), `floor-coll-${process.pid}.db`);

const tradable = require('../src/sideA/tradable');
const { mergeScannersIntoR0 } = require('../src/sideA/merge');

afterAll(() => {
  try { require('fs').unlinkSync(process.env.DB_PATH); } catch { /* gone */ }
});

const T = { minPrice: 1, minAvgVolume: 1000000, minAtr: 1, minAtrPct: 3 };

describe('the floor filters collection, not the view', () => {
  test('the three server legs are sent to TradingView, so those rows never arrive', () => {
    // This is the half that matters most: a stock excluded here is never
    // fetched, never mapped, never scored, never stored. It cannot be in the
    // data because it was never in the response.
    const sent = tradable.serverFilters(T).map(f => `${f.left} ${f.operation} ${f.right}`);
    expect(sent).toEqual([
      'close egreater 1',
      'average_volume_10d_calc egreater 1000000',
      'ATR egreater 1',
    ]);
  });

  test('the ADR% leg drops rows before the merge, not after the render', () => {
    // TradingView has no column for ATR as a share of price, so this leg runs
    // here. The thing being pinned is WHEN: before mergeScannersIntoR0, which
    // is the only function that introduces a new ticker to the day's registry.
    const rows = [
      { ticker: 'ROOM', stock: { atr: 1.5, price: 20 } },   // 7.5%
      { ticker: 'THIN', stock: { atr: 1.2, price: 200 } },  // 0.6%
    ];
    const { kept } = tradable.applyLocal(rows, T);
    const merged = mergeScannersIntoR0({ 'Some Screener': kept });
    expect(merged.map(r => r.ticker)).toEqual(['ROOM']);
  });

  test('a dropped row leaves nothing behind — no tag, no row, no trace', () => {
    // The failure this guards against is a "soft" floor that keeps the row and
    // marks it, which would read as filtering on screen while the registers
    // and the training data quietly held both populations.
    const rows = [{ ticker: 'THIN', stock: { atr: 1.2, price: 200 } }];
    const { kept, dropped } = tradable.applyLocal(rows, T);
    expect(dropped).toBe(1);
    expect(kept).toEqual([]);
    expect(mergeScannersIntoR0({ S: kept })).toEqual([]);
  });

  test('scanner output is the only source of new tickers', () => {
    // If some other path could introduce a ticker, the floor would apply to one
    // door and not the other. Stated as a test over the pipeline source so
    // adding a second door has to be a deliberate edit to this list.
    const src = require('fs').readFileSync(require('path').join(__dirname, '../src/pipeline.js'), 'utf8');
    const merges = src.match(/mergeScannersIntoR0\([^)]*\)/g) || [];
    expect(merges).toEqual(['mergeScannersIntoR0(candidates)']);
    // …and `candidates` is the post-floor pile, never the raw response.
    expect(src).toMatch(/const \{ candidates, labels \} = await runAllScanners\(\)/);
  });

  test('label-only screeners feed no tickers into the registry at all', () => {
    // The one screener exempt from the floor must also be the one whose rows
    // never become cards, or the exemption would be a hole in the floor.
    const src = require('fs').readFileSync(require('path').join(__dirname, '../src/pipeline.js'), 'utf8');
    expect(src).toMatch(/labelResults = labels/);
    expect(src).not.toMatch(/mergeScannersIntoR0\(\s*labels/);
  });
});

describe('the one case where a sub-floor row can get in', () => {
  /*
   * Missing data passes. That is deliberate — a provider hiccup that blanked
   * ATR must not silently shrink every result set, because a quietly emptier
   * list reads as a quiet market rather than as a data problem.
   *
   * But it is also the honest answer to "could anything below the floor be in
   * my data": yes, rows whose ATR or price came back empty. Pinned here so the
   * exception stays a known one, and countable — scripts/audit-floor.js reports
   * how many of them are actually in the collected registers.
   */
  test('a blank ATR passes rather than being dropped', () => {
    expect(tradable.passesLocal({ atr: null, price: 200 }, T)).toBe(true);
    expect(tradable.passesLocal({ atr: '', price: 200 }, T)).toBe(true);
    expect(tradable.passesLocal({}, T)).toBe(true);
  });

  test('a real number below the floor is still dropped, however small', () => {
    expect(tradable.passesLocal({ atr: 0.001, price: 200 }, T)).toBe(false);
  });

  test('the server legs have no such escape hatch', () => {
    // Price and volume are enforced by TradingView, which has the values or
    // does not return the row. Only the locally-computed leg can see a blank.
    expect(tradable.serverFilters(T)).toHaveLength(3);
  });
});
