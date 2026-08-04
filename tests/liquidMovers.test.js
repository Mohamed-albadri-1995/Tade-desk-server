// This migration only ever runs on T7, and config reads TOOL_ID once at load —
// so the identity has to be set before any module is required. Same reason the
// unified-shortlist suite does it.
process.env.TOOL_ID = 'T7';
process.env.TOOL_NAME = 'Liquid Movers';
process.env.DB_PATH = require('path').join(require('os').tmpdir(), `lm-test-${process.pid}.db`);

const store = require('../src/sideA/screenerStore');

afterAll(() => {
  try { require('fs').unlinkSync(process.env.DB_PATH); } catch { /* already gone */ }
});

describe('Liquid Movers was not filtering for liquidity', () => {
  const db = require('../src/db');
  const { tightenLiquidMovers, PRESETS: P } = require('../src/sideA/seedScreeners');

  beforeEach(() => db.prepare('DELETE FROM screeners').run());

  const seedAsShipped = () => {
    store.create({ key: 'premarket-gap', name: 'Pre-Market Gap', limit: 50,
      filters: [
        { left: 'gap', operation: 'not_in_range', right: [-3, 3] },
        { left: 'ATR', operation: 'egreater', right: 1 },
        { left: 'average_volume_90d_calc', operation: 'egreater', right: 2000000 },
      ] });
    store.create({ key: 'after-open-volume', name: 'After Open Volume', limit: 50,
      filters: [
        { left: 'relative_volume_10d_calc', operation: 'greater', right: 4 },
        { left: 'volume', operation: 'greater', right: 10000000 },
        { left: 'change', operation: 'not_in_range', right: [-3, 3] },
        { left: 'close', operation: 'greater', right: 1 },
      ] });
  };

  test('the shipped screeners use the evidence-backed $5 floor', () => {
    // Ten million shares of a $1.50 stock is $15M — a penny-stock frenzy, not
    // a liquid mover. $5 is the floor the ORB study used to exclude that noise.
    for (const d of P.T7) {
      expect(d.filters).toContainEqual({ left: 'close', operation: 'greater', right: 5 });
    }
  });

  test('the gap screener requires pre-market trade, not just a quote', () => {
    const pm = P.T7.find(d => d.key === 'premarket-gap');
    expect(pm.filters.some(f => f.left === 'premarket_volume')).toBe(true);
  });

  test('both take the top 25, not 50', () => {
    for (const d of P.T7) expect(d.limit).toBe(25);
  });

  test('the after-open screener uses no rule that drifts with the clock', () => {
    // `volume` is cumulative shares traded so far today: zero at 09:30, largest
    // at 16:00. A threshold on it is impossible in the morning and trivial by
    // the close, so the screener fills up as the session runs rather than
    // finding heavy traders. relative_volume_10d_calc divides day-to-date
    // volume by a full-day average and climbs for the same reason.
    const { PRESETS } = require('../src/sideA/seedScreeners');
    const ao = PRESETS.T7.find(d => d.key === 'after-open-volume');
    for (const bad of ['volume', 'relative_volume_10d_calc']) {
      expect({ rule: bad, present: ao.filters.some(f => f.left === bad) })
        .toEqual({ rule: bad, present: false });
    }
  });

  test('it uses the two volume fields that mean the same all day', () => {
    const { PRESETS } = require('../src/sideA/seedScreeners');
    const ao = PRESETS.T7.find(d => d.key === 'after-open-volume');
    // a ten-day average: fixed all session
    expect(ao.filters.some(f => f.left === 'average_volume_10d_calc')).toBe(true);
    // this 5-minute bar against what that bar usually does: time-matched
    expect(ao.filters.some(f => f.left === 'relative_volume_intraday|5')).toBe(true);
  });

  test('a running tool has the drifting rules removed, not retuned', () => {
    store.create({ key: 'after-open-volume', name: 'After Open Volume', limit: 50,
      filters: [
        { left: 'relative_volume_10d_calc', operation: 'greater', right: 4 },
        { left: 'volume', operation: 'greater', right: 10000000 },
        { left: 'close', operation: 'greater', right: 1 },
      ] });
    tightenLiquidMovers();
    const f = store.list()[0].filters;
    expect(f.some(x => x.left === 'volume')).toBe(false);
    expect(f.some(x => x.left === 'relative_volume_10d_calc')).toBe(false);
    expect(f.some(x => x.left === 'relative_volume_intraday|5')).toBe(true);
  });

  test('a running tool has the floor raised and the limit cut', () => {
    seedAsShipped();
    expect(tightenLiquidMovers().changed).toBe(2);
    for (const s of store.list()) {
      expect(s.limit).toBe(25);
      expect(s.filters).toContainEqual({ left: 'close', operation: 'greater', right: 5 });
    }
  });

  test("a number the trader chose is left alone, even below the new floor", () => {
    store.create({ key: 'after-open-volume', name: 'After Open Volume', limit: 50,
      filters: [
        { left: 'volume', operation: 'greater', right: 10000000 },
        { left: 'close', operation: 'greater', right: 3 },
      ] });
    tightenLiquidMovers();
    expect(store.list()[0].filters).toContainEqual({ left: 'close', operation: 'greater', right: 3 });
  });

  test('running it twice changes nothing the second time', () => {
    seedAsShipped();
    tightenLiquidMovers();
    expect(tightenLiquidMovers().changed).toBe(0);
  });

  test('a tool that is not T7 is never touched', () => {
    // Proven by construction rather than by running it: the function returns
    // immediately unless this process IS T7, and this suite sets TOOL_ID to T7
    // before loading anything. Reading the guard is the honest check here.
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '../src/sideA/seedScreeners.js'), 'utf8');
    expect(src).toContain("if (config.toolId !== 'T7') return { changed: 0 };");
  });
});
