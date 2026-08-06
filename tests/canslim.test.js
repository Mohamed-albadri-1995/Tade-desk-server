/*
 * CANSLIM membership, and the one place tools are allowed to see each other.
 *
 * The rule that must hold: the shared list is a LABEL, never a filter. A tool
 * reading it can tag its own candidates; it can never gain or lose a candidate
 * because of what another tool found.
 */

const os = require('os');
const path = require('path');
const fs = require('fs');

const FILE = path.join(os.tmpdir(), `canslim-test-${process.pid}.json`);
process.env.CANSLIM_FILE = FILE;

const canslim = require('../src/sideA/canslim');
const { PRESETS } = require('../src/sideA/seedScreeners');
const store = require('../src/sideA/screenerStore');

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date(2026, 6, 31).getTime();

beforeEach(() => { try { fs.unlinkSync(FILE); } catch { /* absent */ } });
afterAll(() => { try { fs.unlinkSync(FILE); } catch { /* absent */ } });

describe('membership', () => {
  test('a match is recorded and stays a member', () => {
    canslim.recordMembers(['NVDA', 'AVGO'], NOW);
    const m = canslim.currentMembers(NOW);
    expect([...m.keys()].sort()).toEqual(['AVGO', 'NVDA']);
  });

  test('tickers are matched case-insensitively', () => {
    canslim.recordMembers(['nvda'], NOW);
    expect(canslim.currentMembers(NOW).has('NVDA')).toBe(true);
  });

  test('membership lasts three months from the last confirmation', () => {
    // "If it passes CANSLIM its candidates are valuable for at least 3 months."
    canslim.recordMembers(['NVDA'], NOW);
    expect(canslim.currentMembers(NOW + 89 * DAY).has('NVDA')).toBe(true);
    expect(canslim.currentMembers(NOW + 91 * DAY).has('NVDA')).toBe(false);
  });

  test('re-qualifying extends the membership without resetting its age', () => {
    canslim.recordMembers(['NVDA'], NOW);
    canslim.recordMembers(['NVDA'], NOW + 60 * DAY);
    const m = canslim.currentMembers(NOW + 140 * DAY);
    expect(m.has('NVDA')).toBe(true);              // 80 days since confirmation
    expect(m.get('NVDA').firstSeen).toBe(NOW);     // age is not reset
    expect(m.get('NVDA').confirmations).toBe(2);
  });

  test('a name that stops qualifying is dropped on the next write', () => {
    canslim.recordMembers(['OLD'], NOW);
    const res = canslim.recordMembers(['NEW'], NOW + 100 * DAY);
    expect(res.expired).toBe(1);
    expect(canslim.currentMembers(NOW + 100 * DAY).has('OLD')).toBe(false);
  });
});

describe('tagging', () => {
  test('a member is tagged with how long it has held its place', () => {
    canslim.recordMembers(['NVDA'], NOW);
    const rows = [{ ticker: 'NVDA' }, { ticker: 'TSLA' }];
    canslim.tagRows(rows, NOW + 45 * DAY);
    expect(rows[0].canslim).toBe('yes');
    expect(rows[0].canslimDays).toBe(45);
    expect(rows[1].canslim).toBe('no');
    expect(rows[1].canslimDays).toBeNull();
  });

  test('every row gets the field, so the model never sees it as missing', () => {
    const rows = [{ ticker: 'AAA' }];
    canslim.tagRows(rows, NOW);
    expect(rows[0]).toHaveProperty('canslim', 'no');
  });

  test('tagging never adds or removes a row', () => {
    canslim.recordMembers(['NVDA'], NOW);
    const rows = [{ ticker: 'NVDA' }, { ticker: 'TSLA' }, { ticker: 'AMD' }];
    const { rows: out } = canslim.tagRows(rows, NOW);
    expect(out).toHaveLength(3);
    expect(out.map(r => r.ticker)).toEqual(['NVDA', 'TSLA', 'AMD']);
  });

  test('no list at all means no tags, not a failure', () => {
    // A tool started before T8 has ever run must scan normally.
    const rows = [{ ticker: 'NVDA' }];
    expect(() => canslim.tagRows(rows, NOW)).not.toThrow();
    expect(rows[0].canslim).toBe('no');
  });

  test('a corrupt list means no tags, not a failed scan', () => {
    fs.writeFileSync(FILE, '{ this is not json');
    const rows = [{ ticker: 'NVDA' }];
    expect(() => canslim.tagRows(rows, NOW)).not.toThrow();
    expect(rows[0].canslim).toBe('no');
  });
});

describe('the CANSLIM screeners', () => {
  test('T8 ships the universe, the breakout and the pullback, all valid', () => {
    expect(PRESETS.T8.map(d => d.name))
      .toEqual(['CANSLIM Universe', 'CANSLIM', 'CANSLIM Pullback']);
    for (const d of PRESETS.T8) expect(store.validateDefinition(d)).toEqual([]);
  });

  test('every letter that can be expressed is present', () => {
    const f = PRESETS.T8.find(d => d.key === 'canslim').filters;
    const has = left => f.some(x => x.left === left);
    expect(has('earnings_per_share_diluted_yoy_growth_fq')).toBe(true);   // C
    expect(has('earnings_per_share_diluted_yoy_growth_fy')).toBe(true);   // A
    expect(has('price_52_week_high')
      || f.some(x => x.right === 'price_52_week_high')).toBe(true);       // N
    expect(has('relative_volume_10d_calc')).toBe(true);                   // S
    expect(has('total_shares_outstanding_fundamental')).toBe(true);       // S
    expect(has('Perf.6M')).toBe(true);                                    // L
  });

  test('market direction is NOT a filter — it is context on the card', () => {
    // Filtering on the regime would hide candidates on weak days, which are
    // exactly the days worth recording for the comparison afterwards.
    for (const d of PRESETS.T8) {
      expect(d.filters.some(x => /regime|market_direction/i.test(x.left))).toBe(false);
    }
  });

  test('the fundamental fields are ones the builder knows, or they would be dropped', () => {
    // TradingView ignores unknown columns rather than erroring, so a field the
    // store does not know is a filter that silently would not apply.
    for (const d of PRESETS.T8) {
      for (const f of d.filters) {
        expect({ field: f.left, known: store.isKnownField(f.left) })
          .toEqual({ field: f.left, known: true });
      }
    }
  });
});

/*
 * Who is a growth stock, versus which of them did something today.
 *
 * The trader's own observation, and it is the whole bug: "there is no stock
 * that will be identified as growth today but not tomorrow." The screener that
 * fed membership demanded a new 52-week high on above-average volume, so a
 * company joined the list on the days it broke out and dropped off the days it
 * did not — the CANSLIM tag every other tool reads was a breakout tag with a
 * growth label on it.
 */
describe('membership comes from the slow half', () => {
  const universe = PRESETS.T8.find(d => d.key === 'canslim-universe');
  const breakout = PRESETS.T8.find(d => d.key === 'canslim');

  // Anything that can be true today and false tomorrow. A rule on one of these
  // belongs to the entry, never to the identity.
  const DAILY = [
    'price_52_week_high', 'relative_volume_10d_calc', 'relative_volume_intraday',
    'volume', 'change', 'gap', 'premarket_change', 'premarket_volume',
    'VWAP', 'RSI', 'High.1M', 'Low.1M', 'SMA50', 'EMA20',
  ];
  const mentionsDaily = f =>
    DAILY.some(d => String(f.left).includes(d) || String(f.right).includes(d));

  test('nothing in the universe screener can change between two sessions', () => {
    for (const f of universe.filters) {
      expect({ rule: `${f.left} ${f.operation} ${f.right}`, daily: mentionsDaily(f) })
        .toEqual({ rule: `${f.left} ${f.operation} ${f.right}`, daily: false });
    }
  });

  test('the breakout screener still carries the timing the universe dropped', () => {
    // Splitting them must not quietly delete the entry trigger — that would
    // turn the tool's candidate list into the universe list.
    expect(breakout.filters.some(mentionsDaily)).toBe(true);
    expect(breakout.filters.some(f => f.right === 'price_52_week_high')).toBe(true);
  });

  test('the universe keeps every fundamental the breakout screener tests', () => {
    // If the two disagreed on what a growth company is, a name could trade the
    // breakout without ever being a member, which is the same bug reversed.
    const slow = breakout.filters.filter(f => !mentionsDaily(f));
    for (const f of slow) {
      expect({ rule: f.left, inUniverse: universe.filters.some(u => u.left === f.left) })
        .toEqual({ rule: f.left, inUniverse: true });
    }
  });

  test('it maintains a list rather than proposing trades', () => {
    // labelOnly is what keeps its matches out of r0. Without it the tool would
    // start collecting cards for stocks it has no intention of trading, and
    // the training data would change shape for a labelling fix.
    expect(universe.labelOnly).toBe(true);
    expect(breakout.labelOnly).toBeFalsy();
  });

  test('only the universe screener is exempt from the tradability floor', () => {
    const tv = require('../src/sideA/tvScanner');
    const tradable = require('../src/sideA/tradable');
    const sent = def => tv.buildRequest(
      [...def.filters, ...(def.labelOnly ? [] : tradable.serverFilters())], def.sort).filter;
    const hasFloorRule = rules => rules.some(r => r.left === 'average_volume_10d_calc');
    expect(hasFloorRule(sent(universe))).toBe(false);
    expect(hasFloorRule(sent(breakout))).toBe(true);
  });

  test('membership lasts a quarter, which is the horizon the criteria describe', () => {
    // Ninety days from the last confirmation, so a member that stops printing
    // new highs is still a member — the point of separating the two.
    expect(canslim.MEMBER_DAYS).toBe(90);
  });
});
