/*
 * Each tool's schedule, and the line between discovery and refresh.
 *
 * Two rules hold this together:
 *
 *  1. A window gates DISCOVERY only. A screener going to sleep must stop adding
 *     candidates without freezing the cards it already found — the trader is
 *     still watching those at 15:00.
 *  2. T1 keeps running all day. Its Pre-Mkt tag at 09:36 is what the one
 *     measured edge is read off; a window would delete the measurement.
 */

const store = require('../src/sideA/screenerStore');
const { PRESETS } = require('../src/sideA/seedScreeners');

const at = (h, m) => {
  // toETTime reads the wall clock in New York, so build the instant from a
  // fixed UTC point and let the store do the conversion.
  const d = new Date(Date.UTC(2026, 6, 30, h + 4, m));   // ET = UTC-4 in July
  return d.getTime();
};

const win = (tool, key) => {
  const d = PRESETS[tool].find(x => (x.key || '') === key);
  if (!d) throw new Error(`no screener "${key}" in ${tool}`);
  return d;
};

describe('T1 stays the control', () => {
  test('none of its screeners has a window', () => {
    for (const d of PRESETS.T1) {
      expect(d.runFrom == null || d.runFrom === '').toBe(true);
      expect(d.runTo == null || d.runTo === '').toBe(true);
    }
  });

  test('Pre-Mkt is still live in the 09:30–09:36 scans that feed r1', () => {
    // This is the specific thing a window would break: r1 freezes at 09:36, and
    // the Big Move + Pre-Mkt overlap is read off those frozen rows.
    const pre = win('T1', 'premarket');
    expect(store.isActiveAt(pre, at(9, 31))).toBe(true);
    expect(store.isActiveAt(pre, at(9, 35))).toBe(true);
  });
});

describe('every other tool carries a window', () => {
  for (const id of ['T2', 'T3', 'T4', 'T5', 'T6', 'T7']) {
    test(`${id}`, () => {
      for (const d of PRESETS[id]) {
        expect(d.runFrom).toMatch(/^\d\d:\d\d$/);
        expect(d.runTo).toMatch(/^\d\d:\d\d$/);
        expect(store.validateDefinition(d)).toEqual([]);
      }
    });
  }

  test('a mirror runs in the same window as its base, or the pair cannot be compared', () => {
    for (const id of ['T2', 'T3', 'T4', 'T5', 'T6']) {
      const [base, mirror] = PRESETS[id];
      expect(mirror.runFrom).toBe(base.runFrom);
      expect(mirror.runTo).toBe(base.runTo);
    }
  });
});

describe('the windows match what each tool is for', () => {
  test('T3 gappers stop once premarket_change is yesterday news', () => {
    const gap = win('T3', 'gap-and-volume');
    expect(store.isActiveAt(gap, at(7, 0))).toBe(true);     // pre-market
    expect(store.isActiveAt(gap, at(10, 0))).toBe(true);    // the first hour
    expect(store.isActiveAt(gap, at(13, 0))).toBe(false);   // stale by now
  });

  test('T4 VWAP reclaim is the one that stays awake into the afternoon', () => {
    // The trader's own example: a "move then reverse" setup is still tradable
    // after 13:00, so this window has to cover it.
    const v = win('T4', 'vwap-reclaim');
    expect(store.isActiveAt(v, at(9, 35))).toBe(false);     // VWAP not a level yet
    expect(store.isActiveAt(v, at(13, 30))).toBe(true);
    expect(store.isActiveAt(v, at(14, 30))).toBe(true);
    expect(store.isActiveAt(v, at(15, 45))).toBe(false);    // no session left
  });

  test('T6 waits for the session to build the extension it fades', () => {
    const o = win('T6', 'overextended');
    expect(store.isActiveAt(o, at(9, 45))).toBe(false);     // RSI still yesterday's
    expect(store.isActiveAt(o, at(11, 0))).toBe(true);
    expect(store.isActiveAt(o, at(15, 50))).toBe(true);
  });

  test('T2 breakouts need the regular session and not the closing hour', () => {
    const b = win('T2', 'ma-stack-breakout');
    expect(store.isActiveAt(b, at(8, 0))).toBe(false);
    expect(store.isActiveAt(b, at(11, 0))).toBe(true);
    expect(store.isActiveAt(b, at(15, 30))).toBe(false);
  });

  test('T5 takes the whole regular session but no pre-market', () => {
    const f = win('T5', '52w-break');
    expect(store.isActiveAt(f, at(8, 0))).toBe(false);
    expect(store.isActiveAt(f, at(15, 55))).toBe(true);
  });

  test("T7's two sessions do not overlap, so a stock lands in one or the other", () => {
    const [pm, ao] = PRESETS.T7;
    expect(store.isActiveAt(pm, at(8, 0))).toBe(true);
    expect(store.isActiveAt(ao, at(8, 0))).toBe(false);
    expect(store.isActiveAt(pm, at(11, 0))).toBe(false);
    expect(store.isActiveAt(ao, at(11, 0))).toBe(true);
  });
});

describe('every tool can actually train', () => {
  // r1 is the only snapshot the model learns from. A tool whose screeners are
  // all asleep when r1 fires freezes an empty register every day and never
  // builds a model — which is exactly what a fixed 09:36 did to the tools that
  // hunt later in the session. Each tool's capture time has to sit inside its
  // own windows.
  const registry = require('../tools.config.json').tools;
  const capOf = id => registry.find(t => t.id === id).captureAt;

  for (const [id, defs] of Object.entries(PRESETS)) {
    test(`${id}: a screener is awake when r1 freezes`, () => {
      const { r1 } = capOf(id);
      const [h, m] = r1.split(':').map(Number);
      const awake = defs.filter(d => store.isActiveAt(d, at(h, m))).map(d => d.name);
      expect({ id, r1, awake: awake.length > 0 }).toEqual({ id, r1, awake: true });
    });
  }

  test('entries come after the snapshot, never before', () => {
    for (const t of registry) {
      const c = t.captureAt;
      expect({ id: t.id, ok: c.r1 < c.entryA && c.entryA < c.entryB })
        .toEqual({ id: t.id, ok: true });
    }
  });

  test('T1 keeps the original capture times, so its history stays comparable', () => {
    const { r1, entryA, entryB } = capOf('T1');
    expect({ r1, entryA, entryB }).toEqual({ r1: '09:36', entryA: '09:37', entryB: '09:40' });
  });

  test('every tool states why its times were chosen', () => {
    // A time with no stated reason is a number the trader has to take on trust.
    for (const t of registry) {
      expect({ id: t.id, hasWhy: typeof t.captureAt.why === 'string' && t.captureAt.why.length > 40 })
        .toEqual({ id: t.id, hasWhy: true });
    }
  });

  test('r1 lands one minute after a discovery scan, never on top of one', () => {
    // T1's proven shape: the 09:35 scan fills r0, then 09:36 freezes it.
    // Firing r1 on the same minute as a scan would freeze the PREVIOUS scan's
    // registry — up to fifteen minutes stale in the session hours.
    const isTick = (h, m) => {
      if (h >= 4 && h <= 8) return m % 30 === 0;
      if (h === 9) return m % 5 === 0;
      if (h >= 10 && h <= 15) return m % 15 === 0;
      if (h === 16) return m === 0;
      return false;
    };
    for (const t of registry) {
      const [h, m] = t.captureAt.r1.split(':').map(Number);
      const prev = h * 60 + m - 1;
      expect({ id: t.id, r1: t.captureAt.r1, afterScan: isTick(Math.floor(prev / 60), prev % 60) })
        .toEqual({ id: t.id, r1: t.captureAt.r1, afterScan: true });
    }
  });

  test('every entry time falls inside the regular session', () => {
    for (const t of registry) {
      const { entryA, entryB } = t.captureAt;
      expect({ id: t.id, ok: entryA >= '09:30' && entryB <= '16:00' })
        .toEqual({ id: t.id, ok: true });
    }
  });
});

describe('the tool explains its own schedule', () => {
  const { WINDOW_NOTES, PRESETS: P } = require('../src/sideA/seedScreeners');
  const store2 = require('../src/sideA/screenerStore');

  test('every seeded screener, mirrors included, states why it runs when it does', () => {
    for (const [id, defs] of Object.entries(P)) {
      for (const d of defs) {
        const key = store2.slugify(d.key || d.name);
        expect({ id, key, explained: typeof WINDOW_NOTES[key] === 'string' })
          .toEqual({ id, key, explained: true });
      }
    }
  });

  test('a screener the trader builds has no canned reason — they chose it', () => {
    expect(WINDOW_NOTES['something-i-made-up']).toBeUndefined();
  });
});

describe('T9 is the benchmark', () => {
  const registry = require('../tools.config.json').tools;
  const t9 = PRESETS.T9;

  test('one screener, one rule of its own — the rest is the floor', () => {
    expect(t9).toHaveLength(1);
    expect(t9[0].filters).toEqual([{ left: 'close', operation: 'greater', right: 5 }]);
  });

  test('ranked by relative volume, top 20 — that is the whole method', () => {
    expect(t9[0].sort).toEqual({ sortBy: 'relative_volume_10d_calc', sortOrder: 'desc' });
    expect(t9[0].limit).toBe(20);
  });

  test('no mirror: "unusually active" has no opposite side', () => {
    expect(t9[0].name).not.toMatch(/mirror/i);
    expect(t9.some(d => /mirror/i.test(d.name))).toBe(false);
  });

  test('it carries no structural filter, or it would stop being a benchmark', () => {
    // The moment this screener says anything about direction, pattern or trend,
    // it becomes another clever tool and there is nothing plain left to compare
    // the clever ones against.
    const structural = /EMA|SMA|VWAP|High\.|Low\.|RSI|52_week|crosses|premarket_change|gap/i;
    for (const f of t9[0].filters) {
      expect({ rule: f.left, structural: structural.test(f.left) || structural.test(String(f.right)) })
        .toEqual({ rule: f.left, structural: false });
    }
  });

  test('it is measured at the same moment as the tools it benchmarks', () => {
    // A different capture time would make every comparison partly a comparison
    // of clocks rather than of screeners.
    const cap = id => registry.find(t => t.id === id).captureAt;
    const { r1, entryA, entryB } = cap('T9');
    expect({ r1, entryA, entryB }).toEqual({
      r1: cap('T1').r1, entryA: cap('T1').entryA, entryB: cap('T1').entryB,
    });
  });

  test('it sees the whole regular session, like the tools it is compared to', () => {
    expect(t9[0].runFrom).toBe('09:30');
    expect(t9[0].runTo).toBe('16:00');
  });
});
