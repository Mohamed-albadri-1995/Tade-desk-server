/*
 * The shortlist across every tool.
 *
 * The rule that has to hold, same as the CANSLIM share: this is a VIEW, never a
 * filter. A tool can see what others picked; it can never gain or lose a
 * candidate, a score or a register row because of it.
 */

const os = require('os');
const path = require('path');
const fs = require('fs');

const FILE = path.join(os.tmpdir(), `gsl-test-${process.pid}.json`);
process.env.GLOBAL_SHORTLIST_FILE = FILE;
process.env.TOOL_ID = 'T4';
process.env.TOOL_NAME = 'VWAP Reclaim';

const gsl = require('../src/sideF/globalShortlist');

const DATE = '2026-08-01';
const OTHER = '2026-07-31';

// Publishing as another tool means re-reading the module under a different
// identity, which is what actually happens on the box: separate processes.
function publishAs(toolId, toolName, date, tickers) {
  const state = gsl.readAll();
  state.tools = state.tools || {};
  state.tools[toolId] = { name: toolName, date, updatedAt: Date.now(), tickers };
  fs.writeFileSync(FILE, JSON.stringify(state));
}

beforeEach(() => { try { fs.unlinkSync(FILE); } catch { /* absent */ } });
afterAll(() => { try { fs.unlinkSync(FILE); } catch { /* absent */ } });

describe('the union', () => {
  test('anything shortlisted anywhere is on it', () => {
    publishAs('T1', 'Screener', DATE, ['AAA']);
    publishAs('T7', 'Liquid Movers', DATE, ['BBB']);
    expect(gsl.union(DATE).map(r => r.ticker).sort()).toEqual(['AAA', 'BBB']);
  });

  test('names more than one tool picked sort to the top', () => {
    publishAs('T1', 'Screener', DATE, ['SOLO', 'AGREED']);
    publishAs('T7', 'Liquid Movers', DATE, ['AGREED']);
    publishAs('T9', 'Stocks in Play', DATE, ['AGREED']);
    const rows = gsl.union(DATE);
    expect(rows[0]).toMatchObject({ ticker: 'AGREED', count: 3 });
    expect(rows[1]).toMatchObject({ ticker: 'SOLO', count: 1 });
  });

  test('it names which tools picked each one', () => {
    publishAs('T1', 'Screener', DATE, ['AAA']);
    publishAs('T7', 'Liquid Movers', DATE, ['AAA']);
    expect(gsl.union(DATE)[0].tools.map(t => t.id).sort()).toEqual(['T1', 'T7']);
  });

  test("yesterday's shortlist is not today's", () => {
    publishAs('T1', 'Screener', OTHER, ['OLD']);
    publishAs('T7', 'Liquid Movers', DATE, ['NEW']);
    expect(gsl.union(DATE).map(r => r.ticker)).toEqual(['NEW']);
  });

  test('a tool that has published nothing simply contributes nothing', () => {
    publishAs('T1', 'Screener', DATE, []);
    publishAs('T7', 'Liquid Movers', DATE, ['AAA']);
    expect(gsl.union(DATE).map(r => r.ticker)).toEqual(['AAA']);
  });

  test('no file at all is an empty list, not a failure', () => {
    expect(() => gsl.union(DATE)).not.toThrow();
    expect(gsl.union(DATE)).toEqual([]);
  });

  test('a corrupt file is an empty list, not a failure', () => {
    fs.writeFileSync(FILE, 'not json at all {');
    expect(() => gsl.union(DATE)).not.toThrow();
    expect(gsl.union(DATE)).toEqual([]);
  });
});

describe('publishing', () => {
  test('a tool writes only its own entry', () => {
    publishAs('T1', 'Screener', DATE, ['THEIRS']);
    gsl.publish(DATE, [{ ticker: 'mine' }]);
    const state = gsl.readAll();
    expect(state.tools.T1.tickers).toEqual(['THEIRS']);
    expect(state.tools.T4.tickers).toEqual(['MINE']);      // upper-cased
  });

  test('publishing again replaces this tool\'s list, so a removal really removes', () => {
    gsl.publish(DATE, [{ ticker: 'AAA' }, { ticker: 'BBB' }]);
    gsl.publish(DATE, [{ ticker: 'AAA' }]);
    expect(gsl.union(DATE).map(r => r.ticker)).toEqual(['AAA']);
  });

  test('accepts plain strings as well as shortlist items', () => {
    gsl.publish(DATE, ['ccc']);
    expect(gsl.union(DATE)[0].ticker).toBe('CCC');
  });
});

describe('tagging rows', () => {
  test('a row picked by another tool is marked, without touching inShortlist', () => {
    publishAs('T1', 'Screener', DATE, ['AAA']);
    const rows = [{ ticker: 'AAA', inShortlist: false }, { ticker: 'ZZZ', inShortlist: true }];
    gsl.tagRows(rows, DATE);
    expect(rows[0].shortlistedElsewhere).toBe('yes');
    expect(rows[0].shortlistedBy).toEqual(['T1']);
    // this tool's own decision is untouched, in both directions
    expect(rows[0].inShortlist).toBe(false);
    expect(rows[1].inShortlist).toBe(true);
  });

  test('this tool picking it alone is not "elsewhere"', () => {
    gsl.publish(DATE, [{ ticker: 'AAA' }]);          // published as T4, which we are
    const rows = [{ ticker: 'AAA' }];
    gsl.tagRows(rows, DATE);
    expect(rows[0].shortlistedBy).toEqual(['T4']);
    expect(rows[0].shortlistedElsewhere).toBe('no');
  });

  test('every row gets the fields, so the model never sees them missing', () => {
    const rows = [{ ticker: 'NONE' }];
    gsl.tagRows(rows, DATE);
    expect(rows[0]).toHaveProperty('shortlistedElsewhere', 'no');
    expect(rows[0]).toHaveProperty('shortlistedBy', []);
  });

  test('tagging never adds or removes a row', () => {
    publishAs('T1', 'Screener', DATE, ['AAA']);
    const rows = [{ ticker: 'AAA' }, { ticker: 'BBB' }, { ticker: 'CCC' }];
    gsl.tagRows(rows, DATE);
    expect(rows).toHaveLength(3);
    expect(rows.map(r => r.ticker)).toEqual(['AAA', 'BBB', 'CCC']);
  });
});

describe('what reaches the month of data', () => {
  // A field that exists on the card but never reaches r1/r4 is a question the
  // month cannot answer afterwards, however good it looks on screen.
  const fs2 = require('fs');
  const registers = fs2.readFileSync(require('path').join(__dirname, '../src/warehouse/registers.js'), 'utf8');
  const processor = fs2.readFileSync(require('path').join(__dirname, '../src/scoring/processor.py'), 'utf8');

  test('shortlistedElsewhere is written into every register, not just the card', () => {
    // r1, r2-side card, r4a and r4b — four places.
    expect((registers.match(/shortlistedElsewhere:/g) || []).length).toBe(4);
  });

  test('the discovery time is carried as a number the model can use', () => {
    expect((registers.match(/foundMinsFromOpen:/g) || []).length).toBe(4);
    expect(processor).toContain("'foundMinsFromOpen'");
  });

  test('both are features the model actually reads', () => {
    expect(processor).toContain("'shortlistedElsewhere'");
  });
});

describe('minutes from the opening bell', () => {
  const { toETTime } = require('../src/utils/time');
  // Rebuild the same arithmetic the register uses, against real timestamps.
  const mins = ts => {
    const [h, m] = toETTime(ts).split(':').map(Number);
    return (h * 60 + m) - (9 * 60 + 30);
  };
  const et = (h, m) => Date.UTC(2026, 7, 3, h + 4, m);   // ET = UTC-4 in August

  test('the bell itself is zero', () => expect(mins(et(9, 30))).toBe(0));
  test('a pre-market find is negative', () => expect(mins(et(8, 0))).toBe(-90));
  test('an afternoon find is a large positive', () => expect(mins(et(14, 0))).toBe(270));
});

/*
 * Out to a TradingView watchlist.
 *
 * There is no public API for writing one, so the export is the whole route in:
 * a symbol list to paste, or a file for "Import list…". What matters here is
 * that the symbols are the ones that were actually screened.
 */
describe('the shared list carries the exchange-qualified symbol', () => {
  const gs = require('../src/sideF/globalShortlist');

  test('published entries record the symbol beside the ticker', () => {
    gs.publish('2026-08-07', [
      { ticker: 'AAPL', tvSymbol: 'NASDAQ:AAPL' },
      { ticker: 'ZTS', tvSymbol: 'NYSE:ZTS' },
    ]);
    const row = gs.union('2026-08-07').find(r => r.ticker === 'AAPL');
    expect(row.symbol).toBe('NASDAQ:AAPL');
  });

  test('a ticker with no symbol is still listed, just unqualified', () => {
    // Side A does not always supply one, and dropping the name would be a
    // silently shorter watchlist — worse than an unqualified symbol, which
    // TradingView will still resolve.
    gs.publish('2026-08-07', [{ ticker: 'NOSYM' }]);
    const row = gs.union('2026-08-07').find(r => r.ticker === 'NOSYM');
    expect(row).toBeTruthy();
    expect(row.symbol).toBeNull();
  });

  test('the older shape still reads — tickers without a symbols map', () => {
    // A tool running previous code publishes no `symbols` key at all. It must
    // keep appearing on the unified list rather than vanishing from it.
    const fs = require('fs');
    fs.writeFileSync(gs.FILE, JSON.stringify({
      tools: { T4: { name: 'VWAP Reclaim', date: '2026-08-07', tickers: ['OLD'] } },
    }));
    const row = gs.union('2026-08-07').find(r => r.ticker === 'OLD');
    expect(row).toEqual(expect.objectContaining({ ticker: 'OLD', symbol: null, count: 1 }));
  });

  test('one stock picked by two tools is one watchlist entry', () => {
    const fs = require('fs');
    fs.writeFileSync(gs.FILE, JSON.stringify({
      tools: {
        T1: { name: 'Screener', date: '2026-08-07', tickers: ['AAPL'], symbols: { AAPL: 'NASDAQ:AAPL' } },
        T7: { name: 'Liquid Movers', date: '2026-08-07', tickers: ['AAPL'], symbols: { AAPL: 'NASDAQ:AAPL' } },
      },
    }));
    const rows = gs.union('2026-08-07').filter(r => r.ticker === 'AAPL');
    expect(rows).toHaveLength(1);
    expect(rows[0].count).toBe(2);
    expect(rows[0].symbol).toBe('NASDAQ:AAPL');
  });

  test('a symbol from one tool covers the same ticker published bare by another', () => {
    const fs = require('fs');
    fs.writeFileSync(gs.FILE, JSON.stringify({
      tools: {
        T1: { name: 'Screener', date: '2026-08-07', tickers: ['ZTS'] },
        T7: { name: 'Liquid Movers', date: '2026-08-07', tickers: ['ZTS'], symbols: { ZTS: 'NYSE:ZTS' } },
      },
    }));
    expect(gs.union('2026-08-07').find(r => r.ticker === 'ZTS').symbol).toBe('NYSE:ZTS');
  });
});
