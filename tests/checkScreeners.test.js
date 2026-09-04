/*
 * EVERY SCREENER, MEASURED — and the judgement that makes the measurement
 * worth reading.
 *
 * The screeners live in each tool's database, edited by hand. The probe asks
 * every live tool to validate and run each one; the part that can lie is the
 * JUDGEMENT over what comes back, so that is what is tested here against
 * fixtures — the network half cannot run in a test, and mocking it would only
 * prove the mock.
 *
 * The rule inherited from everywhere else on this desk: an error is never a
 * zero. A definition the tool REFUSES, a request TradingView refused, and a
 * screener that matched nothing are three different facts.
 */

const chk = require('../scripts/check-screeners');

const scr = (over = {}) => ({
  key: 'k', name: 'Screener', enabled: true, labelOnly: false, mirrorOf: null,
  runFrom: '09:30', runTo: '16:00', filters: 3, valid: true, count: 12,
  error: null, ms: 400, sample: ['AAA', 'BBB'], ...over,
});
const tool = (over = {}) => ({
  id: 'T2', name: 'Momentum', port: 3010, reachable: true, paused: false,
  pausedReason: null, uptimeSec: 3600,
  scan: { lastRun: NOW - 5 * 60000, lastRowCount: 12, error: null },
  screeners: [scr()], ...over,
});
/*
 * A FIXED FRIDAY. The judgement now asks whether the tools scan at this hour at
 * all — weekdays 04:00–16:00 — so a fixture built on `NOW` passes on a
 * Tuesday and fails on a Sunday, for reasons that have nothing to do with the
 * code. Every relative time below is measured from this instant.
 */
const NOW = Date.parse('2026-09-04T14:15:00Z');        // Friday, 10:15 ET
const AT = { hhmm: '10:15', now: NOW };

describe('a healthy tool has nothing said about it', () => {
  test('no problems', () => {
    expect(chk.problemsOf(tool(), AT)).toEqual([]);
  });
});

describe('the things a hand edit can break', () => {
  /*
   * THE ONE THIS EXISTS FOR. A filter with a field TradingView does not know
   * is rejected on every scan, silently, and the tool looks like a tool whose
   * setup did not occur today.
   */
  test('a definition the tool REJECTS is named, with the reason', () => {
    const out = chk.problemsOf(tool({ screeners: [scr({ valid: false, count: null,
      error: 'filter 2: unknown field "prce"' })] }), AT);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatch(/REJECTED by the tool: filter 2: unknown field "prce"/);
    expect(out[0]).toMatch(/producing nothing on every scan/);
  });

  test('a mirror of a screener that was deleted is named', () => {
    const out = chk.problemsOf(tool({ screeners: [
      scr({ name: 'Trend' }),
      scr({ name: 'Trend (mirror)', mirrorOf: 'Gone' }),
    ] }), AT);
    expect(out.join(' ')).toMatch(/mirrors "Gone", which no longer exists/);
  });

  test('every screener switched off is a tool that collects nothing', () => {
    const out = chk.problemsOf(tool({ screeners: [scr({ enabled: false }), scr({ enabled: false })],
                                      scan: null }), AT);
    expect(out.join(' ')).toMatch(/every one of its 2 screener\(s\) is switched off/);
  });

  test('no screeners at all', () => {
    expect(chk.problemsOf(tool({ screeners: [], scan: null }), AT).join(' '))
      .toMatch(/NO screeners at all/);
  });

  test('a screener with no filters is only the floor', () => {
    expect(chk.problemsOf(tool({ screeners: [scr({ filters: 0 })] }), AT).join(' '))
      .toMatch(/has no filters/);
  });
});

describe('zero, refused, and not asked are three different facts', () => {
  test('zero inside its window points at why-empty', () => {
    const out = chk.problemsOf(tool({ screeners: [scr({ count: 0 })] }), AT);
    expect(out.join(' ')).toMatch(/matches nothing right now, inside its window \(09:30–16:00\)/);
    expect(out.join(' ')).toMatch(/why-empty\.js k/);
  });

  /*
   * A ZERO OUTSIDE ITS WINDOW IS NOT A FINDING. A pre-market screener at 10:15
   * has nothing to match by design — reporting it would teach the reader to
   * ignore the list.
   */
  test('zero outside its window is not a problem', () => {
    const out = chk.problemsOf(tool({ screeners: [scr({ count: 0, runFrom: '04:00', runTo: '09:30' })] }), AT);
    expect(out).toEqual([]);
  });

  test('TradingView refusing the request is an error, never a zero', () => {
    const out = chk.problemsOf(tool({ screeners: [scr({ count: null, error: 'HTTP 429' })] }), AT);
    expect(out.join(' ')).toMatch(/could not be run: HTTP 429/);
    expect(out.join(' ')).not.toMatch(/matches nothing/);
  });

  test('a screener switched off is not run, and not judged', () => {
    const out = chk.problemsOf(tool({ screeners: [scr(), scr({ enabled: false, count: null })] }), AT);
    expect(out).toEqual([]);
  });
});

describe('the tool itself', () => {
  test('a tool that does not answer is one line, and nothing else is guessed', () => {
    const out = chk.problemsOf({ id: 'T6', reachable: false, error: 'ECONNREFUSED', screeners: [] }, AT);
    expect(out).toEqual(['T6: did not answer (ECONNREFUSED) — is it running?']);
  });

  test('paused is said as a choice, not a fault', () => {
    const out = chk.problemsOf(tool({ paused: true, pausedReason: 'testing' }), AT);
    expect(out.join(' ')).toMatch(/is PAUSED — testing/);
  });

  test('a failed last scan is named', () => {
    const out = chk.problemsOf(tool({ scan: { lastRun: NOW, lastRowCount: 0, error: 'TV 503' } }), AT);
    expect(out.join(' ')).toMatch(/last scan FAILED: TV 503/);
  });

  test('a card list older than half an hour during the session is a finding', () => {
    const out = chk.problemsOf(tool({ scan: { lastRun: NOW - 45 * 60000, lastRowCount: 9, error: null } }), AT);
    expect(out.join(' ')).toMatch(/45 minutes old during the session/);
  });

  test('...and the same age outside the session is not', () => {
    const out = chk.problemsOf(tool({ scan: { lastRun: NOW - 45 * 60000, lastRowCount: 9, error: null } }),
      { hhmm: '17:00', now: NOW });
    expect(out).toEqual([]);
  });

  test('a scan that produced no cards is said in terms of what it costs', () => {
    const out = chk.problemsOf(tool({ scan: { lastRun: NOW, lastRowCount: 0, error: null } }), AT);
    expect(out.join(' ')).toMatch(/NO cards — a setup on this tool has nothing to rank/);
  });

  test('never scanned is not the same as scanned and found nothing', () => {
    const out = chk.problemsOf(tool({ scan: { lastRun: null, lastRowCount: null, error: null } }), AT);
    expect(out.join(' ')).toMatch(/never completed a scan/);
    expect(out.join(' ')).not.toMatch(/NO cards/);
  });

  /*
   * JUST STARTED IS NOT BROKEN. The first run of this check, straight after a
   * deploy, reported all six tools as "never scanned, no cards" — true, and a
   * finding about nothing: the registry is in memory and the next scan had
   * not happened yet. Twelve lines of noise around the two that mattered.
   */
  test('a tool up for a minute with no scan yet is NOT a problem', () => {
    const out = chk.problemsOf(tool({ uptimeSec: 70,
      scan: { lastRun: null, lastRowCount: 0, error: null } }), AT);
    expect(out).toEqual([]);
  });

  test('...but after ten minutes it is', () => {
    const out = chk.problemsOf(tool({ uptimeSec: 900,
      scan: { lastRun: null, lastRowCount: 0, error: null } }), AT);
    expect(out.join(' ')).toMatch(/never completed a scan/);
    expect(chk.JUST_STARTED_SEC).toBe(600);
  });

  test('a tool that does not report uptime is judged as before', () => {
    const out = chk.problemsOf(tool({ uptimeSec: null,
      scan: { lastRun: null, lastRowCount: 0, error: null } }), AT);
    expect(out.join(' ')).toMatch(/never completed a scan/);
  });
});

/*
 * A MIRROR IS THE OPPOSITE SETUP. One returning its base's own names is the
 * same screen twice under two labels — the pair then tests one side twice and
 * the direction question it exists for is never asked. Judged on the NAMES:
 * two opposite screens can match seven each; they cannot match the same seven.
 */
describe('a mirror that is not a mirror', () => {
  test('the same names as its base is called out, with the names', () => {
    const out = chk.problemsOf(tool({ screeners: [
      scr({ name: 'Move', count: 7, sample: ['A', 'B', 'C'] }),
      scr({ name: 'Move (mirror)', mirrorOf: 'Move', count: 7, sample: ['C', 'A', 'B'] }),
    ] }), AT);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatch(/returns the SAME names as "Move" \(A, B, C\)/);
  });

  test('the same COUNT with different names is fine', () => {
    const out = chk.problemsOf(tool({ screeners: [
      scr({ name: 'Move', count: 7, sample: ['A', 'B', 'C'] }),
      scr({ name: 'Move (mirror)', mirrorOf: 'Move', count: 7, sample: ['X', 'Y', 'Z'] }),
    ] }), AT);
    expect(out).toEqual([]);
  });

  test('nothing is said when either side returned no names', () => {
    const out = chk.problemsOf(tool({ screeners: [
      scr({ name: 'Move', count: 0, sample: [], runFrom: '04:00', runTo: '09:00' }),
      scr({ name: 'Move (mirror)', mirrorOf: 'Move', count: 0, sample: [], runFrom: '04:00', runTo: '09:00' }),
    ] }), AT);
    expect(out).toEqual([]);
  });
});

describe('the probe reduces each tool to plain facts', () => {
  /** A fake tool that answers the four endpoints. */
  const fakeFetch = (answers) => async (url, init) => {
    const p = new URL(url).pathname;
    if (init && init.method === 'POST') {
      const body = JSON.parse(init.body);
      const a = answers.test[body.name];
      return a || { status: 500, json: { ok: false, error: 'no fixture' }, error: null };
    }
    return answers[p] || { status: 404, json: null, error: null };
  };

  test('a rejected definition comes back valid:false with the tool\'s reason', async () => {
    const t = await chk.probeTool({ id: 'T2', name: 'Momentum', port: 3010 }, {
      fetchJson: fakeFetch({
        '/api/tool': { status: 200, json: { ok: true, paused: false }, error: null },
        '/api/scan/status': { status: 200, json: { lastRun: 1, lastRowCount: 3 }, error: null },
        '/api/screeners': { status: 200, json: { ok: true, screeners: [
          { key: 'a', name: 'Good', enabled: true, filters: [{}], sort: {}, limit: 20 },
          { key: 'b', name: 'Bad', enabled: true, filters: [{}], sort: {}, limit: 20 },
          { key: 'c', name: 'Off', enabled: false, filters: [{}] },
        ] }, error: null },
        test: {
          Good: { status: 200, json: { ok: true, count: 7, ms: 300 }, error: null },
          Bad: { status: 400, json: { ok: false, error: 'filter 1: unknown field "x"' }, error: null },
        },
      }),
    });
    expect(t.reachable).toBe(true);
    const by = Object.fromEntries(t.screeners.map(s => [s.name, s]));
    expect(by.Good).toMatchObject({ valid: true, count: 7 });
    expect(by.Bad).toMatchObject({ valid: false, error: 'filter 1: unknown field "x"' });
    // a screener switched off is not run — no request, nothing to judge
    expect(by.Off).toMatchObject({ enabled: false, valid: null, count: null });
  });

  test('a tool that does not answer is unreachable, and nothing else is asked', async () => {
    let asked = 0;
    const t = await chk.probeTool({ id: 'T6', name: 'X', port: 3050 }, {
      fetchJson: async () => { asked += 1; return { status: null, json: null, error: 'ECONNREFUSED' }; },
    });
    expect(t.reachable).toBe(false);
    expect(t.error).toBe('ECONNREFUSED');
    expect(asked).toBe(1);
  });

  test('a request that never answered is an error on the row, not a zero', async () => {
    const t = await chk.probeTool({ id: 'T2', name: 'M', port: 3010 }, {
      fetchJson: fakeFetch({
        '/api/tool': { status: 200, json: { ok: true }, error: null },
        '/api/scan/status': { status: 200, json: {}, error: null },
        '/api/screeners': { status: 200, json: { screeners: [
          { key: 'a', name: 'Slow', enabled: true, filters: [{}] }] }, error: null },
        test: { Slow: { status: null, json: null, error: 'timeout' } },
      }),
    });
    expect(t.screeners[0]).toMatchObject({ valid: null, count: null, error: 'timeout' });
  });
});

describe('the window rule', () => {
  test('no window means always open', () => {
    expect(chk.windowOpen({}, '03:00')).toBe(true);
  });
  test('inside and outside', () => {
    const s = { runFrom: '09:30', runTo: '16:00' };
    expect(chk.windowOpen(s, '09:30')).toBe(true);
    expect(chk.windowOpen(s, '15:59')).toBe(true);
    expect(chk.windowOpen(s, '16:00')).toBe(false);
    expect(chk.windowOpen(s, '09:29')).toBe(false);
  });
});

/*
 * OUTSIDE SCANNING HOURS, AN IDLE TOOL IS DOING AS IT WAS TOLD.
 *
 * The discovery jobs run 04:00–16:00 ET on weekdays and the card registry is
 * in memory, so after the close a tool has no scan and no cards by
 * construction. Run at 17:48 on a Friday, the first version of this check
 * called four tools "never scanned" and six "no cards" — ten lines of alarm
 * about a desk that was working, around the one line that mattered.
 */
describe('the market being shut is not a fault', () => {
  const FRI_EVENING = { hhmm: '17:48', now: Date.parse('2026-09-04T21:48:00Z') };
  const FRI_MIDDAY = { hhmm: '11:00', now: Date.parse('2026-09-04T15:00:00Z') };
  const idle = () => tool({ uptimeSec: 7200,
    scan: { lastRun: null, lastRowCount: 0, error: null },
    screeners: [scr({ count: 0, sample: [] })] });

  test('after the close: no scan, no cards, no zero-match — nothing is said', () => {
    expect(chk.problemsOf(idle(), FRI_EVENING)).toEqual([]);
  });

  test('...but the same tool at eleven in the morning is a real finding', () => {
    const out = chk.problemsOf(idle(), FRI_MIDDAY).join(' ');
    expect(out).toMatch(/never completed a scan/);
    expect(out).toMatch(/NO cards/);
    expect(out).toMatch(/matches nothing right now/);
  });

  test('a scan that FAILED is still reported after hours — an error is not idleness', () => {
    const out = chk.problemsOf(tool({ uptimeSec: 7200,
      scan: { lastRun: NOW, lastRowCount: 0, error: 'TV 503' } }), FRI_EVENING);
    expect(out.join(' ')).toMatch(/last scan FAILED: TV 503/);
  });

  test('a REJECTED definition is still reported after hours — it is broken at any hour', () => {
    const out = chk.problemsOf(tool({ uptimeSec: 7200,
      screeners: [scr({ valid: false, count: null, error: 'unknown field "prce"' })] }),
    FRI_EVENING);
    expect(out.join(' ')).toMatch(/REJECTED by the tool/);
  });

  test('scanning hours are the scheduler\'s own: weekdays, 04:00 to 16:00', () => {
    const fri = new Date('2026-09-04T15:00:00Z');
    const sat = new Date('2026-09-05T15:00:00Z');
    expect(chk.scanningHours('04:00', fri)).toBe(true);
    expect(chk.scanningHours('15:59', fri)).toBe(true);
    expect(chk.scanningHours('16:00', fri)).toBe(false);
    expect(chk.scanningHours('03:59', fri)).toBe(false);
    // A Saturday scans at no hour at all.
    expect(chk.scanningHours('11:00', sat)).toBe(false);
  });
});

/*
 * THE PAGE IS NOT THE POPULATION. A screener asks TradingView for a page of
 * rows, so the row count saturates at the limit: a rule matching four thousand
 * stocks and one matching fifty both come back "50 live". The probe ladder read
 * that way reported "97" for six different filters — arithmetically correct,
 * about a question nobody asked.
 */
describe('how many matched, not how many were fetched', () => {
  test('the table shows both when they differ', () => {
    const lines = chk.table(tool({ screeners: [scr({ count: 50, totalCount: 4021 })] }), '11:00');
    expect(lines.join('\n')).toMatch(/50 live of 4021 matched/);
  });

  test('and only one when they do not', () => {
    const lines = chk.table(tool({ screeners: [scr({ count: 7, totalCount: 7 })] }), '11:00');
    expect(lines.join('\n')).toMatch(/7 live(?! of)/);
  });

  test('a tool that does not report a total still renders', () => {
    const lines = chk.table(tool({ screeners: [scr({ count: 7, totalCount: null })] }), '11:00');
    expect(lines.join('\n')).toMatch(/7 live/);
  });
});
