// The store writes to the tool's database, so point it at a scratch file.
process.env.DB_PATH = require('path').join(require('os').tmpdir(), `sb-test-${process.pid}.db`);

const store = require('../src/sideA/screenerStore');
const { PRESETS } = require('../src/sideA/seedScreeners');

const valid = { name: 'Test', filters: [{ left: 'close', operation: 'egreater', right: 1 }] };

afterAll(() => {
  try { require('fs').unlinkSync(process.env.DB_PATH); } catch { /* already gone */ }
});

describe('screener definitions — validation', () => {
  test('accepts a well-formed rule', () => {
    expect(store.validateDefinition(valid)).toEqual([]);
  });

  test('rejects an unknown field', () => {
    const e = store.validateDefinition({ name: 'x', filters: [{ left: 'nope', operation: 'greater', right: 1 }] });
    expect(e[0]).toMatch(/unknown field/);
  });

  test('rejects an unknown operation', () => {
    const e = store.validateDefinition({ name: 'x', filters: [{ left: 'close', operation: 'bogus', right: 1 }] });
    expect(e[0]).toMatch(/unknown operation/);
  });

  test('rejects a missing value', () => {
    const e = store.validateDefinition({ name: 'x', filters: [{ left: 'close', operation: 'greater' }] });
    expect(e[0]).toMatch(/missing value/);
  });

  test('requires a name and at least one rule', () => {
    expect(store.validateDefinition({ filters: [] }).length).toBe(2);
  });

  test('a between rule needs two values', () => {
    const one = store.validateDefinition({ name: 'x', filters: [{ left: 'close', operation: 'in_range', right: 5 }] });
    expect(one[0]).toMatch(/needs two values/);
    expect(store.validateDefinition({ name: 'x', filters: [{ left: 'close', operation: 'in_range', right: [1, 5] }] })).toEqual([]);
  });

  test('accepts a timeframe suffix on any field', () => {
    // "|1" daily, "|1W" weekly — how TradingView addresses another timeframe
    expect(store.isKnownField('EMA9|1')).toBe(true);
    expect(store.isKnownField('close|1W')).toBe(true);
    expect(store.isKnownField('bogus|1')).toBe(false);
  });

  test('a value may be another field, which is what allows MA-vs-MA rules', () => {
    expect(store.validateDefinition({
      name: 'stack', filters: [{ left: 'SMA5|1', operation: 'greater', right: 'EMA9|1' }],
    })).toEqual([]);
  });
});

describe('screener definitions — storage', () => {
  test('create assigns a slug key and defaults to enabled', () => {
    const s = store.create({ ...valid, name: 'My Big Movers' });
    expect(s.key).toBe('my-big-movers');
    expect(s.enabled).toBe(true);
    expect(s.limit).toBe(50);
  });

  test('a duplicate name gets a distinct key', () => {
    const a = store.create({ ...valid, name: 'Dupe' });
    const b = store.create({ ...valid, name: 'Dupe' });
    expect(a.key).toBe('dupe');
    expect(b.key).toBe('dupe-2');
  });

  test('create refuses an invalid definition', () => {
    expect(() => store.create({ name: 'bad', filters: [{ left: 'zzz', operation: 'greater', right: 1 }] }))
      .toThrow(/unknown field/);
  });

  test('update is partial — omitted fields keep their value', () => {
    const s = store.create({ ...valid, name: 'Partial' });
    const u = store.update(s.id, { enabled: false });
    expect(u.enabled).toBe(false);
    expect(u.name).toBe('Partial');
    expect(u.filters).toEqual(s.filters);
  });

  test('update refuses to save an invalid rule', () => {
    const s = store.create({ ...valid, name: 'Guarded' });
    expect(() => store.update(s.id, { filters: [{ left: 'close', operation: 'nope', right: 1 }] }))
      .toThrow(/unknown operation/);
    expect(store.get(s.id).filters).toEqual(s.filters); // unchanged
  });

  test('enabledOnly excludes disabled screeners', () => {
    const s = store.create({ ...valid, name: 'Hidden' });
    store.update(s.id, { enabled: false });
    const names = store.list({ enabledOnly: true }).map(x => x.name);
    expect(names).not.toContain('Hidden');
    expect(store.list().map(x => x.name)).toContain('Hidden');
  });

  test('remove deletes, and reports when there was nothing to delete', () => {
    const s = store.create({ ...valid, name: 'Doomed' });
    expect(store.remove(s.id)).toBe(true);
    expect(store.get(s.id)).toBeNull();
    expect(store.remove(999999)).toBe(false);
  });
});

describe('seed presets', () => {
  test("T1's presets reproduce the original three scanners", () => {
    const names = PRESETS.T1.map(s => s.name).sort();
    expect(names).toEqual(['Big Move', 'Pre-Mkt', 'Trend']);
    // the names are what land in screenerKeys, so historical cards still match
    expect(PRESETS.T1.find(s => s.name === 'Trend').filters).toHaveLength(12);
    expect(PRESETS.T1.find(s => s.name === 'Pre-Mkt').filters).toHaveLength(5);
    expect(PRESETS.T1.find(s => s.name === 'Big Move').filters).toHaveLength(3);
  });

  test('every preset for every tool is valid', () => {
    for (const [tool, defs] of Object.entries(PRESETS)) {
      for (const def of defs) {
        expect({ tool, name: def.name, errors: store.validateDefinition(def) })
          .toEqual({ tool, name: def.name, errors: [] });
      }
    }
  });

  test('tools get different screeners, so their models learn different populations', () => {
    expect(PRESETS.T1.map(s => s.key)).not.toEqual(PRESETS.T2.map(s => s.key));
    expect(PRESETS.T2.map(s => s.key)).not.toEqual(PRESETS.T3.map(s => s.key));
  });
});

describe('mirroring a screener', () => {
  const bull = {
    name: 'Stack Up', limit: 50, sort: { sortBy: 'change', sortOrder: 'desc' },
    filters: [
      { left: 'SMA5|1', operation: 'greater', right: 'EMA9|1' },
      { left: 'close', operation: 'egreater', right: 'High.1M' },
      { left: 'change', operation: 'greater', right: 5 },
      { left: 'close', operation: 'egreater', right: 1 },
      { left: 'average_volume_10d_calc', operation: 'greater', right: 2000000 },
    ],
  };

  test('a series-vs-series rule flips its operator', () => {
    const m = store.mirrorDefinition(bull);
    expect(m.filters[0]).toEqual({ left: 'SMA5|1', operation: 'less', right: 'EMA9|1' });
  });

  test('a breakout rule flips to the counterpart level, not just the operator', () => {
    // "close >= 1-month high" inverted only on the operator would be
    // "close <= 1-month high" — true of nearly every stock, and useless.
    const m = store.mirrorDefinition(bull);
    expect(m.filters[1]).toEqual({ left: 'close', operation: 'eless', right: 'Low.1M' });
  });

  test('a directional threshold flips operator AND sign', () => {
    const m = store.mirrorDefinition(bull);
    expect(m.filters[2]).toEqual({ left: 'change', operation: 'less', right: -5 });
  });

  test('quality guards survive untouched', () => {
    // Inverting "price above $1" or "volume above 2M" would select illiquid
    // junk, not the bearish counterpart of the setup.
    const m = store.mirrorDefinition(bull);
    expect(m.filters[3]).toEqual({ left: 'close', operation: 'egreater', right: 1 });
    expect(m.filters[4]).toEqual({ left: 'average_volume_10d_calc', operation: 'greater', right: 2000000 });
  });

  test('sorting on a directional field flips, so the best candidates stay on top', () => {
    expect(store.mirrorDefinition(bull).sort).toEqual({ sortBy: 'change', sortOrder: 'asc' });
  });

  test('sorting on a non-directional field does not flip', () => {
    const m = store.mirrorDefinition({ ...bull, sort: { sortBy: 'relative_volume_10d_calc', sortOrder: 'desc' } });
    expect(m.sort).toEqual({ sortBy: 'relative_volume_10d_calc', sortOrder: 'desc' });
  });

  test('the mirror is itself valid and round-trips back', () => {
    const m = store.mirrorDefinition(bull);
    expect(store.validateDefinition(m)).toEqual([]);
    const back = store.mirrorDefinition({ ...m, name: 'Stack Up' });
    expect(back.filters).toEqual(bull.filters);   // mirroring twice is identity
  });

  test('operators with no opposite are left alone', () => {
    const m = store.mirrorDefinition({
      name: 'x', filters: [{ left: 'sector', operation: 'equal', right: 'Technology' }],
    });
    expect(m.filters[0].operation).toBe('equal');
  });

  test('createMirror stores it with a distinct name and key', () => {
    const src = store.create(bull);
    const mir = store.createMirror(src.id);
    expect(mir.name).toBe('Stack Up (mirror)');
    expect(mir.key).not.toBe(src.key);
    expect(mir.filters[2].right).toBe(-5);
  });
});

describe('mirroring high/low counterpart fields', () => {
  // Inverting only the operator on a breakout rule produces a filter that
  // matches almost everything: "close below the 1-month high" is true of nearly
  // every stock. The bearish twin of a breakout is a breakDOWN.
  test('a 1-month high breakout mirrors to a 1-month low breakdown', () => {
    const m = store.mirrorDefinition({
      name: 'x', filters: [{ left: 'close', operation: 'egreater', right: 'High.1M' }],
    });
    expect(m.filters[0]).toEqual({ left: 'close', operation: 'eless', right: 'Low.1M' });
  });

  test('52-week high mirrors to 52-week low', () => {
    const m = store.mirrorDefinition({
      name: 'x', filters: [{ left: 'close', operation: 'egreater', right: 'price_52_week_high' }],
    });
    expect(m.filters[0].right).toBe('price_52_week_low');
  });

  test('the counterpart swap keeps any timeframe suffix', () => {
    const m = store.mirrorDefinition({
      name: 'x', filters: [{ left: 'close', operation: 'greater', right: 'High.1M|1W' }],
    });
    expect(m.filters[0].right).toBe('Low.1M|1W');
  });

  test('a field with no counterpart is left as itself', () => {
    const m = store.mirrorDefinition({
      name: 'x', filters: [{ left: 'close', operation: 'greater', right: 'EMA20' }],
    });
    expect(m.filters[0]).toEqual({ left: 'close', operation: 'less', right: 'EMA20' });
  });

  test('counterpart swapping still round-trips', () => {
    const def = {
      name: 'Breakout',
      filters: [
        { left: 'close', operation: 'egreater', right: 'High.1M' },
        { left: 'close', operation: 'egreater', right: 1 },
      ],
    };
    const back = store.mirrorDefinition({ ...store.mirrorDefinition(def), name: 'Breakout' });
    expect(back.filters).toEqual(def.filters);
  });

  test('every seeded mirror differs from its base in at least one rule', () => {
    // A mirror identical to its base would silently collect duplicate data for
    // a month and answer nothing.
    for (const [tool, defs] of Object.entries(PRESETS)) {
      if (defs.length !== 2) continue;   // T1 ships three, not a pair
      const [base, mirror] = defs;
      expect({ tool, same: JSON.stringify(base.filters) === JSON.stringify(mirror.filters) })
        .toEqual({ tool, same: false });
    }
  });
});
