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

  // COMPARED IN THE UNIT EACH SIDE WAS CONFIGURED IN. Converting the
  // percentage to dollars would print "250" against "500" and invite the fix
  // of typing 250 into the desk — which reproduces the first trade and nothing
  // after it, because the backtest compounds and the desk does not.
  test('...and each is shown in its own unit, not converted', () => {
    const r = find(res(), 'risk per trade');
    expect([r.live, r.backtest]).toEqual(['$500', '0.5%']);
    expect(find(res(), 'risk model').note).toMatch(/COMPOUNDS/);
  });

  // WHICH LEVEL SET IT. Two levels hold this setting and the setup wins; a
  // report that did not say which one was in force sends you to edit the
  // wrong file.
  test('the row names the level the value came from', () => {
    expect(find(res(), 'risk per trade').note).toMatch(/account level/);
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

/*
 * ── ADOPT: the winning backtest becomes the desk's settings ──────────────
 *
 * The direction that matters once a run has won. You try combinations in qp
 * until one is clearly best; that run is then the specification. Setting the
 * desk to it by hand, across two config files in a different vocabulary, is
 * where the original divergences came from.
 *
 * One-way, always: BACKTEST -> DESK. Nothing here ever edits a backtest.
 */
describe('adopting a winning backtest', () => {
  // #349 as it was actually run: 0.5% of 50,000, no position cap, next_open.
  const plan = () => parity.planAdopt({ setup: SETUP, spec: SPEC_349, strategy: STRATEGY });

  /*
   * THE MONEY RULES GO ON THE SETUP, NOT THE ACCOUNT.
   *
   * The account is shared by every setup on the desk. A risk rule written
   * there is the DESK's setting, not this strategy's — so adopting a winner
   * for another strategy next week would silently resize this one's trades,
   * and nothing would report it.
   */
  test("the risk rule is written as THIS setup's, not the desk's", () => {
    const p = plan();
    expect(p.setupPatch.riskPct).toBe(0.5);
    expect(p.account.riskPct).toBeUndefined();
    expect(p.account.riskPerTrade).toBeUndefined();
  });

  // Exactly one rule is written and the other explicitly nulled — null deletes
  // the key — so a setup can never end up naming both, which is the one case
  // no precedence can settle.
  test('...and the rule it did NOT use is deleted, never left standing', () => {
    expect(plan().setupPatch.riskPerTrade).toBeNull();
  });

  // The balance is genuinely one number for the whole desk, so it is the ONE
  // thing adoption writes account-wide.
  test('only the account SIZE is account-wide', () => {
    const p = plan();
    expect(p.account).toEqual({ accountSize: 50000 });
  });

  // Absent in a backtest means NO cap. The desk spells no-cap as 100, and it
  // is WRITTEN as 100 rather than cleared: clearing it would fall through to
  // whatever the account happens to say, and the run said none.
  test('an uncapped backtest writes no-cap on the setup', () => {
    expect(plan().setupPatch.maxPositionPct).toBe(100);
  });

  /*
   * THE FILL MODEL IS TRANSLATED. A backtest runs 'desk' or 'next_open';
   * neither can be evaluated in real time, because both report the entry as a
   * bar that has not printed. Copying the name across would stop the desk
   * firing at all.
   */
  test("'next_open' is adopted as 'live', its real-time twin", () => {
    expect(plan().setupPatch.fill).toBe('live');
  });

  test("a 'close' backtest is adopted as 'close' — it IS runnable live", () => {
    const p = parity.planAdopt({ setup: SETUP, strategy: STRATEGY,
                                 spec: { ...SPEC_349, fill: 'close' } });
    expect(p.setupPatch.fill).toBe('close');
  });

  test('the ranking, timeframe, feed and view come across', () => {
    const p = plan().setupPatch;
    expect(p.rankMetric).toBe('vwap_extension');
    expect(p.topN).toBe(3);
    expect(p.tf).toBe('1m');
    expect(p.feed).toBe('polygon');
    expect(p.view).toBe('all');
  });

  test('every change is listed with what it was and what it becomes', () => {
    const c = plan().changes;
    const risk = c.find(x => x.what === 'risk per trade (%)');
    expect(risk).toBeTruthy();
    expect([risk.from, risk.to]).toEqual([null, 0.5]);
    const cap = c.find(x => x.what === 'max position %');
    expect([cap.from, cap.to]).toEqual([null, 100]);
  });

  // ONE line may carry that warning now, and it is the balance — the only
  // thing that really is shared. Everything else is local to this setup, and
  // saying "account-wide" about it would be a lie that stops a safe change.
  test('the account-wide warning is on the balance and nothing else', () => {
    // The fixture already has 50,000, and an unchanged value is not a change —
    // so the balance has to actually move for its warning to be visible.
    write('risk.json', { accountSize: 25000, riskPerTrade: 500, maxPositionPct: 16.66 });
    const c = plan().changes.filter(x => x.why && x.why.includes('ACCOUNT-WIDE'));
    expect(c.map(x => x.what)).toEqual(['account size']);
  });

  test('an unchanged balance is not listed at all', () => {
    expect(plan().changes.some(x => x.what === 'account size')).toBe(false);
  });

  test("the money rules are named as this setup's own", () => {
    const c = plan().changes.find(x => x.what === 'risk per trade (%)');
    expect(c.why).toMatch(/this setup's own/);
  });

  // The percentage compounds in the backtest and does not on the desk. Naming
  // it is the only honest option while live sizes off a configured number.
  test('the compounding gap is named rather than hidden', () => {
    const risk = plan().changes.find(x => x.what === 'risk per trade (%)');
    expect(risk.why).toMatch(/COMPOUNDS/);
  });

  /*
   * THE PROPERTY THE WHOLE DESIGN EXISTS FOR: adopting one strategy's winner
   * must not move another strategy's settings.
   */
  test('adopting one setup cannot resize another', () => {
    const OTHER = { id: 'Test@09:30', name: 'Test', decisionTime: '09:30',
                    windowEnd: '11:30', tools: ['T2'] };
    write('setup-prefs.json', { setups: {
      [SETUP.id]: {},
      [OTHER.id]: { riskPerTrade: 300, maxPositionPct: 25 },
    } });
    parity.applyAdopt(parity.planAdopt({ setup: SETUP, spec: SPEC_349, strategy: STRATEGY }));
    const other = require('../src/setups/prefs').settingsFor(OTHER.id);
    expect(other.riskPerTrade).toBe(300);
    expect(other.maxPositionPct).toBe(25);
  });

  // The universe is the strategy's TOOL assignment, decided in qp. A backtest
  // run against other tools is a question about the strategy, not a setting to
  // copy onto the desk behind your back.
  test('a mismatched universe is refused, not silently applied', () => {
    const p = parity.planAdopt({ setup: SETUP, strategy: STRATEGY,
      spec: { ...SPEC_349, universe: { kind: 'tools', register: 'R1', tools: ['T5'] } } });
    expect(p.refused.length).toBe(1);
    expect(p.refused[0]).toMatch(/T5/);
  });

  test('a matching universe is not flagged', () => {
    expect(plan().refused).toEqual([]);
  });

  // BUILDING a plan must never write. Running a check should not be able to
  // change what a live account does with real money.
  test('planning writes nothing', () => {
    plan();
    expect(risk_settings().maxPositionPct).toBe(16.66);
  });

  // The account's own risk rule is left exactly as it was — adoption has no
  // business editing a setting shared by every other strategy.
  test('...and applying leaves the account risk rule alone', () => {
    parity.applyAdopt(plan());
    expect(risk_settings().riskPerTrade).toBe(500);
  });

  test('applying it makes the comparison clean', () => {
    const p = plan();
    parity.applyAdopt(p);
    const res = parity.compare({ setup: SETUP, spec: SPEC_349, strategy: STRATEGY });
    // The decision bar, the fill, the ranking and the sizing now all agree.
    expect(res.differs).toEqual([]);
  });

  test('...and adopting twice is a no-op', () => {
    parity.applyAdopt(plan());
    expect(plan().changes).toEqual([]);
  });
});

// Read through the same module the desk uses, so the test cannot pass against
// a stale copy of the file.
function risk_settings() {
  return require('../src/setups/risk').settings();
}

/*
 * ── THE THREE LEVELS MUST NOT CONFLICT ───────────────────────────────────
 *
 * Money settings live at TWO levels — the account (data/risk.json, shared by
 * every setup) and the setup (data/setup-prefs.json, one strategy alone). The
 * TOOL level holds none: a tool decides which setups it runs and owns its card
 * register, and never sizes anything.
 *
 * The trap is not that both exist. It is that they used to be merged FIELD BY
 * FIELD: adopt a run that won at 0.5% of equity, and a setup still carrying a
 * flat riskPerTrade from an earlier experiment survives the merge and wins,
 * because the sizing prefers a flat dollar. The desk then sizes by a rule
 * nobody chose while every report reads the account and says it agrees.
 */
describe('account level vs setup level', () => {
  const risk = require('../src/setups/risk');

  test('with no override, the account decides', () => {
    const e = risk.resolve({ accountSize: 50000, riskPct: 0.5, maxPositionPct: 100 }, {});
    expect(e.riskRule).toBe('pct_of_equity');
    expect(e.riskPct).toBe(0.5);
    expect(e.sources.risk).toBe('account');
    expect(e.conflicts).toEqual([]);
  });

  // THE TRAP, as a test. The risk rule is taken WHOLE from whichever level
  // names one — half a percentage and half a flat dollar is neither.
  test('a setup flat dollar BEATS an account percentage, and says so', () => {
    const e = risk.resolve({ accountSize: 50000, riskPct: 0.5, maxPositionPct: 100 },
                           { riskPerTrade: 500 });
    expect(e.riskRule).toBe('fixed_usd');
    expect(e.riskPerTrade).toBe(500);
    // The account's percentage must be GONE, not carried alongside.
    expect(e.riskPct).toBeNull();
    expect(e.sources.risk).toBe('setup');
    // AN OVERRIDE IS THE DESIGN, not a fault — every adopted setup does it, and
    // calling it a conflict would leave a correctly configured desk red.
    expect(e.conflicts).toEqual([]);
    expect(e.overrides.length).toBe(1);
    expect(e.overrides[0]).toMatch(/0\.5%/);
  });

  test('a setup percentage beats an account flat dollar the same way', () => {
    const e = risk.resolve({ accountSize: 50000, riskPerTrade: 500, maxPositionPct: 100 },
                           { riskPct: 0.5 });
    expect(e.riskRule).toBe('pct_of_equity');
    expect(e.riskPerTrade).toBeNull();
    expect(e.conflicts).toEqual([]);
    expect(e.overrides.length).toBe(1);
  });

  // THE ONE REAL CONFLICT: a single level naming two risk rules at once. No
  // precedence can settle that, because there is only one level involved.
  test('a setup naming BOTH is a conflict, resolved to the flat figure', () => {
    const e = risk.resolve({ accountSize: 50000, riskPct: 0.5 },
                           { riskPerTrade: 500, riskPct: 1.0 });
    expect(e.riskRule).toBe('fixed_usd');
    expect(e.conflicts[0]).toMatch(/BOTH/);
  });

  test('the position cap resolves the same way, and reports the override', () => {
    const e = risk.resolve({ accountSize: 50000, riskPct: 0.5, maxPositionPct: 100 },
                           { maxPositionPct: 16.66 });
    expect(e.maxPositionPct).toBe(16.66);
    expect(e.sources.maxPositionPct).toBe('setup');
    expect(e.conflicts).toEqual([]);
    expect(e.overrides.some(c => /100%/.test(c))).toBe(true);
  });

  // 100 is the account default and means NO cap, so it is not an override when
  // the setup says nothing.
  test('no setup cap falls through to the account with no conflict', () => {
    const e = risk.resolve({ accountSize: 50000, riskPct: 0.5, maxPositionPct: 100 }, {});
    expect(e.maxPositionPct).toBe(100);
    expect(e.conflicts).toEqual([]);
    expect(e.overrides).toEqual([]);
  });

  test('the tool level holds no money settings at all', () => {
    // Stated as a test so the absence is on the record: a tool that started
    // carrying a risk figure would be a third place for this to drift.
    const catalog = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'setups', 'catalog.js'), 'utf8');
    expect(/accountSize/.test(catalog)).toBe(false);
  });
});

describe('adopting writes the spec where it belongs', () => {
  test("the money rules land on the SETUP, replacing whatever it held", () => {
    write('setup-prefs.json', { setups: { [SETUP.id]: {
      rankMetric: 'vwap_extension', topN: 3,
      // left over from an earlier experiment
      riskPerTrade: 500, maxPositionPct: 16.66 } } });
    const plan = parity.planAdopt({ setup: SETUP, spec: SPEC_349, strategy: STRATEGY });
    expect(plan.setupPatch.riskPct).toBe(0.5);
    expect(plan.setupPatch.riskPerTrade).toBeNull();
    expect(plan.setupPatch.maxPositionPct).toBe(100);
  });

  test('...and every replacement is listed, not done quietly', () => {
    write('setup-prefs.json', { setups: { [SETUP.id]: { riskPerTrade: 500 } } });
    const plan = parity.planAdopt({ setup: SETUP, spec: SPEC_349, strategy: STRATEGY });
    const c = plan.changes.find(x => x.what === 'risk per trade ($)');
    expect([c.from, c.to]).toEqual([500, null]);
  });

  // AFTER ADOPTING, the setup answers for its own size and the account is only
  // the balance. Nothing has to be remembered about which level to look at.
  test('the setup owns its risk rule afterwards', () => {
    write('setup-prefs.json', { setups: { [SETUP.id]: {
      rankMetric: 'vwap_extension', topN: 3, riskPerTrade: 500, maxPositionPct: 16.66 } } });
    parity.applyAdopt(parity.planAdopt({ setup: SETUP, spec: SPEC_349, strategy: STRATEGY }));
    const risk = require('../src/setups/risk');
    const eff = risk.resolve(risk.settings(),
                             require('../src/setups/prefs').settingsFor(SETUP.id));
    expect(eff.sources.risk).toBe('setup');
    expect(eff.riskPct).toBe(0.5);
    expect(eff.riskPerTrade).toBeNull();
    // No AMBIGUITY. The override of the account is expected and reported apart.
    expect(eff.conflicts).toEqual([]);
  });

  test('...and the comparison is clean afterwards', () => {
    write('setup-prefs.json', { setups: { [SETUP.id]: {
      rankMetric: 'vwap_extension', topN: 3, riskPerTrade: 500, maxPositionPct: 16.66 } } });
    parity.applyAdopt(parity.planAdopt({ setup: SETUP, spec: SPEC_349, strategy: STRATEGY }));
    const res = parity.compare({ setup: SETUP, spec: SPEC_349, strategy: STRATEGY });
    expect(res.differs).toEqual([]);
  });
});

// A SETUP OVERRIDING THE ACCOUNT IS NOT REPORTED as a difference: it is the
// design, and every adopted setup does it. What IS reported is one level
// naming two risk rules at once, which no precedence can settle.
describe('only real ambiguity is surfaced by the comparison', () => {
  test('an override of the account is NOT flagged', () => {
    write('risk.json', { accountSize: 50000, riskPerTrade: 500, maxPositionPct: 16.66 });
    write('setup-prefs.json', { setups: { [SETUP.id]: {
      rankMetric: 'vwap_extension', topN: 3, tf: '1m', feed: 'polygon',
      maxTradesPerDay: 1, riskPct: 0.5, maxPositionPct: 100 } } });
    const res = parity.compare({ setup: SETUP, spec: SPEC_349, strategy: STRATEGY });
    expect(res.rows.find(r => r.what === 'setting conflict')).toBeUndefined();
    // ...and the comparison passes, because the setup IS the backtest now.
    expect(res.differs).toEqual([]);
  });

  test('one level naming two risk rules IS flagged', () => {
    write('setup-prefs.json', { setups: { [SETUP.id]: {
      rankMetric: 'vwap_extension', topN: 3, tf: '1m', feed: 'polygon',
      maxTradesPerDay: 1, riskPerTrade: 500, riskPct: 0.5 } } });
    const res = parity.compare({ setup: SETUP, spec: SPEC_349, strategy: STRATEGY });
    const row = res.rows.find(r => r.what === 'setting conflict');
    expect(row).toBeTruthy();
    expect(row.status).toBe('differ');
    expect(row.live).toMatch(/BOTH/);
  });
});
