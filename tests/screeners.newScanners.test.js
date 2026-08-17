/*
 * Two tools got a new scanner, and the old one had to survive the swap.
 *
 * T5 looked for a 52-week break. That is a once-a-month event — the archive
 * holds ONE frozen day for it — and a screener that fires once a month cannot
 * be measured against anything. It now breaks the 20-day range instead.
 *
 * T6 looked for overbought-with-volume, which is what four other tools already
 * find. It now looks for a big quick move with NO news behind it, expected to
 * correct back — the only mean-reversion setup on the desk.
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

// ── T6 · the unexplained move ──────────────────────────────────────────────

/*
 * A big quick move with NO reason behind it, expected to correct back. The
 * only mean-reversion setup on the desk; everything else here wants a move to
 * continue.
 *
 * Written the other way round first — as a consolidation screener, with the
 * 15% move as an EXCLUSION — which is the opposite setup entirely. The move is
 * the trigger.
 */
describe('T6 — Unexplained Move', () => {
  const t6 = byName(PRESETS.T6);
  const base = t6['Unexplained Move'];
  const mirror = t6['Unexplained Move (mirror)'];

  test('the tool ships the pair, and keeps the old screener switched off', () => {
    expect(Object.keys(t6).sort())
      .toEqual(['Overextended (archived)', 'Unexplained Move', 'Unexplained Move (mirror)']);
  });

  test('THE 15% MOVE IS THE TRIGGER, not something to avoid', () => {
    expect(filterOn(base, 'change|120'))
      .toEqual([{ left: 'change|120', operation: 'greater', right: 15 }]);
    expect(filterOn(mirror, 'change|120'))
      .toEqual([{ left: 'change|120', operation: 'less', right: -15 }]);
  });

  /*
   * The safety layer, and it faces the OPPOSITE way to the move. A stock that
   * has fallen for six months and falls again today has not done anything
   * unexplained — it is doing what it has been doing, and buying that dip is
   * catching a knife. So each side refuses a spike that AGREES with the trend.
   */
  test('each side refuses a spike that agrees with the six-month trend', () => {
    // spiked UP -> only worth fading if six months are NOT clearly rising
    expect(filterOn(base, 'Perf.6M'))
      .toEqual([{ left: 'Perf.6M', operation: 'less', right: 20 }]);
    // dropped -> only worth buying if six months are NOT clearly falling
    expect(filterOn(mirror, 'Perf.6M'))
      .toEqual([{ left: 'Perf.6M', operation: 'greater', right: -20 }]);
  });

  /*
   * "NOT CLEARLY RISING" IS NOT "FLAT", and the difference is most of the
   * setup. Written as `< 0` first, which demands a stock that has actually
   * fallen — a name up 6% over six months has gone nowhere, and refusing to
   * fade its unexplained spike because it is fractionally positive throws away
   * the bulk of the population.
   */
  test('the boundary is a BAND, not zero — drift is allowed on both sides', () => {
    const band = filterOn(base, 'Perf.6M')[0].right;
    expect(band).toBeGreaterThan(0);
    expect(filterOn(mirror, 'Perf.6M')[0].right).toBe(-band);
  });

  /*
   * The only screener here with no average-volume floor, and not by oversight:
   * a stock nobody trades is exactly the population where a 15% move happens
   * for no reason and then reverses, because there was nobody there to move it.
   * Requiring the liquidity removes the setup along with the risk.
   */
  test('NO average-volume floor — neglected is the point', () => {
    expect(filterOn(base, 'average_volume_10d_calc')).toEqual([]);
    expect(filterOn(mirror, 'average_volume_10d_calc')).toEqual([]);
    // every other screener on these two tools still has one
    expect(filterOn(byName(PRESETS.T5)['20-Day Break'], 'average_volume_10d_calc'))
      .toHaveLength(1);
  });

  test('the price floor stays — a spread on a 30c stock eats the move', () => {
    expect(filterOn(base, 'close'))
      .toContainEqual({ left: 'close', operation: 'egreater', right: 1 });
  });

  /*
   * …and the same exemption on the tradability floor, or it would be granted
   * in the screener and taken back by the floor that rides along with it.
   */
  test('and it is exempt from the liquidity half of the tradability floor', () => {
    const { NEGLECTED_KEYS } = require('../src/sideA/seedScreeners');
    expect(NEGLECTED_KEYS.has('unexplained-move')).toBe(true);
    expect(NEGLECTED_KEYS.has('unexplained-move-mirror')).toBe(true);
    const tradable = require('../src/sideA/tradable');
    const t = { minPrice: 1, minAvgVolume: 1e6, minAtr: 1, minAtrPct: 3 };
    const cols = f => f.map(x => x.left);
    expect(cols(tradable.serverFilters(t))).toEqual(
      ['close', 'average_volume_10d_calc', 'ATR']);
    expect(cols(tradable.serverFilters(t, { liquidity: false }))).toEqual(['close']);
    // and the local ATR-percent leg is exempt too, or the server exemption
    // would simply be undone afterwards
    const thin = [{ ticker: 'X', stock: { atr: 0.01, price: 10 } }];
    expect(tradable.applyLocal(thin, t).kept).toHaveLength(0);
    expect(tradable.applyLocal(thin, t, { liquidity: false }).kept).toHaveLength(1);
  });

  test('and Perf.6M is registered as directional, like its four siblings', () => {
    const m = store.mirrorDefinition({
      name: 'x', filters: [{ left: 'Perf.6M', operation: 'less', right: -20 }],
    });
    expect(m.filters[0]).toEqual({ left: 'Perf.6M', operation: 'greater', right: 20 });
  });

  /* The biggest unexplained move should be at the top of each list, which for
     the down side means ascending. */
  test('each side sorts its own strongest candidates first', () => {
    expect(base.sort).toEqual({ sortBy: 'change|120', sortOrder: 'desc' });
    expect(mirror.sort).toEqual({ sortBy: 'change|120', sortOrder: 'asc' });
  });

  /* `change|120` does not exist until there have been two hours of session. */
  test('it cannot run before 11:30, because its own input does not exist yet', () => {
    expect(base.runFrom).toBe('11:30');
    expect(mirror.runFrom).toBe('11:30');
  });

  /*
   * No RSI, no EMA20, no "already extended" condition. Those describe a move
   * that has gone far, which is what the archived screener looked for and what
   * four other tools already find. This one is about a move with no CAUSE.
   */
  test('nothing here asks whether the move was large by any other measure', () => {
    for (const f of base.filters) expect(['RSI', 'EMA20']).not.toContain(f.left);
  });

  test('the overextended version is kept, and switched off', () => {
    const old = t6['Overextended (archived)'];
    expect(old.enabled).toBe(false);
    expect(old.key).toBe('overextended');
    expect(filterOn(old, 'RSI')).toHaveLength(1);
  });
});

/*
 * THE HALF THAT IS NOT IN THE SCREENER.
 *
 * TradingView has no news column, so "with no news" is a card filter applied
 * after the screener — and it could not be written at all until now: every
 * operator treated a missing field as "cannot tell", and an unknown rule drops
 * the card. The cards with no catalyst were exactly the ones being dropped, so
 * the filter removed the whole list it was written to find.
 */
describe('no news / with news, as a card filter', () => {
  const universe = require('../src/setups/universe');
  const ROWS = [
    { ticker: 'NEWS', catalyst: 'FDA approval' },
    { ticker: 'NONE', catalyst: null },
    { ticker: 'ABSENT' },
  ];
  const filter = op => ({ rules: [{ left: 'catalyst', operator: op, right: '' }] });

  test('"is empty" keeps the cards with nothing behind the move — T6', () => {
    expect(universe.apply(ROWS, filter('empty')).kept.map(r => r.ticker))
      .toEqual(['NONE', 'ABSENT']);
  });

  test('"has any value" keeps the ones with a catalyst — T5', () => {
    expect(universe.apply(ROWS, filter('notempty')).kept.map(r => r.ticker))
      .toEqual(['NEWS']);
  });

  test('a missing field is a VALUE to these two, not an unknown', () => {
    // Any other operator drops all three, which is the behaviour that made
    // "no news" impossible to ask for.
    expect(universe.apply(ROWS, { rules: [{ left: 'catalyst', operator: 'eq', right: '' }] })
      .kept.map(r => r.ticker)).toEqual([]);
  });

  test('both operators are offered to whoever is building the filter', () => {
    const ops = universe.OPERATORS.map(o => o.value);
    expect(ops).toContain('empty');
    expect(ops).toContain('notempty');
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
