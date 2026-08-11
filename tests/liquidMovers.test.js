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

  test("the source recipe's ten-million-share condition is kept", () => {
    // It came from the video this tool was built from. It is cumulative and so
    // it does drift — but it is the trader's stated requirement, and with the
    // rules below it no longer carries the screener on its own.
    const { PRESETS } = require('../src/sideA/seedScreeners');
    const ao = PRESETS.T7.find(d => d.key === 'after-open-volume');
    expect(ao.filters).toContainEqual({ left: 'volume', operation: 'greater', right: 10000000 });
  });

  test('it never carries the screener alone', () => {
    // The drift only mattered because nothing else held the list down. Every
    // one of these means the same at 09:40 as at 15:40.
    const { PRESETS } = require('../src/sideA/seedScreeners');
    const ao = PRESETS.T7.find(d => d.key === 'after-open-volume');
    for (const steady of ['average_volume_10d_calc', 'relative_volume_intraday|5', 'change', 'close']) {
      expect({ rule: steady, present: ao.filters.some(f => f.left === steady) })
        .toEqual({ rule: steady, present: true });
    }
  });

  test('the day-to-date relative volume is gone, because it cannot be fixed', () => {
    // Unlike `volume`, this one is not anybody's stated requirement — it
    // divides day-to-date volume by a FULL-day average, so no threshold makes
    // it mean one thing all session.
    const { PRESETS } = require('../src/sideA/seedScreeners');
    const ao = PRESETS.T7.find(d => d.key === 'after-open-volume');
    expect(ao.filters.some(f => f.left === 'relative_volume_10d_calc')).toBe(false);
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
    expect(f.some(x => x.left === 'relative_volume_10d_calc')).toBe(false);
    expect(f.some(x => x.left === 'relative_volume_intraday|5')).toBe(true);
    // the recipe's own condition survives the migration
    expect(f.some(x => x.left === 'volume')).toBe(true);
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
