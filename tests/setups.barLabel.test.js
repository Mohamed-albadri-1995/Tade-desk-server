/*
 * THE LOG MUST NAME THE BAR THAT FAILED, AND THE SETUP THAT WAS QUIET.
 *
 * Read off the live feed, 2026-09-14:
 *
 *   11:30:00  WARN  Test  No 09:29 bar for XNCR, NTNX, PAY, WDAY, TECK,
 *                         RBRK, AVT, P +1 more — these were ranked against
 *                         nothing and could not be picked.
 *
 *   11:30:00  INFO  Control  CONTROL FIRED on the 11:29 bar … the ranking
 *                            and the plan all answered.  found nothing on
 *                            the same bar, so what did not match is the
 *                            strategy's own rules, not the desk.
 *
 * Two different lies in the same minute.
 *
 * THE BAR. That run asked about 11:29. `Test` is a WATCH setup, 09:30-11:30,
 * and the warning was labelled from `setup.decidesOnBar` — the one bar its
 * window opens on, which never changes. So every gap all morning reported
 * 09:29, an hour and a half from where the problem was, and sent the reader to
 * the open to look for something that had just happened.
 *
 * THE NAME. A run carrying neither setupId nor setup mapped to `undefined`, and
 * join renders that as nothing — so the control published a claim about a
 * strategy it could not name, beside an identical line that named Test@09:30.
 * That is the one message whose whole job is to say WHICH side of the chain is
 * at fault.
 *
 * Both are the same fault as `source: 'end of session'` on every close: a field
 * that says the same thing whatever happened.
 */

const fs = require('fs');
const path = require('path');

const RUNNER = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'setups', 'runner.js'), 'utf8');

/** The file with its comments stripped — a test must not match its own prose. */
const code = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');

describe('the missing-bar warning names the bar that failed', () => {
  test('it is built from the bar this run was given', () => {
    expect(code(RUNNER)).toMatch(/detail: `No \$\{decisionBar \|\| lastWantedBar/);
  });

  /*
   * AND NOT FROM THE WINDOW'S FIRST BAR. decidesOnBar is a property of the
   * SETUP; the bar that failed is a property of the RUN.
   */
  test('and no longer from setup.decidesOnBar', () => {
    const c = code(RUNNER);
    const at = c.indexOf('bar for `');
    expect(at).toBeGreaterThan(-1);
    expect(c.slice(at - 120, at)).not.toMatch(/setup\.decidesOnBar/);
  });

  /*
   * A CLOCK SETUP IS UNCHANGED. It is given its own decidesOnBar as the bar, so
   * the label reads exactly as it always did — this fixes the watch case
   * without moving the one that was already right.
   */
  test('a clock setup still gets its own decision bar', () => {
    const c = code(RUNNER);
    expect(c).toMatch(/const decisionBar = bar\s*\n\s*\|\| \(rehearsal \? nowBarET\(\) : setup\.decidesOnBar \|\| setup\.decisionTime\)/);
  });

  test('the fallback is still there for a run given no bar at all', () => {
    expect(code(RUNNER)).toMatch(/decisionBar \|\| lastWantedBar\(setup\.decisionTime\)/);
  });
});

/* ── the control names the setups it is talking about ─────────────────────── */

describe('the control never claims something about a setup it cannot name', () => {
  const canary = require('../src/setups/canary');
  const control = { ok: true, bar: '11:29', feed: 'yahoo', lastBar: '11:29',
                    fired: true, symbols: ['SPY'] };

  const { verdict } = canary;

  test('a named quiet run is reported by name', () => {
    const v = verdict(control, [{ ok: true, picks: [], setupId: 'Test@09:30' }]);
    expect(v.detail).toMatch(/Test@09:30 found nothing on the same bar/);
  });

  /*
   * AN UNNAMED RUN PUBLISHES NOTHING. A sentence with a hole where the
   * strategy's name belongs is worse than no sentence: it reads as a verdict
   * about the rules while naming no rules.
   */
  test('an unnamed quiet run produces no line at all', () => {
    expect(verdict(control, [{ ok: true, picks: [] }])).toBeNull();
  });

  test('the named ones survive an unnamed one beside them', () => {
    const v = verdict(control, [
      { ok: true, picks: [] },
      { ok: true, picks: [], setupId: 'Test@09:30' },
    ]);
    expect(v.detail).toMatch(/Test@09:30 found nothing/);
    // and no empty slot where the other one would have been
    expect(v.detail).not.toMatch(/\s{2,}found nothing/);
    expect(v.detail).not.toMatch(/, {2}/);
  });

  test('a run that produced a pick is not called quiet', () => {
    expect(verdict(control, [{ ok: true, picks: ['PL'], setupId: 'Test@09:30' }]))
      .toBeNull();
  });

  test('a run that failed is not called quiet either', () => {
    expect(verdict(control, [{ ok: false, setupId: 'Test@09:30' }])).toBeNull();
  });
});
