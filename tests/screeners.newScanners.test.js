/*
 * Two tools got a new scanner, and the old one had to survive the swap.
 *
 * T5 looked for a 52-week break. That is a once-a-month event — the archive
 * holds ONE frozen day for it — and a screener that fires once a month cannot
 * be measured against anything. It now breaks the 20-day range instead.
 *
 * T6 looked for overbought-with-volume, which is what four other tools already
 * find. It now looks for the opposite: a neglected name that has NOT moved,
 * whose six-month trend is going nowhere, with volume arriving anyway.
 *
 * Two things must hold, and neither is obvious:
 *
 *   1. THE OLD DEFINITION IS NOT DELETED. Its frozen register days are stored
 *      under its key, and deleting the row leaves a month of archived
 *      candidates with nothing to say what produced them.
 *   2. THE MIRROR IS THE OPPOSITE SETUP, not the same one with an operator
 *      flipped. `Perf.6M` was missing from DIRECTIONAL_FIELDS while its four
 *      siblings were there, so the twin of "six-month trend not rising" came
 *      out as "six-month trend not rising" — the pair tested one side twice.
 */

const os = require('os');
const path = require('path');

process.env.DB_PATH = path.join(os.tmpdir(), `newscan-${process.pid}.db`);

const store = require('../src/sideA/screenerStore');
const { PRESETS } = require('../src/sideA/seedScreeners');

afterAll(() => {
  try { require('fs').unlinkSync(process.env.DB_PATH); } catch { /* gone */ }
});

const byName = defs => Object.fromEntries(defs.map(d => [d.name, d]));
const filterOn = (def, left) => (def.filters || []).filter(f => f.left === left);

// ── T5 · the 20-day break ──────────────────────────────────────────────────

describe('T5 — 20-Day Break', () => {
  const t5 = byName(PRESETS.T5);

  test('the tool now ships a 20-day break and its mirror', () => {
    expect(Object.keys(t5).sort())
      .toEqual(['20-Day Break', '20-Day Break (mirror)', '52-Week Break (archived)']);
  });

  test('the base breaks the MONTH high — 1M is about 20 trading days', () => {
    expect(filterOn(t5['20-Day Break'], 'close'))
      .toContainEqual({ left: 'close', operation: 'egreater', right: 'High.1M' });
  });

  /*
   * The mirror of "above the 20-day high" is "below the 20-day LOW". Flipping
   * only the operator gives "below the 20-day high", which is true of nearly
   * every stock and screens for nothing — the exact failure FIELD_MIRROR was
   * written for.
   */
  test('the mirror is a SUPPORT break, not "below the high"', () => {
    expect(filterOn(t5['20-Day Break (mirror)'], 'close'))
      .toContainEqual({ left: 'close', operation: 'eless', right: 'Low.1M' });
    expect(JSON.stringify(t5['20-Day Break (mirror)'].filters))
      .not.toContain('"eless","right":"High.1M"');
  });

  test('the 52-week version is kept, and switched off', () => {
    const old = t5['52-Week Break (archived)'];
    expect(old.enabled).toBe(false);
    expect(old.key).toBe('52w-break');          // the key its frozen days are under
    expect(filterOn(old, 'close'))
      .toContainEqual({ left: 'close', operation: 'egreater', right: 'price_52_week_high' });
  });

  /*
   * The billion-dollar floor belonged to the 52-week horizon: it kept a
   * 52-week high meaningful on an established name. At 20 days it excludes
   * most of what this desk trades.
   */
  test('the market-cap floor went with the 52-week horizon', () => {
    expect(filterOn(t5['20-Day Break'], 'market_cap_basic')).toEqual([]);
    expect(filterOn(t5['52-Week Break (archived)'], 'market_cap_basic')).toHaveLength(1);
  });
});

// ── T6 · the quiet base ────────────────────────────────────────────────────

describe('T6 — Quiet Base', () => {
  const t6 = byName(PRESETS.T6);
  const base = t6['Quiet Base'];
  const mirror = t6['Quiet Base (mirror)'];

  test('the tool now ships a quiet base and its mirror', () => {
    expect(Object.keys(t6).sort())
      .toEqual(['Overextended (archived)', 'Quiet Base', 'Quiet Base (mirror)']);
  });

  test('no two-hour swing beyond 15% in EITHER direction', () => {
    expect(filterOn(base, 'change|120')).toEqual([
      { left: 'change|120', operation: 'less', right: 15 },
      { left: 'change|120', operation: 'greater', right: -15 },
    ]);
  });

  /*
   * Quiet has no direction, so the band mirrors onto itself — the same two
   * bounds, written the other way round. That is correct, and it is the reason
   * the pair needs something else to actually differ.
   */
  test('the quiet band is self-mirroring, because quiet has no side', () => {
    const b = filterOn(base, 'change|120').map(f => `${f.operation} ${f.right}`).sort();
    const m = filterOn(mirror, 'change|120').map(f => `${f.operation} ${f.right}`).sort();
    expect(m).toEqual(b);
  });

  /*
   * …and this is what differs. Base: six months not rising — accumulation into
   * weakness. Mirror: six months not falling — distribution into strength.
   * Without Perf.6M in DIRECTIONAL_FIELDS both said "less than 0" and the pair
   * was one screener run twice.
   */
  test('THE PAIR DIFFERS ON THE SIX-MONTH TREND', () => {
    expect(filterOn(base, 'Perf.6M'))
      .toEqual([{ left: 'Perf.6M', operation: 'less', right: 0 }]);
    expect(filterOn(mirror, 'Perf.6M'))
      .toEqual([{ left: 'Perf.6M', operation: 'greater', right: 0 }]);
  });

  test('and Perf.6M is registered as directional, like its four siblings', () => {
    const m = store.mirrorDefinition({
      name: 'x', filters: [{ left: 'Perf.6M', operation: 'less', right: -20 }],
    });
    expect(m.filters[0]).toEqual({ left: 'Perf.6M', operation: 'greater', right: 20 });
  });

  test('still inside its range — breaking out is the other tool\'s job', () => {
    expect(filterOn(base, 'close'))
      .toContainEqual({ left: 'close', operation: 'less', right: 'High.1M' });
    expect(filterOn(mirror, 'close'))
      .toContainEqual({ left: 'close', operation: 'greater', right: 'Low.1M' });
  });

  /*
   * The one thing that IS happening. Everything above says nothing is going on;
   * without this the screener returns the entire quiet half of the market.
   */
  test('volume is arriving anyway — the whole setup', () => {
    expect(filterOn(base, 'relative_volume_10d_calc'))
      .toEqual([{ left: 'relative_volume_10d_calc', operation: 'greater', right: 1.5 }]);
  });

  /*
   * 3x on a neglected name is not accumulation, it is the news already
   * breaking — and by then the base is over. The archived screener used 3.
   */
  test('the volume floor is lower than the old screener\'s', () => {
    expect(filterOn(base, 'relative_volume_10d_calc')[0].right)
      .toBeLessThan(filterOn(t6['Overextended (archived)'], 'relative_volume_10d_calc')[0].right);
  });

  /* `change|120` does not exist until there have been two hours of session. */
  test('it cannot run before 11:30, because its own input does not exist yet', () => {
    expect(base.runFrom).toBe('11:30');
  });

  test('the overextended version is kept, and switched off', () => {
    const old = t6['Overextended (archived)'];
    expect(old.enabled).toBe(false);
    expect(old.key).toBe('overextended');
    expect(filterOn(old, 'RSI')).toHaveLength(1);
  });
});

// ── every definition is still a legal screener ─────────────────────────────

describe('the new columns are ones the store accepts', () => {
  for (const tool of ['T5', 'T6']) {
    for (const def of PRESETS[tool]) {
      test(`${def.name} validates`, () => {
        expect(store.validateDefinition(def)).toEqual([]);
      });
    }
  }
});
