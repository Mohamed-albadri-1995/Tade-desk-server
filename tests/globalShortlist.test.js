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
