/*
 * A SETUP THAT CAN ONLY BE TESTED AT 09:35 CANNOT BE TESTED.
 *
 * `OR + VWAP 09:35` decides on one bar. When it failed, the next chance to
 * find out why was the following morning, at that minute, live. A rehearsal
 * runs the same chain at any minute of the day and places nothing.
 *
 * The two properties everything here turns on:
 *
 *   IT ASKS ABOUT NOW. Asking about 09:35 from 14:00 would report a feed five
 *   hours behind and read as a total failure — a true number about a question
 *   nobody asked, which is this repo's oldest bug in a new place.
 *
 *   UNTESTED IS NOT PASSED. Nothing qualified means the sizing and the routing
 *   were NOT REACHED, and they must come back null. Green there would say the
 *   whole chain works on the evidence of the half of it that ran.
 */

const reh = require('../src/setups/rehearse');

const SETUP = { id: 'T2 OR+VWAP@09:35', name: 'OR + VWAP 09:35', tools: ['T2'],
                decisionTime: '09:35', decidesOnBar: '09:34', feed: 'yahoo' };

/** What a healthy dry run comes back with, with picks. */
const good = (over = {}) => ({
  ok: true,
  cards: 142,
  universe: 38,
  gate: { filtered: true, kept: 38, dropped: 104, reasons: { 'score < 60': 104 } },
  picks: [{ ticker: 'GEO', signal: 'LONG', shares: 180, decisionAt: '14:01',
            plan: { entry: 10, stop: 9.5, risk: 0.5, target: 11, targetR: 2 } }],
  counts: { evaluated: 38, signalled: 1, skipped: 0 },
  rank: { metric: 'reg_score', top_n: 2 },
  riskCfg: { riskRule: '$250 a trade', riskPerTrade: 250, accountSize: 25000,
             sources: { risk: 'setup' } },
  routing: { to: ['Alpaca paper'], error: null, orderable: true, blocking: [] },
  data: { feed: 'yahoo', askedBar: '14:02', lastBar: '14:01', lagMin: 1,
          coverage: 1, missing: [] },
  ...over,
});

const runWith = (result) => () => Promise.resolve(result);
const byId = (report) => Object.fromEntries(report.legs.map(l => [l.id, l]));

/* ── the shape of the answer ─────────────────────────────────────────────── */

describe('it reports every leg separately', () => {
  test('all eight legs come back, in the order the chain runs', async () => {
    const r = await reh.rehearse(SETUP, { run: runWith(good()) });
    expect(r.legs.map(l => l.id)).toEqual(
      ['cards', 'filter', 'decision', 'feed', 'rank', 'size', 'routing', 'order']);
  });

  test('a healthy run answers every one of them', async () => {
    const r = await reh.rehearse(SETUP, { run: runWith(good()) });
    expect(r.failed).toBe(0);
    expect(r.untested).toBe(0);
    expect(r.passed).toBe(8);
    expect(r.verdict).toBe(true);
  });

  /*
   * THE BAR IT ACTUALLY ASKED ABOUT, beside the one the setup normally uses.
   * Without both, the report reads as a run of the strategy — and a rehearsal
   * at 14:02 that appeared to be the 09:35 decision would be worse than no
   * rehearsal at all.
   */
  test('it says which bar it decided, and which the setup normally decides', async () => {
    const r = await reh.rehearse(SETUP, { run: runWith(good()) });
    expect(r.bar).toBe('14:02');
    expect(r.decidesOn).toBe('09:34');
    expect(r.note).toMatch(/CURRENT bar/);
    expect(r.note).toMatch(/not that the strategy would have taken this trade/);
  });

  test('it is marked as a rehearsal, so nothing downstream counts it as a run',
    async () => {
      const r = await reh.rehearse(SETUP, { run: runWith(good()) });
      expect(r.rehearsal).toBe(true);
    });
});

/* ── untested is not passed ──────────────────────────────────────────────── */

describe('a quiet bar proves the first half and NOTHING about the second', () => {
  const quiet = good({ picks: [], counts: { evaluated: 38, signalled: 0, skipped: 0 } });

  test('sizing and the order are NOT REACHED, not passed', async () => {
    const l = byId(await reh.rehearse(SETUP, { run: runWith(quiet) }));
    expect(l.size.ok).toBeNull();
    expect(l.order.ok).toBeNull();
  });

  test('...and they say why, naming the rule that WOULD have sized it', async () => {
    const l = byId(await reh.rehearse(SETUP, { run: runWith(quiet) }));
    expect(l.size.note).toMatch(/nothing qualified/i);
    expect(l.size.note).toMatch(/\$250 a trade/);
  });

  test('the legs that DID run are still green — a quiet bar is not a fault',
    async () => {
      const l = byId(await reh.rehearse(SETUP, { run: runWith(quiet) }));
      expect(l.cards.ok).toBe(true);
      expect(l.decision.ok).toBe(true);
    });

  test('untested is counted apart from passed', async () => {
    const r = await reh.rehearse(SETUP, { run: runWith(quiet) });
    expect(r.untested).toBe(2);
    expect(r.passed).toBe(6);
    expect(r.verdict).toBeNull();
  });

  /*
   * A run that returned before qp was asked — every card removed by the filter,
   * or no cards at all — has NO counts. Reporting the decision leg as green
   * there would be reading a silence as a pass.
   */
  test('a run that ended before qp leaves the decision leg unreached', async () => {
    const early = { ok: true, picks: [], universe: 0, cards: 12,
                    gate: { filtered: true, kept: 0, dropped: 12, reasons: {} } };
    const l = byId(await reh.rehearse(SETUP, { run: runWith(early) }));
    expect(l.filter.ok).toBe(false);
    expect(l.decision.ok).toBeNull();
    expect(l.feed.ok).toBeNull();
  });
});

/* ── the feed, which is the point of the whole exercise ──────────────────── */

describe('the feed lag is reported, not treated as the rehearsal failing', () => {
  /*
   * THE DELAY ERROR. Yahoo is fifteen minutes behind, so the decision is taken
   * on a bar the market has moved past — the single most likely reason a 09:35
   * setup takes nothing. It is red, because it is really wrong. What it must
   * NOT do is stop the other seven legs being reported, which is exactly what
   * made "it gives me a delay error" the end of every attempt to test this.
   */
  const delayed = good({ data: { feed: 'yahoo', askedBar: '14:02',
                                 lastBar: '13:47', lagMin: 15, coverage: 1, missing: [] } });

  test('a delayed feed fails its own leg and nothing else', async () => {
    const r = await reh.rehearse(SETUP, { run: runWith(delayed) });
    const l = byId(r);
    expect(l.feed.ok).toBe(false);
    expect(r.failed).toBe(1);
    // every other leg still answered
    expect(l.cards.ok).toBe(true);
    expect(l.decision.ok).toBe(true);
    expect(l.size.ok).toBe(true);
    expect(l.routing.ok).toBe(true);
  });

  test('and it says WHAT the delay is, so it reads as a diagnosis', async () => {
    const l = byId(await reh.rehearse(SETUP, { run: runWith(delayed) }));
    expect(l.feed.note).toMatch(/15 minute/);
    expect(l.feed.note).toMatch(/14:02/);          // asked
    expect(l.feed.note).toMatch(/13:47/);          // answered
    expect(l.feed.note).toMatch(/not a fault/);
    expect(l.feed.note).toMatch(/Everything else here still ran/);
  });

  test('one bar behind is normal and stays green — the desk\'s own order lands '
    + 'a bar late by construction', async () => {
    const l = byId(await reh.rehearse(SETUP, { run: runWith(good()) }));
    expect(l.feed.ok).toBe(true);
  });

  /*
   * NULL IS NOT ZERO. qp reporting no bar stamp at all means the lag cannot be
   * measured, and a lag of zero on a desk that cannot measure one is the most
   * reassuring wrong answer available.
   */
  test('an unmeasurable lag is unreached, never a pass', async () => {
    const noStamp = good({ data: { feed: 'polygon', askedBar: '14:02',
                                   lastBar: null, lagMin: null, coverage: 1, missing: [] } });
    const l = byId(await reh.rehearse(SETUP, { run: runWith(noStamp) }));
    expect(l.feed.ok).toBeNull();
    expect(l.feed.note).toMatch(/cannot be measured/);
  });
});

/* ── the ways it can be broken ───────────────────────────────────────────── */

describe('a broken leg is named, and the rest are not guessed at', () => {
  test('qp not answering fails the decision leg and leaves the rest unreached',
    async () => {
      const r = await reh.rehearse(SETUP, {
        run: () => Promise.reject(new Error('timeout of 18000ms exceeded')),
      });
      const l = byId(r);
      expect(l.decision.ok).toBe(false);
      expect(l.decision.note).toMatch(/timeout of 18000ms/);
      // NOT seven more failures. One thing is broken; the others are unknown.
      expect(r.failed).toBe(1);
      expect(r.untested).toBe(7);
      expect(r.ok).toBe(false);
    });

  test('no cards is a failure with something to do about it', async () => {
    const l = byId(await reh.rehearse(SETUP, { run: runWith(good({ cards: 0 })) }));
    expect(l.cards.ok).toBe(false);
    expect(l.cards.note).toMatch(/paused/);
  });

  test('a filter that removes everything is named as the filter', async () => {
    const l = byId(await reh.rehearse(SETUP, {
      run: runWith(good({ gate: { filtered: true, kept: 0, dropped: 104, reasons: {} },
                          picks: [] })),
    }));
    expect(l.filter.ok).toBe(false);
    expect(l.filter.note).toMatch(/removed all 104/);
  });

  test('no account claiming the setup is a failure, not an absence', async () => {
    const l = byId(await reh.rehearse(SETUP, {
      run: runWith(good({ routing: { to: [], error: null, orderable: true, blocking: [] } })),
    }));
    expect(l.routing.ok).toBe(false);
    expect(l.routing.note).toMatch(/alert and never trade/);
  });

  /*
   * ALERT-ONLY IS NOT A FAULT. A rule-exit strategy cannot be sent to a broker:
   * no broker watches for a VWAP cross, and a price target in its place would
   * be a different strategy under the same name.
   */
  test('a setup that alerts on purpose passes its routing leg', async () => {
    const l = byId(await reh.rehearse(SETUP, {
      run: runWith(good({ routing: { to: [], error: null, orderable: false,
                                     blocking: ['exit is a rule, not a price'] } })),
    }));
    expect(l.routing.ok).toBe(true);
    expect(l.routing.note).toMatch(/alerts and does not trade/);
  });

  test('a ranking that could not be applied is a failure — "top 2" of an '
    + 'unordered list is two arbitrary names', async () => {
    const l = byId(await reh.rehearse(SETUP, {
      run: runWith(good({ rank: { metric: null, top_n: 2, ignored_top_n: 2 } })),
    }));
    expect(l.rank.ok).toBe(false);
  });

  test('zero shares is a failure, not a quiet pass', async () => {
    const l = byId(await reh.rehearse(SETUP, {
      run: runWith(good({ picks: [{ ticker: 'GEO', signal: 'LONG', shares: 0,
                                    plan: { entry: 10, stop: 9.5, risk: 0.5 } }] })),
    }));
    expect(l.size.ok).toBe(false);
    expect(l.size.note).toMatch(/zero shares/);
  });

  test('a setup belonging to another tool is unreached everywhere', async () => {
    const r = await reh.rehearse(SETUP, {
      run: runWith({ ok: false, reason: 'belongs to T2, this is T1' }),
    });
    expect(r.untested).toBe(8);
    expect(r.passed).toBe(0);
    expect(r.legs[0].note).toMatch(/belongs to T2/);
  });
});

/* ── it places nothing ───────────────────────────────────────────────────── */

describe('nothing is sent', () => {
  test('the last leg says what WOULD have gone, marked NOT PLACED', async () => {
    const l = byId(await reh.rehearse(SETUP, { run: runWith(good()) }));
    expect(l.order.note).toMatch(/NOT PLACED/);
    expect(l.order.note).toMatch(/GEO/);
    expect(l.order.detail.placed).toBe(false);
  });

  /*
   * THE FLAG THE RUNNER READS. `rehearsal: true` is what forces dryRun inside
   * _runSetup — if this call ever went out without it, a rehearsal would
   * publish alerts and place orders, which is the one thing it must never do.
   */
  test('the run is asked for as a rehearsal, every time', async () => {
    const seen = [];
    await reh.rehearse(SETUP, { run: (s, opts) => { seen.push(opts); return Promise.resolve(good()); } });
    expect(seen).toEqual([{ rehearsal: true }]);
  });
});

/* ── the morning pass ────────────────────────────────────────────────────── */

/*
 * The button answers "does it work" when you think to ask. This answers it
 * before the open every day, so the check is something you READ — the whole
 * complaint being that nobody can be at the phone for one exact minute daily.
 */
describe('the scheduled rehearsal', () => {
  const deps = (setups, result) => ({
    catalog: { forTool: async () => setups },
    prefs: { isEnabled: () => true },
    config: { toolId: 'T2' },
    alertStore: { published: [], publishFires(f) { this.published.push(...f); } },
    run: runWith(result),
  });

  test('it rehearses every enabled setup the tool owns', async () => {
    const d = deps([SETUP, { ...SETUP, id: 'other', name: 'Other' }], good());
    const out = await require('../src/setups/rehearse').rehearseAll({ deps: d });
    expect(out.map(r => r.setupId)).toEqual([SETUP.id, 'other']);
  });

  test('a setup switched off is not rehearsed', async () => {
    const d = deps([SETUP], good());
    d.prefs = { isEnabled: () => false };
    expect(await reh.rehearseAll({ deps: d })).toEqual([]);
  });

  /*
   * QUIET WHEN EVERYTHING ANSWERED. A message every morning saying "fine" is
   * how you learn to stop reading the feed, and then the one that matters
   * arrives into the habit of not looking.
   */
  test('it says nothing when every leg came back', async () => {
    const d = deps([SETUP], good());
    await reh.rehearseAll({ deps: d });
    expect(d.alertStore.published).toEqual([]);
  });

  test('it publishes ONE alert naming the legs that did not', async () => {
    const d = deps([SETUP], good({ cards: 0 }));
    await reh.rehearseAll({ deps: d });
    expect(d.alertStore.published).toHaveLength(1);
    const f = d.alertStore.published[0];
    expect(f.level).toBe('warn');
    expect(f.detail).toMatch(/REHEARSAL/);
    expect(f.detail).toMatch(/Cards on the list/);
    // …and it says plainly that nothing was traded, or a warn-level line about
    // a strategy reads as something having gone out.
    expect(f.detail).toMatch(/Nothing was published or placed/);
  });

  test('one setup throwing does not take the others with it', async () => {
    const d = deps([SETUP, { ...SETUP, id: 'second' }], good());
    let first = true;
    d.run = () => {
      if (first) { first = false; return Promise.reject(new Error('boom')); }
      return Promise.resolve(good());
    };
    const out = await reh.rehearseAll({ deps: d });
    expect(out).toHaveLength(2);
    expect(out[1].failed).toBe(0);
  });
});

/* ── the wiring ──────────────────────────────────────────────────────────── */

const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const readSrc = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

describe('it is reachable, and it decides on the current bar', () => {
  test('the tool serves it', () => {
    const routes = readSrc('src', 'routes', 'setups.js');
    expect(routes).toContain("router.get('/:id/rehearse'");
    expect(routes).toContain('rehearse');
  });

  /*
   * The alerts app has no database and no card list, so it cannot run a setup —
   * it asks the owning tool on its own port. The page cannot ask the tool
   * directly: a different port is a different origin, and the tools allow
   * cross-origin reads on a short fixed list of paths.
   */
  test('the Algo app proxies to the tool that owns the setup', () => {
    const server = readSrc('src', 'alerts', 'server.js');
    expect(server).toContain("app.get('/api/setups/:id/rehearse'");
    expect(server).toMatch(/tools\.config\.json/);
    expect(server).toMatch(/AbortSignal\.timeout\(90000\)/);   // qp gets its budget
  });

  test('a setup with no tool comes back UNTESTED with a reason, not fine', () => {
    const server = readSrc('src', 'alerts', 'server.js');
    expect(server).toMatch(/names no tool/);
    expect(server).toMatch(/untested: 0/);       // the blank report counts nothing
    expect(server).toMatch(/verdict: null/);
  });

  test('a sleeping tool is refused with the reason, rather than timing out', () => {
    expect(readSrc('src', 'alerts', 'server.js')).toMatch(/which is switched/);
  });

  test('there is a button on the setup card', () => {
    const page = readSrc('public', 'alerts.html');
    expect(page).toContain('rehearseSetup(');
    expect(page).toContain('>\n            Rehearse</button>');
  });

  test('the page never renders "not reached" as a pass', () => {
    const page = readSrc('public', 'alerts.html');
    const at = page.indexOf('async function rehearseSetup');
    const fn = page.slice(at, page.indexOf('async function testBroker', at));
    expect(fn).toContain("l.ok === true ? 'pass'");
    expect(fn).toContain("l.ok === false ? 'fail'");
    expect(fn).toContain("'untested'");
    expect(fn).toMatch(/not reached/);
  });

  test('the morning pass is scheduled before the open', () => {
    const sched = readSrc('src', 'scheduler.js');
    expect(sched).toContain("registerJob('Setup Rehearsal 09:25'");
    expect(sched).toContain("'25 9 * * 1-5'");
    expect(sched).toContain('rehearseAll');
  });

  /*
   * THE RUNNER'S HALF. A rehearsal is dry whatever the caller passed, asks
   * about the current minute, and skips the staleness gate — which exists to
   * ask "is this tradeable now", a question a rehearsal is not asking.
   */
  test('the runner forces a rehearsal to be dry', () => {
    const runner = readSrc('src', 'setups', 'runner.js');
    expect(runner).toContain('if (rehearsal) dryRun = true;');
  });

  test('...decides on the current bar', () => {
    expect(readSrc('src', 'setups', 'runner.js'))
      .toMatch(/rehearsal \? nowBarET\(\)/);
  });

  test('...and does not apply the stale gate', () => {
    expect(readSrc('src', 'setups', 'runner.js'))
      .toContain('if (decisionBar && !rehearsal) {');
  });

  /*
   * A rehearsal in the day's summary would show runs on bars the setup was
   * never asked about — and, since it measures a large lag by design on a
   * delayed feed, would report the feed as broken on a day it was fine.
   */
  test('the session log records rehearsals and the day\'s summary skips them', () => {
    const log = readSrc('src', 'setups', 'sessionLog.js');
    expect(log).toContain('rehearsal: rehearsal || undefined');
    expect(log).toContain('runsOn(date).filter(x => !x.rehearsal)');
  });
});
