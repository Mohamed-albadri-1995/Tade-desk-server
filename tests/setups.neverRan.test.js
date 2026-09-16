/*
 * A SETUP THAT WAS NEVER ASKED MUST NOT READ AS ONE THAT FOUND NOTHING.
 *
 * 2026-09-16. The whole day's log holds exactly one row for the 09:35 OR+VWAP
 * setup — a rehearsal at 09:25, pressed by hand:
 *
 *   {"at":1789565118089,"date":"2026-09-16","kind":"run",
 *    "setupId":"OR + VWAP 09:35@09:35","bar":"09:25","ok":true,"dryRun":true}
 *
 * Nothing at 09:34, its only decision bar of the day. Not "no cards on the
 * list", not "nothing qualified", not a failed run — nothing at all. Meanwhile
 * the Test setup ran 126 times from 09:29, so the desk was up.
 *
 * `runSetup` writes a row even when the decision THROWS — deliberately, so a
 * failure can never be silent. An absent row therefore means one thing: it was
 * never called. And it was never called because the process that calls it was
 * dead. A setup's decision is scheduled inside the tool that owns it, and that
 * morning:
 *
 *   │ 240 │ tool-T2  │ fork │ 292 │ online │
 *
 * 292 restarts, against 0 for every other tool. A crash-looping owner takes
 * its setups' entire trading day with it.
 *
 * AND THE DAY READ AS QUIET. `summaryOf` was keyed on the rows that exist, so
 * a setup that never ran was simply absent from the summary — which on the
 * page is indistinguishable from a setup that ran and matched nothing. The
 * same blank for the morning the desk was down and the morning the market was
 * dull. A silence read as a pass, on the setup that makes the money.
 *
 * It cannot know WHY, and it does not guess. It says the setup was due, names
 * the bar, and names the tool that owed the answer.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

let DIR;
let log;

beforeEach(() => {
  DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'never-ran-'));
  process.env.SESSION_LOG_DIR = DIR;
  jest.resetModules();
  log = require('../src/setups/sessionLog');
});

afterEach(() => {
  delete process.env.SESSION_LOG_DIR;
  fs.rmSync(DIR, { recursive: true, force: true });
});

const DATE = '2026-09-16';

/** The two setups of that morning, as catalog.list() reports them. */
const VWAP = {
  id: 'OR + VWAP 09:35@09:35', name: 'OR + VWAP 09:35',
  decisionTime: '09:35', decidesOnBar: '09:34', tools: ['T2'], enabled: true,
};
const TEST = {
  id: 'Test@09:30', name: 'Test',
  decisionTime: '09:30', decidesOnBar: '09:29', tools: ['T10', 'T11'], enabled: true,
};

/** Noon ET on the day itself — both bars long past. */
const NOON = Date.parse('2026-09-16T12:00:00-04:00');

function wrote(over = {}) {
  log.record(log.runOf({
    at: NOON, date: DATE, setupId: TEST.id, setupName: TEST.name,
    bar: '09:29', ok: true, ...over,
  }));
}

describe('a setup that was due and wrote nothing', () => {
  /*
   * THE ONE THAT WAS BROKEN. Before this, `summaryOf(DATE)` returned an object
   * with one key — Test — and the 09:35 setup appeared nowhere on the page.
   */
  test('appears in the summary at all', () => {
    wrote();
    const s = log.summaryOf(DATE, [VWAP, TEST], NOON);
    expect(Object.keys(s).sort()).toEqual([TEST.id, VWAP.id].sort());
  });

  test('is marked as never having run, not as having run zero times usefully', () => {
    wrote();
    const g = log.summaryOf(DATE, [VWAP, TEST], NOON)[VWAP.id];
    expect(g.neverRan).toBe(true);
    expect(g.runs).toBe(0);
  });

  test('names the bar it was due on', () => {
    const g = log.summaryOf(DATE, [VWAP], NOON)[VWAP.id];
    expect(g.dueBar).toBe('09:34');
  });

  /*
   * THE TOOL IS THE WHOLE LEAD. "The setup did not run" sends you nowhere;
   * "T2 owed this answer" sends you to `pm2 list`, where the 292 restarts are.
   */
  test('names the tool that owed the answer', () => {
    const g = log.summaryOf(DATE, [VWAP], NOON)[VWAP.id];
    expect(g.tools).toEqual(['T2']);
    expect(g.problems.join(' ')).toMatch(/T2/);
  });

  test('says NEVER RAN in words, where the other problems are', () => {
    const g = log.summaryOf(DATE, [VWAP], NOON)[VWAP.id];
    expect(g.problems.length).toBe(1);
    expect(g.problems[0]).toMatch(/NEVER RAN/);
  });

  /*
   * AND IT SAYS WHAT IT IS NOT. The failure being prevented is a reader
   * concluding "nothing qualified", so the sentence rules that out by name.
   */
  test('rules out the reading it exists to prevent', () => {
    const g = log.summaryOf(DATE, [VWAP], NOON)[VWAP.id];
    expect(g.problems[0]).toMatch(/not "nothing qualified"/);
  });
});

describe('a setup that DID run is untouched', () => {
  test('it is not marked, and keeps its own counts', () => {
    wrote({ counts: { evaluated: 39, signalled: 2 } });
    const g = log.summaryOf(DATE, [VWAP, TEST], NOON)[TEST.id];
    expect(g.neverRan).toBeUndefined();
    expect(g.runs).toBe(1);
    expect(g.evaluated).toBe(39);
  });

  /*
   * A RUN THAT FAILED IS A RUN. It wrote a line saying so, which is the
   * opposite of the case here, and collapsing the two would lose the
   * distinction that makes either worth reading.
   */
  test('a failed run is not "never ran"', () => {
    wrote({ setupId: VWAP.id, setupName: VWAP.name, bar: '09:34',
            ok: false, error: 'qp gave no reason' });
    const g = log.summaryOf(DATE, [VWAP], NOON)[VWAP.id];
    expect(g.neverRan).toBeUndefined();
    expect(g.runs).toBe(1);
    expect(g.failed).toBe(1);
  });

  /*
   * A QUIET RUN IS A RUN. "It looked and found nothing" is exactly the reading
   * that must stay available for the setups that really did look.
   */
  test('a quiet run is not "never ran"', () => {
    wrote({ setupId: VWAP.id, bar: '09:34', quiet: true });
    const g = log.summaryOf(DATE, [VWAP], NOON)[VWAP.id];
    expect(g.neverRan).toBeUndefined();
    expect(g.quiet).toBe(1);
  });
});

describe('a rehearsal is not a run', () => {
  /*
   * THIS IS THE 09-16 ROW ITSELF. A rehearsal is a check of the machine, taken
   * on the current minute and publishing nothing — summaryOf already excludes
   * them from the counts, and if it counted as the day's run the setup would
   * have looked like it ran on a morning it did not.
   */
  test('the hand-pressed 09:25 rehearsal does not cover the 09:34 decision', () => {
    wrote({ setupId: VWAP.id, setupName: VWAP.name, bar: '09:25',
            dryRun: true, rehearsal: true });
    const g = log.summaryOf(DATE, [VWAP], NOON)[VWAP.id];
    expect(g.neverRan).toBe(true);
    expect(g.dueBar).toBe('09:34');
  });
});

describe('what is not yet late is not missing', () => {
  /*
   * AN ERROR IS NEVER A ZERO, and neither is an appointment that has not come
   * round yet. Flagging a setup at 09:00 for a bar it reaches at 09:34 would
   * put a red line on the page every single morning, and a warning that is
   * always there is a warning nobody reads.
   */
  test('a bar still ahead of now is not reported', () => {
    const NINE = Date.parse('2026-09-16T09:00:00-04:00');
    expect(log.summaryOf(DATE, [VWAP], NINE)[VWAP.id]).toBeUndefined();
  });

  test('but one minute past it is', () => {
    const LATER = Date.parse('2026-09-16T09:35:00-04:00');
    expect(log.summaryOf(DATE, [VWAP], LATER)[VWAP.id].neverRan).toBe(true);
  });

  test('a whole day in the past is entirely late', () => {
    const NEXT = Date.parse('2026-09-17T09:00:00-04:00');
    expect(log.summaryOf(DATE, [VWAP], NEXT)[VWAP.id].neverRan).toBe(true);
  });

  test('a future date reports nothing missing', () => {
    const NEXT = Date.parse('2026-09-17T09:00:00-04:00');
    expect(log.missingOn('2026-09-18', [VWAP], NEXT)).toEqual([]);
  });

  test('a switched-off setup had no appointment to miss', () => {
    expect(log.missingOn(DATE, [{ ...VWAP, enabled: false }], NOON)).toEqual([]);
  });

  test('a setup with no decision bar is not late for one', () => {
    expect(log.missingOn(DATE, [{ id: 'x', name: 'x' }], NOON)).toEqual([]);
  });
});

describe('the reader never depends on it', () => {
  /*
   * THE LOG IS THE POINT AND THE CATALOG IS THE EXTRA. This page is opened
   * BECAUSE something went wrong, so a setup list that cannot be read must
   * cost the missing-setup line and nothing else.
   */
  test('no catalog means the old summary, not an exception', () => {
    wrote();
    const s = log.summaryOf(DATE);
    expect(Object.keys(s)).toEqual([TEST.id]);
  });

  test('a null catalog is the same as none', () => {
    wrote();
    expect(Object.keys(log.summaryOf(DATE, null))).toEqual([TEST.id]);
  });

  /*
   * NULL IS NEVER FALSE, and a junk entry is not a due setup. A catalog with a
   * hole in it must not crash the log reader.
   */
  test('junk in the setup list is skipped rather than thrown on', () => {
    expect(() => log.summaryOf(DATE, [null, undefined, VWAP], NOON)).not.toThrow();
    expect(log.summaryOf(DATE, [null, VWAP], NOON)[VWAP.id].neverRan).toBe(true);
  });

  test('an empty day with a due setup still reports it', () => {
    const s = log.summaryOf(DATE, [VWAP, TEST], NOON);
    expect(s[VWAP.id].neverRan).toBe(true);
    expect(s[TEST.id].neverRan).toBe(true);
  });
});
