/*
 * ONE LEVEL OWNS THE MONEY.
 *
 * Money management is what a strategy's winning backtest specified, so it
 * belongs to that strategy. The account is shared by every setup on the desk: a
 * risk rule written there is not any strategy's setting, it is a default that
 * quietly sizes whichever strategy has not been adopted yet, by a number nobody
 * chose for it. And two levels holding the same setting is how one of them wins
 * silently.
 *
 * What stays shared, and only this:
 *
 *   accountSize   on the account — the balance a PERCENTAGE is a percentage OF.
 *                 There is one of it and every setup is sized against the same
 *                 money, so it is genuinely shared rather than shared by
 *                 accident.
 *
 *   buyingPower, maxOrderValue, minShares, ratio   on the DESTINATION — "can
 *                 this account actually execute the trade the setup decided on,
 *                 and at what fraction". Execution capacity, not sizing.
 */

const os = require('os');
const path = require('path');
const fs = require('fs');

const RISK = path.join(os.tmpdir(), `risk-levels-${process.pid}.json`);
const PREFS = path.join(os.tmpdir(), `prefs-levels-${process.pid}.json`);
process.env.RISK_FILE = RISK;
process.env.SETUP_PREFS_FILE = PREFS;
afterAll(() => {
  for (const f of [RISK, PREFS]) { try { fs.unlinkSync(f); } catch { /* absent */ } }
});

const risk = require('../src/setups/risk');
const prefs = require('../src/setups/prefs');

const writeRisk = (o) => fs.writeFileSync(RISK, JSON.stringify(o));
const writePrefs = (o) => fs.writeFileSync(PREFS, JSON.stringify(o));

describe('a rule left on the account is reported as a leftover', () => {
  beforeEach(() => {
    writeRisk({ accountSize: 50000, riskPerTrade: 500 });
    writePrefs({ setups: {} });
  });

  /*
   * STILL READ, deliberately. Refusing it outright would stop a working setup
   * from sizing the moment this shipped — a silent halt rather than a fix.
   */
  test('it still sizes, so nothing stops trading', () => {
    const e = risk.resolve(risk.settings(), {});
    expect(e.riskPerTrade).toBe(500);
    expect(e.sources.risk).toBe('account');
  });

  test('...and it says so, naming the number and the way out', () => {
    const e = risk.resolve(risk.settings(), {});
    expect(e.legacy).toMatch(/\$500/);
    expect(e.legacy).toMatch(/risk-to-setups/);
  });

  // A setup that owns its rule is not nagged. The flag is about an
  // un-migrated leftover, not about overriding — which is the design.
  test('a setup with its own rule reports no leftover', () => {
    const e = risk.resolve(risk.settings(), { riskPct: 0.5 });
    expect(e.legacy).toBeUndefined();
    expect(e.sources.risk).toBe('setup');
  });

  test('an account with no rule at all reports none either', () => {
    writeRisk({ accountSize: 50000 });
    const e = risk.resolve(risk.settings(), { riskPct: 0.5 });
    expect(e.legacy).toBeUndefined();
  });

  // The flag is its OWN field. An override is a deliberate choice and this is
  // an un-migrated leftover; folding them together would make a correctly
  // configured desk look like one that needs work.
  test('a leftover is not filed as an override or a conflict', () => {
    const e = risk.resolve(risk.settings(), {});
    expect(e.overrides).toEqual([]);
    expect(e.conflicts).toEqual([]);
  });
});

describe('moving the rules onto the setups', () => {
  /*
   * NOTHING CHANGES SIZE. Each setup with no rule of its own is given the
   * account's current one — the exact number sizing it today — and only then is
   * the account's cleared.
   */
  const A = 'OR + VWAP 09:35@09:35';
  const B = 'Test@09:30';

  const migrate = () => {
    const account = risk.settings();
    const rule = account.riskPerTrade
      ? { riskPerTrade: account.riskPerTrade, riskPct: null }
      : (account.riskPct ? { riskPct: account.riskPct, riskPerTrade: null } : null);
    const cap = account.maxPositionPct;
    for (const id of [A, B]) {
      const own = prefs.settingsFor(id) || {};
      const patch = {};
      if (!own.riskPerTrade && !own.riskPct && rule) Object.assign(patch, rule);
      if (!own.maxPositionPct && cap) patch.maxPositionPct = cap;
      if (Object.keys(patch).length) prefs.saveSettings(id, patch);
    }
    risk.save({ riskPerTrade: null, riskPct: null, maxPositionPct: null });
  };

  beforeEach(() => {
    writeRisk({ accountSize: 50000, riskPerTrade: 500, maxPositionPct: 16.66 });
    writePrefs({ setups: { [B]: { riskPct: 0.5, maxPositionPct: 100 } } });
  });

  test('a setup with no rule is given the one sizing it today', () => {
    const before = risk.resolve(risk.settings(), prefs.settingsFor(A));
    migrate();
    const after = risk.resolve(risk.settings(), prefs.settingsFor(A));
    expect(after.riskPerTrade).toBe(before.riskPerTrade);
    expect(after.maxPositionPct).toBe(before.maxPositionPct);
  });

  test('...and now owns it', () => {
    migrate();
    expect(risk.resolve(risk.settings(), prefs.settingsFor(A)).sources.risk).toBe('setup');
  });

  // THE POINT OF THE EXERCISE: a setup that already owns its sizing is never
  // overwritten by the account's leftover.
  test('a setup that already owns its rule is untouched', () => {
    migrate();
    const own = prefs.settingsFor(B);
    expect(own.riskPct).toBe(0.5);
    expect(own.riskPerTrade).toBeNull();
    expect(own.maxPositionPct).toBe(100);
  });

  test('the account keeps its balance and loses the rest', () => {
    migrate();
    const s = risk.settings();
    expect(s.accountSize).toBe(50000);
    expect(s.riskPerTrade).toBeNull();
    expect(s.riskPct).toBeNull();
    // 100 is what "no cap" reads as once nothing is set.
    expect(s.maxPositionPct).toBe(100);
  });

  test('afterwards nothing reports a leftover', () => {
    migrate();
    for (const id of [A, B]) {
      expect(risk.resolve(risk.settings(), prefs.settingsFor(id)).legacy).toBeUndefined();
    }
  });

  // Repeatable: the account is cleared LAST, so a half-finished run leaves
  // every setup sized exactly as it was and can simply be repeated.
  test('running it twice changes nothing the second time', () => {
    migrate();
    const snapshot = JSON.stringify([prefs.settingsFor(A), prefs.settingsFor(B),
                                     risk.settings().accountSize]);
    migrate();
    expect(JSON.stringify([prefs.settingsFor(A), prefs.settingsFor(B),
                           risk.settings().accountSize])).toBe(snapshot);
  });
});

describe('what is NOT money management', () => {
  /*
   * The destination answers "can this account execute it", which is a different
   * question from "how much should this strategy risk". Keeping them apart is
   * what stops an execution limit from quietly becoming a sizing rule.
   */
  test('the account holds a balance and nothing else it can size with', () => {
    writeRisk({ accountSize: 50000 });
    const s = risk.settings();
    expect(s.accountSize).toBe(50000);
    expect(s.riskPerTrade).toBeNull();
    expect(s.riskPct).toBeNull();
  });

  test('a percentage still needs the balance to be a percentage OF', () => {
    writeRisk({ accountSize: 50000 });
    const e = risk.resolve(risk.settings(), { riskPct: 0.5 });
    const size = risk.sizeFor({ entry: 20, riskPerShare: 1 }, e);
    expect(size.shares).toBe(250);          // 0.5% of 50,000 = $250 / $1
    expect(size.riskRule).toBe('pct_of_equity');
  });

  test('...and with no balance it cannot size, rather than guessing one', () => {
    writeRisk({});
    const e = risk.resolve(risk.settings(), { riskPct: 0.5 });
    expect(risk.sizeFor({ entry: 20, riskPerShare: 1 }, e)).toBeNull();
  });
});
