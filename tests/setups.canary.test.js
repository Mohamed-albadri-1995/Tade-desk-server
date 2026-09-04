/*
 * THE CONTROL — telling "the chain is broken" apart from "the rules did not
 * match".
 *
 * A setup takes nothing and there are two entirely different reasons for it.
 * From the outside they produce the same sentence, "nothing qualified", and
 * until this existed nothing on the desk could tell them apart — which is why
 * a week went by with zero orders and four separate causes.
 *
 * So a second strategy is asked the same question, on the SAME bar, over the
 * same cards, through the same feed, with a rule true of every bar that
 * exists. The whole value is in the pairing, and these check the pairing.
 *
 * That the strategy itself really does fire on every bar is checked where it
 * can actually be executed — quant-platform/chart/tests/logic_audit63.py drives
 * the shipped spec through qp's engine. A substring search here could only
 * confirm the spec is spelt the way I spelt it.
 */

const canary = require('../src/setups/canary');

const answer = (over = {}) => ({
  ok: true,
  last_bar: '09:34',
  counts: { evaluated: 5, signalled: 5, errored: 0 },
  picks: [{ symbol: 'AAA', entry_at: '09:34', entry: 10, stop: 9.99, target: 10.02 }],
  ...over,
});

const decideWith = (out) => () => Promise.resolve(out);
const rows = (...t) => t.map(ticker => ({ ticker }));

beforeEach(() => canary._reset());

/* ── when it runs ────────────────────────────────────────────────────────── */

describe('it runs every five minutes, and on any bar a setup decided', () => {
  test('a five-minute mark is due', () => {
    for (const t of ['09:00', '09:05', '09:35', '15:55']) {
      expect({ t, due: canary.due(t, false) }).toEqual({ t, due: true });
    }
  });

  test('a minute in between is not', () => {
    for (const t of ['09:01', '09:34', '09:36']) {
      expect({ t, due: canary.due(t, false) }).toEqual({ t, due: false });
    }
  });

  /*
   * THE HALF THAT MATTERS. A control that only ran on the cadence would miss
   * the exact bar a setup decided whenever the two did not line up — and that
   * bar is the only one anybody asks about afterwards.
   */
  test('a bar a setup just decided is ALWAYS due, cadence or not', () => {
    expect(canary.due('09:36', true)).toBe(true);
    expect(canary.due('10:07', true)).toBe(true);
  });
});

/* ── what it asks about ──────────────────────────────────────────────────── */

describe('what it asks, and of whom', () => {
  test('a handful of the tool\'s own cards, not the whole list', () => {
    const many = rows('E', 'D', 'C', 'B', 'A', 'F', 'G');
    const { symbols, fromCards } = canary.symbolsFor(many);
    expect(symbols).toHaveLength(canary.MAX_SYMBOLS);
    expect(fromCards).toBe(true);
    // Sorted, so two runs a minute apart ask about the same names and a
    // difference between them is a fact about the market, not about ordering.
    expect(symbols).toEqual(['A', 'B', 'C', 'D', 'E']);
  });

  /*
   * NO CARDS IS ITSELF A FINDING — the real setup would have nothing to rank
   * either — but it must not also blind the control to the qp hop. It falls
   * back to one liquid name and SAYS it fell back, so the two facts stay apart.
   */
  test('with no cards it falls back to one liquid name, and says so', () => {
    expect(canary.symbolsFor([])).toEqual(
      { symbols: canary.FALLBACK_SYMBOLS, fromCards: false });
  });

  /*
   * THE SAME FEED THE SETUPS USE, or it is answering about a different market:
   * a control on a live feed while the setup runs on a delayed one fires every
   * time and proves the opposite of what it claims.
   */
  test('it uses the feed the real setups use', () => {
    expect(canary.feedFor([{ liveFeed: 'alpaca' }])).toBe('alpaca');
    expect(canary.feedFor([{}, { feed: 'polygon' }])).toBe('polygon');
  });

  test('...and yahoo only when nothing names one — the desk\'s own default', () => {
    expect(canary.feedFor([])).toBe('yahoo');
  });

  test('one attempt and a short budget: a timeout IS the finding', async () => {
    const seen = [];
    await canary.run({ bar: '09:34', day: '2026-09-04', rows: rows('AAA'),
                       deps: { decide: (o) => { seen.push(o); return Promise.resolve(answer()); } } });
    expect(seen[0].attempts).toBe(1);
    expect(seen[0].timeoutMs).toBe(canary.TIMEOUT_MS);
    // …and it sends the strategy inline, so there is nothing to build in qp
    // and nothing that can be edited into something that no longer fires.
    expect(seen[0].strategies).toEqual([canary.SPEC]);
    expect(seen[0].strategyId).toBeUndefined();
  });
});

/* ── firing means firing ON THIS BAR ─────────────────────────────────────── */

describe('"fired" means on the bar it asked about', () => {
  test('a pick on the asked bar is a fire', async () => {
    const r = await canary.run({ bar: '09:34', day: '2026-09-04', rows: rows('AAA'),
                                 deps: { decide: decideWith(answer()) } });
    expect(r.fired).toBe(true);
    expect(r.lagMin).toBe(0);
  });

  test('one bar of tolerance, the same the runner allows a real pick', async () => {
    const r = await canary.run({ bar: '09:34', day: '2026-09-04', rows: rows('AAA'),
      deps: { decide: decideWith(answer({ last_bar: '09:33',
        picks: [{ symbol: 'AAA', entry_at: '09:33' }] })) } });
    expect(r.fired).toBe(true);
  });

  /*
   * THE FAILURE THIS IS BUILT AGAINST. qp re-reports every entry of the session
   * on every call, so a signal from 09:31 comes back at 14:00 as well. Counting
   * that as the control firing would report a working chain off a five-hour-old
   * bar — the exact class of wrong answer the desk keeps producing.
   */
  test('a signal from hours ago is NOT this bar firing', async () => {
    const r = await canary.run({ bar: '14:00', day: '2026-09-04', rows: rows('AAA'),
      deps: { decide: decideWith(answer({ last_bar: '13:45',
        picks: [{ symbol: 'AAA', entry_at: '09:31' }] })) } });
    expect(r.fired).toBe(false);
  });

  test('it measures how far behind the feed was', async () => {
    const r = await canary.run({ bar: '14:00', day: '2026-09-04', rows: rows('AAA'),
      deps: { decide: decideWith(answer({ last_bar: '13:45', picks: [] })) } });
    expect(r.lagMin).toBe(15);
  });

  test('qp not answering is recorded, not thrown', async () => {
    const r = await canary.run({ bar: '09:34', day: '2026-09-04', rows: rows('AAA'),
      deps: { decide: () => Promise.reject(new Error('timeout of 12000ms exceeded')) } });
    expect(r.ok).toBe(false);
    expect(r.fired).toBe(false);
    expect(r.error).toMatch(/timeout of 12000ms/);
  });
});

/* ── the verdict, which is the whole point ───────────────────────────────── */

describe('the sentence it puts on the feed', () => {
  const quietRun = { setupId: 'OR + VWAP 09:35', picks: [], ok: true };
  const tookRun = { setupId: 'OR + VWAP 09:35', picks: [{ ticker: 'GEO' }], ok: true };

  /*
   * THE ANSWER THE WHOLE THING EXISTS FOR: the chain worked on this bar, so a
   * setup that took nothing did not match its own rules. Before this, both
   * halves of that sentence were unknown.
   */
  test('control fired, setup did not → it is the strategy\'s rules', async () => {
    const c = await canary.run({ bar: '09:34', day: '2026-09-04', rows: rows('AAA'),
                                 deps: { decide: decideWith(answer()) } });
    const v = canary.verdict(c, [quietRun]);
    expect(v.level).toBe('info');
    expect(v.detail).toMatch(/CONTROL FIRED on the 09:34 bar/);
    expect(v.detail).toMatch(/OR \+ VWAP 09:35 found nothing/);
    expect(v.detail).toMatch(/the strategy's own rules, not the desk/);
  });

  test('nothing to say when the setup took the trade', async () => {
    const c = await canary.run({ bar: '09:34', day: '2026-09-04', rows: rows('AAA'),
                                 deps: { decide: decideWith(answer()) } });
    expect(canary.verdict(c, [tookRun])).toBeNull();
  });

  /*
   * THE DELAYED FEED, NAMED. This is what fifteen minutes behind looks like
   * from the inside: qp answers, the answer is about a bar from a quarter of an
   * hour ago, and nothing can fire on the bar being asked about — the control
   * included. It is the most likely reason a clock setup takes nothing and it
   * produced exactly the same silence a quiet market does.
   */
  test('neither fired and the feed was behind → it is the feed, in words',
    async () => {
      const c = await canary.run({ bar: '09:34', day: '2026-09-04', rows: rows('AAA'),
        deps: { decide: decideWith(answer({ last_bar: '09:19', picks: [] })) } });
      const v = canary.verdict(c, [quietRun]);
      expect(v.level).toBe('warn');
      expect(v.detail).toMatch(/CONTROL DID NOT FIRE on the 09:34 bar/);
      expect(v.detail).toMatch(/newest bar .* was 09:19, 15 minutes behind/);
      expect(v.detail).toMatch(/including any setup deciding on it/);
      expect(v.detail).toMatch(/This is the feed, not the rules/);
    });

  test('qp not answering is reported as the platform, not as a strategy',
    async () => {
      const c = await canary.run({ bar: '09:34', day: '2026-09-04', rows: rows('AAA'),
        deps: { decide: () => Promise.reject(new Error('ECONNREFUSED')) } });
      const v = canary.verdict(c, [quietRun]);
      expect(v.level).toBe('error');
      expect(v.detail).toMatch(/CONTROL DID NOT ANSWER/);
      expect(v.detail).toMatch(/decided blind or not at all/);
    });

  /*
   * A current feed and no control signal is the odd one out, and it must not be
   * described as either of the other two. It means the bars for those symbols
   * were not there at all.
   */
  test('a current feed with no control signal blames the chain, not the feed',
    async () => {
      const c = await canary.run({ bar: '09:34', day: '2026-09-04', rows: rows('AAA'),
        deps: { decide: decideWith(answer({ last_bar: '09:34', picks: [] })) } });
      const v = canary.verdict(c, [quietRun]);
      expect(v.detail).toMatch(/although yahoo was current/);
      expect(v.detail).toMatch(/chain rather than any strategy/);
    });

  test('a setup that FAILED is not counted as one that found nothing', async () => {
    // A crash and a quiet bar are different facts, and a verdict that folded
    // them together would blame the rules for a timeout.
    const c = await canary.run({ bar: '09:34', day: '2026-09-04', rows: rows('AAA'),
                                 deps: { decide: decideWith(answer()) } });
    expect(canary.verdict(c, [{ setupId: 'X', ok: false, error: 'boom' }])).toBeNull();
  });
});

/* ── the tick: it publishes changes, not states ──────────────────────────── */

describe('it does not become the loudest thing on the feed', () => {
  const store = () => ({ out: [], publishFires(f) { this.out.push(...f); } });

  const tick = (bar, alertStore, out, ran = [{ setupId: 'S', picks: [], ok: true }]) =>
    canary.tick({ now: bar, bar, day: '2026-09-04', rows: rows('AAA'), ran,
                  deps: { alertStore, decide: decideWith(out) } });

  test('it says nothing at all when it is not due', async () => {
    const s = store();
    const r = await canary.tick({ now: '09:31', bar: '09:30', day: '2026-09-04',
      rows: rows('AAA'), ran: [], deps: { alertStore: s, decide: decideWith(answer()) } });
    expect(r).toBeNull();
    expect(s.out).toEqual([]);
  });

  test('the first failure is published', async () => {
    const s = store();
    await tick('09:35', s, answer({ last_bar: '09:20', picks: [] }));
    expect(s.out).toHaveLength(1);
    expect(s.out[0].level).toBe('warn');
  });

  /*
   * A CONTROL THAT REPEATED ITSELF every five minutes would be the loudest
   * thing on the feed within an hour, and then it would be the thing nobody
   * reads — which is how the one message that mattered gets missed.
   */
  test('the same failure again says nothing', async () => {
    const s = store();
    await tick('09:35', s, answer({ last_bar: '09:20', picks: [] }));
    await tick('09:40', s, answer({ last_bar: '09:25', picks: [] }));
    expect(s.out).toHaveLength(1);
  });

  test('but a recovery, and the next failure after it, are both news', async () => {
    const s = store();
    await tick('09:35', s, answer({ last_bar: '09:20', picks: [] }));
    await tick('09:40', s, answer({ last_bar: '09:39',
      picks: [{ symbol: 'AAA', entry_at: '09:39' }] }));      // recovered
    await tick('09:45', s, answer({ last_bar: '09:30', picks: [] }));   // broke again
    expect(s.out).toHaveLength(3);
    expect(s.out.map(f => f.level)).toEqual(['warn', 'info', 'warn']);
  });

  test('every line is tagged as the control, never as a real setup', async () => {
    const s = store();
    await tick('09:35', s, answer({ last_bar: '09:20', picks: [] }));
    expect(s.out[0].ruleId).toBe('__control__');
    expect(s.out[0].ticker).toBeNull();
  });

  test('a broken alert store does not take the control — or the tick — down',
    async () => {
      const bad = { publishFires() { throw new Error('disk full'); } };
      await expect(tick('09:35', bad, answer({ last_bar: '09:20', picks: [] })))
        .resolves.toBeTruthy();
    });
});

/* ── the day's memory, and the wiring ────────────────────────────────────── */

describe('the pairing is per bar', () => {
  test('what the control did on a bar can be read back', async () => {
    await canary.run({ bar: '09:34', day: '2026-09-04', rows: rows('AAA'),
                       deps: { decide: decideWith(answer()) } });
    expect(canary.firedOn('09:34')).toBe(true);
  });

  /*
   * NOT ASKED IS NOT "DID NOT FIRE". A bar the control never ran on has to read
   * as unknown, or every bar between the five-minute marks would look like a
   * broken chain.
   */
  test('a bar it was never asked about is null, not false', () => {
    expect(canary.firedOn('11:11')).toBeNull();
  });
});

const fs = require('fs');
const path = require('path');
const readSrc = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');

describe('it is wired in where it can see both halves', () => {
  /*
   * AFTER the real setups, never beside them. There is one qp on this box and a
   * clock setup has sixty seconds; a control competing for the platform inside
   * that minute could cause the timeout it exists to diagnose.
   */
  test('the tick runs it AFTER runDue, with what runDue returned', () => {
    const s = readSrc('src', 'scheduler.js');
    expect(s).toContain('ran = await runDue(decidedOn)');
    const at = s.indexOf('ran = await runDue(decidedOn)');
    const after = s.slice(at);
    expect(after).toContain("require('./setups/canary').tick(");
    expect(after).toMatch(/ran,/);
  });

  test('a failing control cannot take the tick down with it', () => {
    const s = readSrc('src', 'scheduler.js');
    const at = s.indexOf("require('./setups/canary').tick(");
    expect(s.slice(at - 200, at)).toContain('try {');
    expect(s.slice(at, at + 400)).toContain('[Control] did not run');
  });

  test('its rows are their own kind — counted as runs they would inflate every '
    + 'funnel on the page with decisions nobody took', () => {
    const log = readSrc('src', 'setups', 'sessionLog.js');
    expect(log).toContain("row.kind === 'canary'");
    expect(log).toContain('function canariesOn(date)');
    // isRun is kind === 'run', so a control row is invisible to the run reader.
    expect(log).toContain("function isRun(row) { return row && row.kind === 'run'; }");
  });

  test('the session log serves them, whatever else was asked for', () => {
    expect(readSrc('src', 'alerts', 'server.js'))
      .toContain('out.canaries = sessionLog.canariesOn(date)');
  });

  test('and the page leads with it', () => {
    const page = readSrc('public', 'alerts.html');
    expect(page).toContain('function lgControl(');
    expect(page).toContain('sum.innerHTML = control +');
    // "Not run" must read as unknown, not as a pass — the same rule as
    // everywhere else on this desk.
    expect(page).toContain('Control: not run today');
    expect(page).toContain('.lg-ctl.none');
  });
});
