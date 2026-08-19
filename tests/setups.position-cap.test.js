/*
 * How big a position may be, per SETUP rather than per desk.
 *
 * WHAT WENT WRONG. `maxPositionPct` decides how many positions fit at once —
 * 100 divided by it. Six 09:35 trades in a day needs six slots, so the figure
 * was lowered to make room. But the only control on the page was the DESK's, so
 * lowering it squeezed T2 10:00 and Test as well, and each of those takes one
 * position a day and had no reason to be capped at a sixth of the account.
 *
 * One setting was doing two jobs. The override already existed everywhere it
 * mattered — prefs stores it, the catalogue surfaces it, the runner applies it
 * over the account's — and there was simply no box to type it in, so it could
 * only ever be set desk-wide, which is the one place it should not have been.
 *
 * These tests hold the whole path: stored, surfaced, applied, and refused when
 * it is not a percentage.
 */

const os = require('os');
const path = require('path');
const fs = require('fs');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'poscap-'));
process.env.DATA_DIR = DIR;
process.env.SETUP_PREFS_FILE = path.join(DIR, 'setup-prefs.json');
process.env.RISK_FILE = path.join(DIR, 'risk.json');

const prefs = require('../src/setups/prefs');
const risk = require('../src/setups/risk');

beforeEach(() => {
  fs.rmSync(process.env.SETUP_PREFS_FILE, { force: true });
  fs.rmSync(risk.FILE, { force: true });
});
afterAll(() => { fs.rmSync(DIR, { recursive: true, force: true }); });

// ── it is stored per setup ─────────────────────────────────────────────────

describe('the setting', () => {
  test('is kept against the setup that was given it', () => {
    prefs.saveSettings('S@09:35', { maxPositionPct: 16 });
    expect(prefs.settingsFor('S@09:35').maxPositionPct).toBe(16);
  });

  /*
   * THE WHOLE POINT. One setup's cap must not reach any other — that is the
   * failure this fixes.
   */
  test('and reaches no other setup', () => {
    prefs.saveSettings('S@09:35', { maxPositionPct: 16 });
    expect(prefs.settingsFor('T2@10:00').maxPositionPct).toBeNull();
  });

  /*
   * BLANK MEANS THE ACCOUNT'S, and is stored as absent rather than as 100.
   * Storing 100 would freeze the setup at today's default and silently stop it
   * tracking a later change to the desk figure.
   */
  test('clearing it goes back to the account\'s, not to 100', () => {
    prefs.saveSettings('S@09:35', { maxPositionPct: 16 });
    prefs.saveSettings('S@09:35', { maxPositionPct: null });
    expect(prefs.settingsFor('S@09:35').maxPositionPct).toBeNull();
  });

  test('it does not disturb the other per-setup settings', () => {
    prefs.saveSettings('S@09:35', { maxTradesPerDay: 6, riskPerTrade: 50 });
    prefs.saveSettings('S@09:35', { maxPositionPct: 16 });
    expect(prefs.settingsFor('S@09:35')).toMatchObject({
      maxTradesPerDay: 6, riskPerTrade: 50, maxPositionPct: 16 });
  });
});

// ── refused where it is typed ──────────────────────────────────────────────

describe('what it will not accept', () => {
  /*
   * It DIVIDES INTO 100. Zero is an infinity and 600 is a position six times
   * the account — stored, either would read back as a real preference and size
   * an order from it. The desk-wide figure has been checked since it existed;
   * this one went in without it.
   */
  test('above 100 is refused', () => {
    expect(() => prefs.saveSettings('S', { maxPositionPct: 600 })).toThrow(/between 1 and 100/);
  });

  test('zero and below are refused', () => {
    expect(() => prefs.saveSettings('S', { maxPositionPct: 0 })).toThrow();
    expect(() => prefs.saveSettings('S', { maxPositionPct: -5 })).toThrow();
  });

  test('something that is not a number is refused', () => {
    expect(() => prefs.saveSettings('S', { maxPositionPct: 'lots' })).toThrow();
  });

  test('a refusal stores nothing', () => {
    try { prefs.saveSettings('S', { maxPositionPct: 600 }); } catch { /* expected */ }
    expect(prefs.settingsFor('S').maxPositionPct).toBeNull();
  });

  test('100 is allowed — it is "the whole account", not an error', () => {
    prefs.saveSettings('S', { maxPositionPct: 100 });
    expect(prefs.settingsFor('S').maxPositionPct).toBe(100);
  });
});

// ── what it actually does to a size ────────────────────────────────────────

describe('the size it produces', () => {
  const cfgFor = setup => ({
    ...risk.settings(),
    ...(setup.riskPerTrade ? { riskPerTrade: setup.riskPerTrade } : {}),
    ...(setup.maxPositionPct ? { maxPositionPct: setup.maxPositionPct } : {}),
  });

  beforeEach(() => {
    // $100,000 account, $500 a trade, and a desk cap that leaves six slots —
    // the configuration that caused the problem.
    risk.save({ accountSize: 100000, riskPerTrade: 500, maxPositionPct: 16 });
  });

  test('the desk cap bites when a setup says nothing', () => {
    // $500 risk over $0.50 a share is 1,000 shares; 16% of 100k at $20 is 800.
    const s = risk.sizeFor({ entry: 20, riskPerShare: 0.5 }, cfgFor({}));
    expect(s.shares).toBe(800);
    expect(s.capped).toMatch(/16% of the account/);
  });

  /*
   * THE FIX, in one assertion. T2 takes one position a day and is now free of a
   * cap that only ever existed to make room for six of somebody else's.
   */
  test('a setup that raises it is not squeezed by the desk figure', () => {
    const s = risk.sizeFor({ entry: 20, riskPerShare: 0.5 },
      cfgFor({ maxPositionPct: 100 }));
    expect(s.shares).toBe(1000);          // risk decides it, not the cap
    expect(s.capped).toBeNull();
  });

  /* And it still works downwards, for a strategy being trialled small. */
  test('a setup that lowers it is capped tighter than the desk', () => {
    const s = risk.sizeFor({ entry: 20, riskPerShare: 0.5 },
      cfgFor({ maxPositionPct: 5 }));
    expect(s.shares).toBe(250);
    expect(s.capped).toMatch(/5% of the account/);
  });

  test('the reason names the percentage that actually bit', () => {
    const s = risk.sizeFor({ entry: 20, riskPerShare: 0.5 },
      cfgFor({ maxPositionPct: 8 }));
    expect(s.capped).toMatch(/8% of the account allows 400/);
    expect(s.capped).not.toMatch(/16%/);
  });
});

// ── the page it is typed into ──────────────────────────────────────────────

describe('the control on the page', () => {
  const PAGE = fs.readFileSync(
    path.join(__dirname, '..', 'public', 'alerts.html'), 'utf8');

  /*
   * THE ONLY PIECE THAT WAS MISSING. Every other layer already handled it, so
   * the setting could be reached by the API and never by a person.
   */
  test('the setup editor has a box for it', () => {
    expect(PAGE).toMatch(/id="st-mpp-\$\{i\}"/);
    expect(PAGE).toMatch(/max position %/);
  });

  test('it is bounded in the input as well as on the server', () => {
    const at = PAGE.indexOf('id="st-mpp-${i}"');
    expect(PAGE.slice(at, at + 120)).toMatch(/min="1" max="100"/);
  });

  test('it is sent when the setup is saved', () => {
    expect(PAGE).toMatch(/maxPositionPct: Number\(document\.getElementById\(`st-mpp-\$\{i\}`\)\.value\) \|\| null/);
  });

  /* Blank has to reach the server as null, or it stores today's default. */
  test('blank is sent as null, not as 100', () => {
    expect(PAGE).toMatch(/storing 100 would freeze this setup/);
  });

  /*
   * "16%" is a number; "16% — up to 6 positions at once" is the decision that
   * was actually being made. That reasoning is what put the wrong figure on the
   * whole desk, so it is written next to the box.
   */
  test('it says how many positions the number allows', () => {
    expect(PAGE).toMatch(/function paintSetupSlots/);
    expect(PAGE).toMatch(/up to \$\{Math\.max\(1, Math\.floor\(100 \/ pct\)\)\} position\(s\) at once/);
  });

  test('an empty box shows the account\'s figure rather than nothing', () => {
    const at = PAGE.indexOf('function paintSetupSlots');
    expect(PAGE.slice(at, at + 700)).toMatch(/the account's \$\{acct\}%/);
  });

  /* An override is visible on the row without opening the editor. */
  test('the summary row shows it, and only when it overrides the desk', () => {
    expect(PAGE).toMatch(/\.\.\.\(s\.maxPositionPct/);
    expect(PAGE).toMatch(/A setup showing the account's\s*\n?\s*\/\/ own figure back at you says nothing/);
  });
});
