/*
 * The live desk and the backtest, compared field by field.
 *
 * THE FAILURE THIS EXISTS TO CATCH. The desk was built to reproduce a
 * backtest. After two weeks of live trading it had not, and the reason was
 * ordinary configuration held in three separate files with nothing anywhere
 * comparing them. Each difference was invisible on its own; the only symptom
 * was a P&L that did not match, which is the least diagnostic symptom there is.
 *
 * The worst of them was not a number at all. On a ONE-MINUTE entry window the
 * fill model decides which bar's conditions are read:
 *
 *     'next_open' / 'desk'   entry at the 09:35 OPEN,  decided on 09:34
 *     'close'                entry at the 09:35 CLOSE, decided on 09:35
 *
 * Both satisfy a 935 window and both are legitimate. They are also a different
 * bar's close, VWAP and ATR — a different SIGNAL, not a different price.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

// Point the desk's config readers at a scratch directory BEFORE requiring
// anything that reads them, so the test never sees the real account.
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'parity-'));
process.env.DATA_DIR = DIR;
process.env.RISK_FILE = path.join(DIR, 'risk.json');
process.env.SETUP_PREFS_FILE = path.join(DIR, 'setup-prefs.json');

const parity = require('../src/setups/parity');

const write = (file, obj) => fs.writeFileSync(path.join(DIR, file), JSON.stringify(obj));

// The 09:35 setup as qp really defines it: a clock window, one entry a day.
const STRATEGY = { name: 'OR + VWAP 09:35 (Long)', side: 'long',
                   risk: { window_start: 935, window_end: 935,
                           max_entries_per_day: 1 } };
const SETUP = { id: 'OR + VWAP 09:35@09:35', name: 'OR + VWAP 09:35',
                decisionTime: '09:35', windowEnd: '09:35', tools: ['T2'] };

// Backtest #349's spec, as the user ran it.
const SPEC_349 = {
  fill: 'next_open', tf: '1m', feed: 'polygon',
  account_equity: 50000, risk_pct: 0.5,
  rank_per_day: { metric: 'vwap_extension', top_n: 3 },
  universe: { kind: 'tools', register: 'R1', tools: ['T2'] },
};

const find = (res, what) => res.rows.find(r => r.what === what);

beforeEach(() => {
  write('risk.json', { accountSize: 50000, riskPerTrade: 500, maxPositionPct: 16.66 });
  write('setup-prefs.json', { setups: { [SETUP.id]: {
    rankMetric: 'vwap_extension', topN: 3, tf: '1m', feed: 'polygon',
    // qp's cap is per strategy per symbol and the desk's is the whole day's
    // budget, so this row is a prompt to look rather than a verdict — see the
    // note it carries. Set here so the "matched" case has nothing outstanding.
    maxTradesPerDay: 1 } } });
});

describe('which bar the decision is taken on', () => {
  // The window pins the ENTRY bar, so a model that fills at the next open must
  // have decided a bar earlier. This is arithmetic, not a preference.
  test("'close' decides on the window bar itself", () => {
    expect(parity.decisionBar(935, 935, 'close').bar).toBe('09:35');
  });
  test("'next_open' fills at the 09:35 open, so it decided at 09:34", () => {
    expect(parity.decisionBar(935, 935, 'next_open').bar).toBe('09:34');
  });
  test("'desk' is the same one-bar offset — the fill moved, not the decision", () => {
    expect(parity.decisionBar(935, 935, 'desk').bar).toBe('09:34');
  });

  // A RANGE window has no single decision bar: the entry may fire on any bar
  // inside it. Answering '09:40' for a 09:40–10:10 setup would be a made-up
  // fact, and a made-up fact that compares equal is worse than no answer.
  test('a range window reports no decision bar, and says why', () => {
    const d = parity.decisionBar(940, 1010, 'close');
    expect(d.bar).toBeNull();
    expect(d.why).toMatch(/any bar inside/);
  });
  test('a strategy with no window reports none', () => {
    expect(parity.decisionBar(null, null, 'close').bar).toBeNull();
  });
  // Number(null) is 0, which would make an absent window read as midnight — a
  // setup scheduled for a time it can never run at.
  test('an absent window is absent, not midnight', () => {
    expect(parity.hhmm(null)).toBeNull();
    expect(parity.hhmm('')).toBeNull();
    expect(parity.hhmm(0)).toBe('00:00');
  });
});

describe('the desk as it WAS — pinned to the old close fill', () => {
  // The regression this whole exercise came from. `fill: 'close'` decides on
  // the window bar itself, a full bar later than the backtest that justified
  // the setup. Kept as a test because the preference still exists and someone
  // could set it again.
  const res = () => {
    write('setup-prefs.json', { setups: { [SETUP.id]: {
      rankMetric: 'vwap_extension', topN: 3, tf: '1m', feed: 'polygon',
      maxTradesPerDay: 1, fill: 'close' } } });
    return parity.compare({ setup: SETUP, spec: SPEC_349, strategy: STRATEGY });
  };

  test('THE DECISION BAR IS A FULL MINUTE APART', () => {
    const r = find(res(), 'decision bar');
    expect(r.status).toBe('differ');
    expect(r.live).toBe('09:35');
    expect(r.backtest).toBe('09:34');
  });

  test('and it is reported FIRST — it changes which signals exist at all', () => {
    expect(res().rows[0].what).toBe('decision bar');
    expect(parity.summarise(res())[0]).toMatch(/^decision bar/);
  });

  test("'close' against 'next_open' is a real difference, not a naming one", () => {
    const r = find(res(), 'fill model');
    expect(r.status).toBe('differ');
    expect([r.live, r.backtest]).toEqual(['close', 'next_open']);
  });
});

describe('the desk as it IS — the default live fill', () => {
  const res = () => parity.compare({ setup: SETUP, spec: SPEC_349, strategy: STRATEGY });

  // THE FIX, stated as a test. 'live' enters at the 09:35 open exactly as
  // 'next_open' does, so both decide on the completed 09:34 bar.
  test('the decision bar now MATCHES the backtest', () => {
    const r = find(res(), 'decision bar');
    expect(r.status).toBe('match');
    expect([r.live, r.backtest]).toEqual(['09:34', '09:34']);
  });

  // 'live' and 'desk'/'next_open' are the same decision from the same bar with
  // the same levels; only the reported entry differs, and only because one is
  // a plan and the other a measurement. Flagging that would leave a correctly
  // aligned desk permanently red, which is how a checker gets ignored.
  test("'live' and 'next_open' are not counted as a difference", () => {
    expect(find(res(), 'fill model').status).toBe('match');
  });

  test('the ranking MATCHES — this was never the problem', () => {
    expect(find(res(), 'rank metric').status).toBe('match');
    expect(find(res(), 'rank top N').status).toBe('match');
  });

  // What is still outstanding on #349, and it is configuration rather than
  // timing: the run compounded a percentage and took no position cap.
  test('risk model still differs: flat dollars live, compounding percent tested', () => {
    const r = find(res(), 'risk model');
    expect(r.status).toBe('differ');
    expect([r.live, r.backtest]).toEqual(['fixed $', '% of equity']);
  });

  test('...and the dollars are twice apart on trade one', () => {
    const r = find(res(), 'risk per trade');
    expect([r.live, r.backtest]).toEqual([500, 250]);
    expect(r.note).toMatch(/compounds/);
  });

  test('the position cap is live-only — the backtest ran uncapped', () => {
    const r = find(res(), 'max position %');
    expect(r.live).toBe(16.66);
    expect(r.backtest).toBeNull();
    expect(r.status).toBe('unknown');
  });
});

describe('a desk configured to match', () => {
  const SPEC_MATCHED = { ...SPEC_349,
    fill: 'desk', risk_pct: 0, risk_usd: 500, max_position_pct: 16.66 };

  test('every comparison passes', () => {
    const res = parity.compare({ setup: SETUP, spec: SPEC_MATCHED, strategy: STRATEGY });
    expect(res.differs).toEqual([]);
    expect(parity.summarise(res)).toEqual([]);
  });

  test('...including the decision bar, on the 09:34 bar both sides', () => {
    const res = parity.compare({ setup: SETUP, spec: SPEC_MATCHED, strategy: STRATEGY });
    const r = find(res, 'decision bar');
    expect([r.live, r.backtest]).toEqual(['09:34', '09:34']);
  });

  // A backtest run on 'close' is still a real mismatch against a live desk,
  // whichever way round it is.
  test("a 'close' backtest against the live desk is caught", () => {
    const res = parity.compare({ setup: SETUP, strategy: STRATEGY,
                                 spec: { ...SPEC_MATCHED, fill: 'close' } });
    expect(find(res, 'decision bar').status).toBe('differ');
    expect(find(res, 'fill model').status).toBe('differ');
  });
});

describe('what cannot be compared is never called a match', () => {
  test('a spec with no fill model leaves the decision bar UNKNOWN', () => {
    const res = parity.compare({ setup: SETUP, strategy: STRATEGY,
                                 spec: { ...SPEC_349, fill: undefined } });
    const r = find(res, 'decision bar');
    expect(r.status).toBe('unknown');
    expect(r.backtest).toBeNull();
  });

  test('an unset live account is unknown, not zero', () => {
    write('risk.json', {});
    const res = parity.compare({ setup: SETUP, spec: SPEC_349, strategy: STRATEGY });
    expect(find(res, 'account size').live).toBeNull();
    expect(find(res, 'account size').status).toBe('unknown');
  });

  test('the summary lists the unknowns as NOT COMPARED', () => {
    const res = parity.compare({ setup: SETUP, strategy: STRATEGY,
                                 spec: { ...SPEC_349, fill: undefined } });
    expect(parity.summarise(res).some(l => /NOT COMPARED/.test(l))).toBe(true);
  });
});

describe('a setup may override the account, and the override is what runs', () => {
  test('setup-level risk is compared, not the account it overrides', () => {
    write('setup-prefs.json', { setups: { [SETUP.id]: {
      rankMetric: 'vwap_extension', topN: 3, riskPerTrade: 200 } } });
    const res = parity.compare({ setup: SETUP, strategy: STRATEGY,
                                 spec: { ...SPEC_349, risk_pct: 0, risk_usd: 200 } });
    expect(find(res, 'risk per trade').status).toBe('match');
  });

  // 100% is the live default and means "no cap", which is exactly what an
  // absent cap means in the backtest. They must not read as a difference.
  test('a live cap of 100% and no backtest cap are the same thing', () => {
    write('risk.json', { accountSize: 50000, riskPerTrade: 500, maxPositionPct: 100 });
    const res = parity.compare({ setup: SETUP, spec: SPEC_349, strategy: STRATEGY });
    const r = find(res, 'max position %');
    expect(r.live).toBeNull();
    expect(r.backtest).toBeNull();
  });
});
