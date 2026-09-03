/*
 * THE ENTRY SIDE IS WRITTEN DOWN — including everything it decided not to do.
 *
 * The alert feed answers "what fired". It structurally cannot answer "what did
 * not, and why", because a name that was dropped produces no alert. And the
 * dropping is where a strategy quietly stops being the one that was tested:
 *
 *     the card filter removed it
 *     it fired on a bar the setup could not act on
 *     the once-a-day latch had already used the name
 *     the account had no size for it
 *     the broker refused it
 *
 * Five different mornings, and on every other view of this desk all five look
 * exactly like "nothing fired". This file pins that each one now leaves a line.
 *
 * WHAT IS BEING TESTED IS THE SHAPE, not the sentences. `runOf` is the whole
 * contract between the runner and everything that reads the record later, so
 * these assert the fields a review actually needs and, in a couple of places,
 * the things that must NEVER be in them.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

let DIR;
let log;

beforeEach(() => {
  jest.resetModules();
  DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'run-log-'));
  process.env.SESSION_LOG_DIR = DIR;
  log = require('../src/setups/sessionLog');
});

afterEach(() => {
  delete process.env.SESSION_LOG_DIR;
  fs.rmSync(DIR, { recursive: true, force: true });
});

/* A run with two names taken out of forty, one of them refused at a broker. */
function aRun(over = {}) {
  return log.runOf({
    date: '2026-08-19', setupId: 'or_vwap_0935', setupName: 'OR + VWAP 09:35',
    bar: '09:34', ms: 812,
    universe: { cards: 40, kept: 12 },
    gate: { filtered: true, reasons: { 'bias not long': 22, 'score < 60': 6 } },
    counts: { evaluated: 12, signalled: 5, skipped: 1 },
    rank: { metric: 'extension', direction: 'desc', top_n: 2 },
    picks: [
      { ticker: 'WULF', signal: 'LONG', decisionAt: '09:34', extension: 2.41,
        shares: 40, plan: { entry: 15.37, stop: 15.02, target: 16.07 } },
      { ticker: 'EYPT', signal: 'LONG', decisionAt: '09:34', extension: 1.88,
        shares: 18, plan: { entry: 22.10, stop: 21.60, target: 23.10 } },
    ],
    dropped: { stale: ['CAPR@09:31'], latched: ['BRUN'] },
    orders: {
      WULF: [{ destination: 'acct-a', broker: 'Paper A', sizedFor: 40,
               sent: true, quantity: 40, status: 'filled' }],
      EYPT: [{ destination: 'acct-b', broker: 'Paper B', sizedFor: 18,
               sent: false, error: 'insufficient buying power' }],
    },
    routing: { to: ['Paper A', 'Paper B'], error: null, orderable: true },
    riskCfg: { riskRule: 'riskPct', riskPct: 0.5, accountSize: 50000,
               sources: { risk: 'setup' }, conflicts: [] },
    data: { feed: 'polygon', coverage: 1, missing: [] },
    ...over,
  });
}

describe('the funnel — the fact the alert feed cannot carry', () => {
  /*
   * "2 picks" is not a statement about a morning. Two out of forty and two out
   * of twelve are different mornings, and only the funnel tells them apart.
   */
  test('every stage that removed a name is counted, in order', () => {
    const r = aRun();
    expect(r.funnel).toEqual({
      cards: 40, kept: 12, filtered: { 'bias not long': 22, 'score < 60': 6 },
      evaluated: 12, signalled: 5, errored: 1, picked: 2,
    });
  });

  /*
   * WHY the filter removed them, not just how many. A gate nobody can see
   * working is a gate that gets blamed for the wrong thing.
   */
  test('the filter records its reasons', () => {
    expect(aRun().funnel.filtered['bias not long']).toBe(22);
  });

  /* No filter is not an empty filter — one is a setting, the other is a run. */
  test('a run with no filter says nothing about one', () => {
    const r = aRun({ gate: { filtered: false } });
    expect(r.funnel.filtered).toBeUndefined();
  });
});

describe('the names that were dropped, and why', () => {
  /*
   * NAMES, NOT COUNTS. "1 dropped as stale" and "CAPR dropped as stale" are
   * the same number and only one of them can be checked against a chart.
   */
  test('a stale pick is named with the bar it fired on', () => {
    expect(aRun().dropped.stale).toEqual(['CAPR@09:31']);
  });

  test('a name held by the once-a-day latch is named', () => {
    expect(aRun().dropped.latched).toEqual(['BRUN']);
  });

  /* Nothing dropped is not an empty list to read past — it is nothing said. */
  test('a clean run carries no dropped block at all', () => {
    expect(aRun({ dropped: { stale: [], latched: [] } }).dropped).toBeUndefined();
  });
});

describe('what the broker did, per account', () => {
  /*
   * The interesting case with two accounts is the one where they DISAGREE, and
   * a single summary would have to choose which of the two to record.
   */
  test('each destination reports its own outcome', () => {
    const r = aRun();
    const wulf = r.picks.find(p => p.ticker === 'WULF');
    const eypt = r.picks.find(p => p.ticker === 'EYPT');
    expect(wulf.orders).toEqual([
      { to: 'acct-a', sizedFor: 40, sent: true, qty: 40, status: 'filled',
        skipped: undefined, partial: undefined, error: undefined },
    ]);
    expect(eypt.orders[0].sent).toBe(false);
    expect(eypt.orders[0].error).toBe('insufficient buying power');
  });

  /*
   * "40 asked, 12 sent" needs both numbers. A reduced order that recorded only
   * what went out would look like a correctly sized small position.
   */
  test('the size it was sized for survives beside what went out', () => {
    const r = aRun({
      orders: { WULF: [{ destination: 'a', sizedFor: 40, sent: true, quantity: 12 }] },
    });
    expect(r.picks[0].orders[0]).toMatchObject({ sizedFor: 40, qty: 12 });
  });
});

describe('which rule sized it, and where that rule came from', () => {
  /*
   * The share count is the first thing anyone checks, and it cannot be checked
   * without these: $250 means one thing as a flat figure and another as half a
   * percent of an account.
   */
  test('the rule and its level are both recorded', () => {
    expect(aRun().risk).toMatchObject({ rule: 'riskPct', from: 'setup',
                                        pct: 0.5, accountSize: 50000 });
  });

  test('a real conflict is carried; the ordinary override is not a conflict', () => {
    expect(aRun().risk.conflicts).toBeUndefined();
    const r = aRun({ riskCfg: { riskRule: 'riskPerTrade', sources: { risk: 'setup' },
                                conflicts: ['setup names both riskPerTrade and riskPct'] } });
    expect(r.risk.conflicts).toHaveLength(1);
  });
});

describe('what must never be written down', () => {
  /*
   * A destination config carries that account's OWN Alpaca key and secret. This
   * file is read, copied, and pasted into questions — so the reduction to names
   * happens inside runOf rather than being trusted to every caller.
   */
  test('raw destination configs cannot leak a key into the record', () => {
    const r = aRun({
      routing: {
        cfgs: [{ destinationId: 'acct-a', destinationName: 'Paper A',
                 alpacaKeyId: 'PKFAKEACCOUNTAAAAAAA',
                 alpacaSecret: 'fakesecretAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
                 hookUrl: 'https://app.signalstack.com/hook/FAKEhook0000000000000a' }],
        error: null,
      },
    });
    expect(r.routing.to).toEqual(['Paper A']);
    const text = JSON.stringify(r);
    expect(text).not.toContain('PKFAKEACCOUNTAAAAAAA');
    expect(text).not.toContain('fakesecretAAAA');
    expect(text).not.toContain('signalstack.com');
  });
});

describe('the two halves of a day share one file and stay apart', () => {
  test('a run is a run and a pass is a pass', () => {
    log.record(aRun());
    log.record(log.passOf({ date: '2026-08-19',
                            positions: [{ symbol: 'WULF', stop_now: 15.02 }] }));
    expect(log.runsOn('2026-08-19')).toHaveLength(1);
    expect(log.passesOn('2026-08-19')).toHaveLength(1);
  });

  /*
   * A row written before `kind` existed has none, and is a pass. The file that
   * was being written last week still has to read.
   */
  test('a row from before kind existed still reads as a pass', () => {
    fs.mkdirSync(DIR, { recursive: true });
    fs.appendFileSync(path.join(DIR, 'session-2026-08.jsonl'),
      `${JSON.stringify({ at: 1, date: '2026-08-19',
                          positions: [{ symbol: 'EYPT', stop_now: 21.6 }] })}\n`);
    expect(log.passesOn('2026-08-19')).toHaveLength(1);
    expect(log.runsOn('2026-08-19')).toHaveLength(0);
    // ...and the exit-side readers still find it.
    expect(log.symbolsOn('2026-08-19')).toEqual(['EYPT']);
  });

  /*
   * A run carries picks, not positions. Reading one as an observation of a held
   * position would be reading the entry side's answer as an exit-side fact.
   */
  test('a run never appears in the position track', () => {
    log.record(aRun());
    expect(log.trackOf('2026-08-19', 'WULF')).toEqual([]);
    expect(log.symbolsOn('2026-08-19')).toEqual([]);
  });

  test('one setup can be read on its own', () => {
    log.record(aRun());
    log.record(aRun({ setupId: 'test_setup' }));
    expect(log.runsOn('2026-08-19', 'test_setup')).toHaveLength(1);
  });
});

describe('the day in one object', () => {
  test('the summary adds up the funnel and the orders', () => {
    log.record(aRun());
    log.record(aRun({ bar: '09:35' }));
    const s = log.summaryOf('2026-08-19').or_vwap_0935;
    expect(s).toMatchObject({
      setup: 'OR + VWAP 09:35', runs: 2, failed: 0,
      evaluated: 24, signalled: 10, picked: 4,
      // ONE NAME, SEEN TWICE. `staleDropped` used to be the sum and said 2.
      staleDropped: 1, staleRepeats: 1, latched: 2,
      ordersSent: 2, ordersFailed: 2,
    });
    expect(s.staleNames).toEqual(['CAPR@09:31']);
    expect(s.firstBar).toBe('09:34');
    expect(s.lastBar).toBe('09:35');
  });

  /*
   * THE SAME NAME ON NINETY BARS IS ONE SIGNAL, NOT NINETY — the rule this
   * file already applies to `problems`, applied to the counters.
   *
   * 2026-09-03, on the desk:
   *
   *     1013 EVALUATED · 180 SIGNALLED · 0 TAKEN
   *     180 dropped as stale: GEO@09:45, IBKR@09:41
   *
   * Two names. qp re-reports every entry of a session on every bar it is asked
   * about, so a watch setup running ninety times counts the same two picks
   * ninety times. "180 dropped as stale" reads as a busy morning that the desk
   * refused; the truth is it found two, both before it could act on them.
   */
  test('a name dropped as stale on ninety bars is ONE name, and the repeat is '
    + 'said separately', () => {
    for (let i = 0; i < 90; i += 1) {
      log.record(aRun({ bar: `10:${String(i % 60).padStart(2, '0')}`,
                        picks: [], orders: null,
                        dropped: { stale: ['GEO@09:45', 'IBKR@09:41'] } }));
    }
    const s = log.summaryOf('2026-08-19').or_vwap_0935;
    expect(s.staleDropped).toBe(2);
    expect(s.staleNames).toEqual(['GEO@09:45', 'IBKR@09:41']);
    expect(s.staleRepeats).toBe(178);          // 90 bars × 2 names, less the 2
    expect(s.runs).toBe(90);
  });

  test('...and the raw total is still there, because it is what qp answered',
    () => {
      for (let i = 0; i < 4; i += 1) log.record(aRun({ picks: [], orders: null }));
      const s = log.summaryOf('2026-08-19').or_vwap_0935;
      expect(s.signalled).toBe(20);            // the sum across runs, unchanged
      expect(s.signalledBars).toBe(4);         // ...and how many bars it was on
    });

  test('a setup that signals on one bar of many says so, which is what makes '
    + 'a big total readable', () => {
    log.record(aRun({ counts: { evaluated: 12, signalled: 0 }, picks: [],
                      orders: null, dropped: null }));
    log.record(aRun({ bar: '09:35', picks: [], orders: null, dropped: null }));
    const s = log.summaryOf('2026-08-19').or_vwap_0935;
    expect(s.runs).toBe(2);
    expect(s.signalledBars).toBe(1);
  });

  /*
   * The same refusal on 31 bars of a watch window is ONE fact, not 31. A
   * problem list that repeated itself would be the noise this replaces.
   */
  test('a repeated problem is stated once', () => {
    for (let i = 0; i < 5; i += 1) {
      log.record(aRun({ routing: { to: [], error: 'no account runs this setup' } }));
    }
    expect(log.summaryOf('2026-08-19').or_vwap_0935.problems)
      .toEqual(['no account runs this setup']);
  });

  /*
   * "Asked and found nothing" and "was never asked" are the two cases this
   * whole file exists to separate, and they are one line apart in the summary.
   */
  test('a quiet bar is counted as a run, not as an absence', () => {
    log.record(aRun({ quiet: true, picks: [], dropped: null, orders: null }));
    const s = log.summaryOf('2026-08-19').or_vwap_0935;
    expect(s.runs).toBe(1);
    expect(s.quiet).toBe(1);
    expect(s.picked).toBe(0);
  });

  test('a run that threw is counted as failed and names the error', () => {
    log.record(log.runOf({ date: '2026-08-19', setupId: 'x', setupName: 'X',
                           bar: '09:34', ok: false, error: 'feed timed out' }));
    const s = log.summaryOf('2026-08-19').x;
    expect(s.failed).toBe(1);
    expect(s.problems).toEqual(['feed timed out']);
  });
});

describe('the runner writes one, on every path out', () => {
  const SRC = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'setups', 'runner.js'), 'utf8');

  /*
   * ONE SITE, AT THE BOUNDARY. The run body returns from six different places
   * and five of them are the interesting ones. A record() call inside each
   * would be five chances to add a sixth return and forget.
   */
  test('the record is written in a wrapper, not scattered through the body', () => {
    expect(SRC).toMatch(/async function _runSetup\(/);
    expect(SRC).toMatch(/async function runSetup\(setup, opts = \{\}\)/);
    expect((SRC.match(/sessionLog\.record\(/g) || [])).toHaveLength(2);
  });

  /* A run that threw is the one most worth having, so it is written first. */
  test('a throw is recorded before it is re-thrown', () => {
    const c = SRC.indexOf('} catch (err) {\n    sessionLog.record(');
    expect(c).toBeGreaterThan(-1);
    expect(SRC.slice(c, c + 400)).toMatch(/throw err;/);
  });

  /*
   * NEVER THE CAUSE OF A FAILURE. sessionLog.record reports a failed write and
   * carries on — a full disk must not stop a decision.
   */
  test('the log cannot swallow the caller exception', () => {
    expect(SRC).toMatch(/that ate the error would turn a visible/);
    expect(SRC).toMatch(/throw err;/);
  });

  /* The names, so the record shows what the latch actually held. */
  test('the latched names are captured, not just counted', () => {
    expect(SRC).toMatch(/latched = out\.picks\.filter\(p => alreadyToday\.has/);
  });

  /* Names only — the configs behind them hold each account's broker keys. */
  test('routing is reduced to names before it is carried out of the run', () => {
    expect(SRC).toMatch(/const routeLog = \{/);
    expect(SRC).toMatch(/OWN Alpaca key and secret/);
  });
});

/*
 * A TEST RUN MUST NOT PUT TRADES INTO THE REAL RECORD.
 *
 * Every suite that runs a setup against a stubbed feed now appends a line, and
 * without isolation those went to data/history/session-*.jsonl — invented
 * tickers and invented fills, dated whenever the test said, in the file a
 * morning gets reviewed from. A record a test run can write to is not a record.
 *
 * Caught the honest way: a full `npx jest` wrote 198 fabricated runs into it.
 */
describe('the suite writes nowhere near the real log', () => {
  test('every test file is pointed at a scratch directory', () => {
    const env = fs.readFileSync(path.join(__dirname, 'setup.env.js'), 'utf8');
    expect(env).toMatch(/process\.env\.SESSION_LOG_DIR = process\.env\.SESSION_LOG_DIR/);
    expect(require('../jest.config.js').setupFiles)
      .toContain('<rootDir>/tests/setup.env.js');
  });

  /*
   * The one that matters: the module resolves the path at require time, so a
   * variable set anywhere later would be too late. This asserts on what the
   * module actually resolved, not on the intention.
   */
  test('...and the module actually resolved to it', () => {
    expect(log.LOG_DIR).toBe(DIR);
    expect(log.LOG_DIR).not.toMatch(/[/\\]data[/\\]history$/);
  });
});
