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

describe('run windows', () => {
  const base = { name: 'PM', filters: [{ left: 'close', operation: 'egreater', right: 1 }] };
  // July, so Eastern is UTC-4.
  const etAt = (h, m = 0) => Date.UTC(2026, 6, 29, h + 4, m);

  test('no window means it runs on every scan', () => {
    expect(store.validateDefinition(base)).toEqual([]);
    expect(store.isActiveAt({ runFrom: null, runTo: null }, etAt(11))).toBe(true);
  });

  test('a window needs both ends', () => {
    expect(store.validateDefinition({ ...base, runFrom: '04:00' })[0]).toMatch(/both a start and an end/);
    expect(store.validateDefinition({ ...base, runTo: '09:30' })[0]).toMatch(/both a start and an end/);
  });

  test('times must be HH:MM and start before end', () => {
    expect(store.validateDefinition({ ...base, runFrom: '25:00', runTo: '09:30' })[0]).toMatch(/invalid start/);
    expect(store.validateDefinition({ ...base, runFrom: '04:00', runTo: '9:30' })[0]).toMatch(/invalid end/);
    expect(store.validateDefinition({ ...base, runFrom: '10:00', runTo: '09:00' })[0]).toMatch(/start before it ends/);
  });

  test('a pre-market screener is asleep after the open', () => {
    const pm = { runFrom: '04:00', runTo: '09:30' };
    expect(store.isActiveAt(pm, etAt(6))).toBe(true);
    expect(store.isActiveAt(pm, etAt(9, 29))).toBe(true);
    expect(store.isActiveAt(pm, etAt(9, 30))).toBe(false);  // end is exclusive
    expect(store.isActiveAt(pm, etAt(11))).toBe(false);
  });

  test('an after-open screener is asleep before it', () => {
    const ao = { runFrom: '09:30', runTo: '16:00' };
    expect(store.isActiveAt(ao, etAt(6))).toBe(false);
    expect(store.isActiveAt(ao, etAt(9, 30))).toBe(true);   // start is inclusive
    expect(store.isActiveAt(ao, etAt(15, 59))).toBe(true);
    expect(store.isActiveAt(ao, etAt(16))).toBe(false);
  });

  test('the two sessions do not overlap, so a stock lands in one or the other', () => {
    const pm = { runFrom: '04:00', runTo: '09:30' };
    const ao = { runFrom: '09:30', runTo: '16:00' };
    for (const h of [5, 8, 10, 14]) {
      expect(store.isActiveAt(pm, etAt(h)) && store.isActiveAt(ao, etAt(h))).toBe(false);
    }
  });

  test('the window survives storage and update', () => {
    const s = store.create({ ...base, name: 'Windowed', runFrom: '04:00', runTo: '09:30' });
    expect(store.get(s.id).runFrom).toBe('04:00');
    store.update(s.id, { runTo: '08:00' });
    expect(store.get(s.id).runTo).toBe('08:00');
    expect(store.get(s.id).runFrom).toBe('04:00');   // untouched
  });

  test('a mirror inherits the window, or the pair is not comparable', () => {
    const m = store.mirrorDefinition({ ...base, runFrom: '04:00', runTo: '09:30' });
    expect(m.runFrom).toBe('04:00');
    expect(m.runTo).toBe('09:30');
  });
});

describe('the session screeners', () => {
  const { SESSION_SCREENERS } = require('../src/sideA/seedScreeners');
  const byKey = k => SESSION_SCREENERS.find(x => x.key === k);

  test('both are valid and carry their session', () => {
    for (const d of SESSION_SCREENERS) expect(store.validateDefinition(d)).toEqual([]);
    expect(byKey('premarket-gap').runTo).toBe('09:30');
    expect(byKey('after-open-volume').runFrom).toBe('09:30');
  });

  test('names say what they look for, not where they came from', () => {
    for (const d of SESSION_SCREENERS) {
      expect(d.name).not.toMatch(/finviz|^FV /i);
      expect(d.key).not.toMatch(/^fv-/);
    }
  });

  test('"gap up or down 3%" is expressed as outside -3..3', () => {
    // TradingView has no absolute-value operator; "not between -3 and 3" is
    // exactly the same set as |gap| > 3.
    const gap = byKey('premarket-gap').filters.find(f => f.left === 'gap');
    expect(gap).toEqual({ left: 'gap', operation: 'not_in_range', right: [-3, 3] });
  });

  test('the pre-market screener carries ATR and average volume floors', () => {
    const f = byKey('premarket-gap').filters;
    expect(f).toContainEqual({ left: 'ATR', operation: 'egreater', right: 1 });
    expect(f).toContainEqual({ left: 'average_volume_90d_calc', operation: 'egreater', right: 2000000 });
  });

  test('the after-open screener uses volume measures that do not drift', () => {
    // This test used to assert the opposite — "current volume, not average" —
    // and the premise was wrong. `volume` is cumulative shares traded SO FAR
    // today: zero at the bell, largest at the close. A threshold on it is a
    // different condition every hour, so the screener filled up as the session
    // ran instead of finding heavy traders.
    const f = byKey('after-open-volume').filters;
    expect(f.some(x => x.left === 'volume')).toBe(false);
    expect(f.some(x => x.left === 'average_volume_10d_calc')).toBe(true);
    expect(f.some(x => x.left === 'relative_volume_intraday|5')).toBe(true);
    const floor = f.find(x => x.left === 'close');
    expect(Number(floor.right)).toBeGreaterThanOrEqual(5);
  });
});

describe('renaming the legacy vendor-named screeners', () => {
  const db = require('../src/db');
  const { renameLegacyScreeners } = require('../src/sideA/seedScreeners');

  beforeEach(() => db.prepare('DELETE FROM screeners').run());

  const seedOld = () => {
    store.create({ key: 'fv-premarket', name: 'FV Pre-Market', runFrom: '04:00', runTo: '09:30',
      filters: [{ left: 'gap', operation: 'not_in_range', right: [-3, 3] }] });
    store.create({ key: 'fv-after-open', name: 'FV After Open', runFrom: '09:30', runTo: '16:00',
      filters: [{ left: 'volume', operation: 'greater', right: 10000000 }] });
  };

  test('an already-running tool gets the new key and name', () => {
    seedOld();
    expect(renameLegacyScreeners().renamed).toBe(2);
    const keys = store.list().map(s => s.key).sort();
    expect(keys).toEqual(['after-open-volume', 'premarket-gap']);
    expect(store.list().map(s => s.name).sort())
      .toEqual(['After Open Volume', 'Pre-Market Gap']);
  });

  test('the filters and window are untouched — only the label changes', () => {
    seedOld();
    renameLegacyScreeners();
    const pm = store.list().find(s => s.key === 'premarket-gap');
    expect(pm.filters).toEqual([{ left: 'gap', operation: 'not_in_range', right: [-3, 3] }]);
    expect(pm.runFrom).toBe('04:00');
    expect(pm.runTo).toBe('09:30');
  });

  test('running it twice changes nothing the second time', () => {
    seedOld();
    renameLegacyScreeners();
    expect(renameLegacyScreeners().renamed).toBe(0);
    expect(store.list()).toHaveLength(2);
  });

  test('a screener the trader already built under the new key is not touched', () => {
    seedOld();
    store.create({ key: 'premarket-gap', name: 'My Pre-Market Gap',
      filters: [{ left: 'close', operation: 'greater', right: 5 }] });
    // create() de-duplicates keys, so force the collision the rename must survive
    db.prepare("UPDATE screeners SET key = 'premarket-gap' WHERE name = 'My Pre-Market Gap'").run();

    renameLegacyScreeners();
    const mine = store.list().find(s => s.name === 'My Pre-Market Gap');
    expect(mine.key).toBe('premarket-gap');
    expect(store.list().find(s => s.name === 'FV Pre-Market')).toBeTruthy();
    // the non-clashing one still renames
    expect(store.list().find(s => s.key === 'after-open-volume')).toBeTruthy();
  });
});

describe('mirroring a bounded oscillator', () => {
  test('RSI reflects about its range instead of flipping sign', () => {
    // "RSI above 70" mirrors to "RSI below 30". Flipping the operator alone
    // gives "below 70", which is most of the market; negating gives "above
    // -70", which is every stock that exists.
    const m = store.mirrorDefinition({
      name: 'Overbought', filters: [{ left: 'RSI', operation: 'greater', right: 70 }],
    });
    expect(m.filters[0]).toEqual({ left: 'RSI', operation: 'less', right: 30 });
  });

  test('a range reflects both ends and stays the right way round', () => {
    const m = store.mirrorDefinition({
      name: 'Mid', filters: [{ left: 'RSI', operation: 'greater', right: [60, 80] }],
    });
    expect(m.filters[0].right).toEqual([20, 40]);
  });

  test('the T6 pair really is overbought against oversold', () => {
    const { PRESETS } = require('../src/sideA/seedScreeners');
    const [base, mirror] = PRESETS.T6;
    const rsi = d => d.filters.find(f => f.left === 'RSI');
    expect(rsi(base)).toEqual({ left: 'RSI', operation: 'greater', right: 70 });
    expect(rsi(mirror)).toEqual({ left: 'RSI', operation: 'less', right: 30 });
    // and the mirror must not ask for both at once
    const ema = mirror.filters.find(f => f.right === 'EMA20');
    expect(ema.operation).toBe('eless');
  });
});

describe('repairing the stored oversold mirror', () => {
  const db = require('../src/db');
  const { repairOversoldMirror } = require('../src/sideA/seedScreeners');

  beforeEach(() => db.prepare('DELETE FROM screeners').run());

  const seedBroken = () => store.create({
    key: 'overextended-mirror', name: 'Overextended (mirror)',
    filters: [
      { left: 'RSI', operation: 'greater', right: 70 },
      { left: 'close', operation: 'eless', right: 'EMA20' },
      { left: 'relative_volume_10d_calc', operation: 'greater', right: 3 },
    ],
  });

  test('a tool already running gets the contradiction rewritten', () => {
    seedBroken();
    expect(repairOversoldMirror().repaired).toBe(1);
    const f = store.list()[0].filters;
    expect(f).toContainEqual({ left: 'RSI', operation: 'less', right: 30 });
    expect(f).not.toContainEqual({ left: 'RSI', operation: 'greater', right: 70 });
  });

  test('running it twice changes nothing the second time', () => {
    seedBroken();
    repairOversoldMirror();
    expect(repairOversoldMirror().repaired).toBe(0);
  });

  test('a screener the trader wrote themselves is left alone', () => {
    store.create({
      key: 'overextended-mirror', name: 'Mine',
      filters: [{ left: 'RSI', operation: 'less', right: 25 }],
    });
    expect(repairOversoldMirror().repaired).toBe(0);
    expect(store.list()[0].filters).toEqual([{ left: 'RSI', operation: 'less', right: 25 }]);
  });
});

describe('the after-open screener needs a move, not just volume', () => {
  const db = require('../src/db');
  const { tightenAfterOpenVolume, PRESETS: P } = require('../src/sideA/seedScreeners');

  beforeEach(() => db.prepare('DELETE FROM screeners').run());

  const seedLoose = () => store.create({
    key: 'after-open-volume', name: 'After Open Volume',
    runFrom: '09:30', runTo: '16:00',
    filters: [
      { left: 'relative_volume_10d_calc', operation: 'greater', right: 3 },
      { left: 'volume', operation: 'greater', right: 10000000 },
      { left: 'close', operation: 'greater', right: 1 },
    ],
  });

  test('the shipped screener now requires a real move', () => {
    // Its pre-market twin has always demanded a 3% gap; asking only for volume
    // returned a hundred large liquid names that were going nowhere.
    const f = P.T7.find(d => d.key === 'after-open-volume').filters;
    expect(f).toContainEqual({ left: 'change', operation: 'not_in_range', right: [-3, 3] });
  });

  test('direction-agnostic, like the gap rule it mirrors', () => {
    const pm = P.T7.find(d => d.key === 'premarket-gap').filters.find(f => f.left === 'gap');
    const ao = P.T7.find(d => d.key === 'after-open-volume').filters.find(f => f.left === 'change');
    expect(ao.operation).toBe(pm.operation);
    expect(ao.right).toEqual(pm.right);
  });

  test('a tool already running is tightened in place', () => {
    seedLoose();
    expect(tightenAfterOpenVolume().tightened).toBe(1);
    const f = store.list()[0].filters;
    expect(f.some(x => x.left === 'change')).toBe(true);
    // The relative-volume rule this once asserted was day-to-date and drifted
    // with the clock; it is gone rather than retuned. See the Liquid Movers
    // suite, which owns that reasoning.
    expect(f.some(x => x.left === 'relative_volume_10d_calc')).toBe(false);
  });

  test('running it twice changes nothing the second time', () => {
    seedLoose();
    tightenAfterOpenVolume();
    expect(tightenAfterOpenVolume().tightened).toBe(0);
  });

  test('a screener the trader has already edited is left alone', () => {
    store.create({
      key: 'after-open-volume', name: 'After Open Volume',
      filters: [{ left: 'relative_volume_10d_calc', operation: 'greater', right: 8 }],
    });
    expect(tightenAfterOpenVolume().tightened).toBe(0);
    expect(store.list()[0].filters).toHaveLength(1);
  });
});

describe('a mirror stays paired after being renamed', () => {
  const db = require('../src/db');
  const { backfillMirrorLinks } = require('../src/sideA/seedScreeners');

  beforeEach(() => db.prepare('DELETE FROM screeners').run());

  test('createMirror records what it mirrors', () => {
    const base = store.create({ name: 'Stack Up', filters: [{ left: 'RSI', operation: 'greater', right: 70 }] });
    const m = store.createMirror(base.id);
    expect(m.mirrorOf).toBe('Stack Up');
  });

  test('renaming the mirror does not break the link', () => {
    // The real case: the trader renamed "MA Stack Breakout (mirror)" to
    // "MA Stack Pullback", and name-based pairing lost it silently — the whole
    // directional comparison went missing for that tool with no error anywhere.
    const base = store.create({ name: 'MA Stack Breakout', filters: [{ left: 'RSI', operation: 'greater', right: 70 }] });
    const m = store.createMirror(base.id);
    const renamed = store.update(m.id, { name: 'MA Stack Pullback' });
    expect(renamed.name).toBe('MA Stack Pullback');
    expect(renamed.mirrorOf).toBe('MA Stack Breakout');
  });

  test('renaming the BASE leaves a stale link, and says so honestly', () => {
    // Recorded by name, so renaming the base does break it. Worth knowing:
    // the pair simply stops being reported rather than reporting nonsense.
    const base = store.create({ name: 'Old Name', filters: [{ left: 'RSI', operation: 'greater', right: 70 }] });
    const m = store.createMirror(base.id);
    store.update(base.id, { name: 'New Name' });
    expect(store.get(m.id).mirrorOf).toBe('Old Name');
    expect(store.list().some(s => s.name === 'Old Name')).toBe(false);
  });

  test('the link can be set and cleared by hand', () => {
    const a = store.create({ name: 'A', filters: [{ left: 'RSI', operation: 'greater', right: 70 }] });
    const b = store.create({ name: 'B', filters: [{ left: 'RSI', operation: 'less', right: 30 }] });
    expect(store.update(b.id, { mirrorOf: 'A' }).mirrorOf).toBe('A');
    expect(store.update(b.id, { mirrorOf: null }).mirrorOf).toBeNull();
  });

  test('an unrelated update leaves the link alone', () => {
    const a = store.create({ name: 'A', filters: [{ left: 'RSI', operation: 'greater', right: 70 }] });
    const b = store.create({ name: 'B', mirrorOf: 'A', filters: [{ left: 'RSI', operation: 'less', right: 30 }] });
    expect(store.update(b.id, { enabled: false }).mirrorOf).toBe('A');
  });

  test('old pairs made before the link existed are recovered by name', () => {
    store.create({ name: 'Alpha', filters: [{ left: 'RSI', operation: 'greater', right: 70 }] });
    store.create({ name: 'Alpha (mirror)', filters: [{ left: 'RSI', operation: 'less', right: 30 }] });
    expect(backfillMirrorLinks().linked).toBe(1);
    expect(store.list().find(s => s.name === 'Alpha (mirror)').mirrorOf).toBe('Alpha');
  });

  test('the backfill does not invent a link where the base is gone', () => {
    store.create({ name: 'Orphan (mirror)', filters: [{ left: 'RSI', operation: 'less', right: 30 }] });
    expect(backfillMirrorLinks().linked).toBe(0);
    expect(store.list()[0].mirrorOf).toBeNull();
  });
});
