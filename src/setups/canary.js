/*
 * THE CONTROL. A setup so simple it must fire if the machine works.
 *
 * THE QUESTION IT ANSWERS. `OR + VWAP 09:35` takes nothing, and there are two
 * completely different reasons for that:
 *
 *     the CHAIN is broken   qp did not answer, the feed is behind, no cards
 *                           reached it, the ranking never ran
 *     the RULES did not match   everything worked and no stock qualified
 *
 * From the outside those are the same sentence — "nothing qualified" — and
 * until now nothing on this desk could tell them apart. So a second strategy is
 * asked the same question, on the same bar, over the same cards, through the
 * same feed, with a rule that is true of every bar that exists: `close > 0`.
 *
 *     the control fires and the setup does not   →  the chain works. What did
 *                                                   not match is the setup's
 *                                                   own rules.
 *     neither fires                              →  it is the chain, and the
 *                                                   reason comes with it: the
 *                                                   feed was N minutes behind,
 *                                                   qp did not answer, there
 *                                                   were no cards.
 *
 * IT RUNS EVERY FIVE MINUTES, AND ON EVERY BAR A REAL SETUP DECIDES. The
 * five-minute cadence is so the day has a heartbeat you can look back at; the
 * paired run is the one that matters, because a control on a different bar
 * from the setup it is controlling for proves nothing about that bar.
 *
 * IT RUNS AFTER THE REAL SETUPS, NEVER BESIDE THEM. There is one qp on this
 * box and a clock setup has sixty seconds. A control that competed for the
 * platform during that minute could cause the timeout it exists to diagnose.
 *
 * NOTHING IS PLACED, EVER. This asks qp directly — it never touches the
 * broker, the routing or the alert path a real pick takes. It cannot place an
 * order because there is no code here that could.
 */

const qp = require('./qpClient');
const config = require('../config');
const sessionLog = require('./sessionLog');
const { toETDate } = require('../utils/time');

/** Every fifth minute — 09:00, 09:05, 09:10 … */
const CADENCE_MIN = 5;

/*
 * A HANDFUL OF SYMBOLS, NOT THE WHOLE LIST. The control is asking whether the
 * platform answers, not scanning: forty symbols would put a second full
 * decision on qp every five minutes, on a box with 912 MB.
 */
const MAX_SYMBOLS = 5;

/*
 * WHEN THE TOOL HAS NO CARDS. An empty list is itself a finding — the real
 * setup would have nothing to rank either — but it must not also blind the
 * control to the qp hop. So it falls back to one liquid name and SAYS it fell
 * back, which keeps the two facts separate.
 */
const FALLBACK_SYMBOLS = ['SPY'];

/** The same tolerance the runner allows a real pick — see STALE_TOLERANCE_MIN. */
const TOLERANCE_MIN = 1;

/*
 * A SHORTER BUDGET THAN A REAL DECISION, AND ONE ATTEMPT.
 *
 * The runner retries because a lost decision costs the session. Here a timeout
 * IS the finding, and a control that quietly asked again would hide exactly the
 * fault it was built to catch. It must also never be the reason a later minute
 * is late.
 */
const TIMEOUT_MS = 12000;

/*
 * THE STRATEGY, HELD HERE RATHER THAN IN qp.
 *
 * Sent inline on every call (qp's /api/setup/decide takes `strategies` as well
 * as a `strategy_id`), so there is nothing to build in the chart tool, nothing
 * to assign to a tool, and nothing in the strategy list that could be edited by
 * accident into something that no longer always fires. A control whose
 * definition can drift is not a control.
 *
 * `close > 0` is true of every bar that exists — so the ONLY way it produces
 * no signal on a bar is that the bar itself is not there, which is precisely
 * the fact being tested.
 *
 * entry_mode 'level', NOT the default 'edge'. Edge mode fires once per
 * contiguous true-run, and a rule that is always true is one run: one signal,
 * at the first bar of the day, and nothing afterwards. Verified: level mode
 * produces a trade on every bar, edge mode exactly one. See
 * chart/tests/logic_audit63.py.
 *
 * The 0.05% stop exists so the pick carries a real entry and stop, which is
 * what a pick has to look like; the always-true exit rule below is what closes
 * the position on the next bar so a new one can open. Between them qp
 * classifies this as a rule-exit strategy — no target, order_ok false — and
 * that is the right answer twice over: a control must never reach a broker,
 * and now it cannot, whatever the desk-side code does or does not check.
 */
const SPEC = {
  name: '__control__',
  side: 'long',
  stage: 'ready',
  entry: {
    logic: 'AND',
    k: 1,
    window: 1,
    rules: [{
      left: { kind: 'price', field: 'close' },
      op: 'gt',
      right: { kind: 'const', value: 0 },
    }],
  },
  /*
   * AN EXIT RULE THAT IS ALWAYS TRUE, and it is not decoration.
   *
   * Without it the shipped control was NOT deterministic. In level mode a new
   * trade can only open once the previous one has closed, and with only a
   * 0.05% stop the previous one closes only if the next bar's low dips that far
   * under entry. On a quiet stock it never does — the first trade of the day
   * stayed open all day and the control reported "did not fire although the
   * feed was current" on bar after bar. Seen live on 2026-09-04 over SPY at
   * 14:15, and proven against qp's engine: on flat bars the old spec produced
   * ZERO picks; with this rule it produces one every other bar, whatever the
   * price does. That alternate-bar rhythm is why TOLERANCE_MIN is one.
   */
  exit: {
    logic: 'AND',
    k: 1,
    window: 1,
    rules: [{
      left: { kind: 'price', field: 'close' },
      op: 'gt',
      right: { kind: 'const', value: 0 },
    }],
  },
  risk: {
    sl: { type: 'pct', value: 0.05 },
    tp: { type: '', value: null },
    targets: [],
    // Wide enough that the control is available whenever the desk is asking —
    // premarket through the close. It is not a trading window; it is the span
    // in which a control is allowed to answer.
    window_start: 400,
    window_end: 1600,
    entry_mode: 'level',
  },
  tools: [],
};

/* ── the day's memory ────────────────────────────────────────────────────── */

/*
 * Per bar, in memory, for today only. It exists so a run on the 09:34 bar can
 * be read against the control on the SAME bar — the pairing is the whole point,
 * and a control from four minutes earlier is a different question.
 */
const DAY = { date: null, byBar: new Map(), said: new Set(), lastFired: null };

function resetIfNewDay(day) {
  if (DAY.date === day) return;
  DAY.date = day;
  DAY.byBar = new Map();
  DAY.said = new Set();
  DAY.lastFired = null;
}

/** What the control did on a bar: true, false, or null when it was not asked. */
function firedOn(bar) {
  const r = DAY.byBar.get(bar);
  return r ? !!r.fired : null;
}

function resultOn(bar) { return DAY.byBar.get(bar) || null; }

/* ── when it runs ────────────────────────────────────────────────────────── */

function minuteOf(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || ''));
  return m ? Number(m[2]) : null;
}

/**
 * Due on a five-minute mark, or on any bar a real setup just decided.
 *
 * The second half is not a convenience: a control that only ran on the cadence
 * would miss the 09:34 bar whenever the cadence and the decision did not line
 * up, and that bar is the only one anybody asks about afterwards.
 */
function due(nowHHMM, aSetupRan) {
  if (aSetupRan) return true;
  const m = minuteOf(nowHHMM);
  return m !== null && m % CADENCE_MIN === 0;
}

/* ── what it asks about ──────────────────────────────────────────────────── */

/** Up to five of this tool's cards; one liquid name when it has none. */
function symbolsFor(rows) {
  const all = (rows || [])
    .map(r => String((r && r.ticker) || '').toUpperCase())
    .filter(Boolean)
    .sort();
  if (!all.length) return { symbols: FALLBACK_SYMBOLS.slice(), fromCards: false };
  return { symbols: all.slice(0, MAX_SYMBOLS), fromCards: true };
}

/*
 * THE SAME FEED THE REAL SETUPS USE, or the control is answering about a
 * different market. A control on a live feed while the setup runs on a delayed
 * one would fire every time and prove the opposite of what it claims.
 */
function feedFor(setups) {
  for (const s of setups || []) {
    const f = s && (s.liveFeed || s.feed);
    if (f) return String(f);
  }
  /*
   * AND WHEN NO SETUP NAMES ONE, the same default a setup with no preference
   * gets — not the word 'yahoo' typed here. Those were the same thing until
   * the default became alpaca, and then the Control would have gone on
   * measuring yahoo's delay while every setup decided on a real-time feed:
   * a control reporting honestly about a market nobody is trading.
   */
  return require('./feeds').liveFeedFor(null).feed;
}

/** Minutes between two HH:MM stamps, or null when either is unreadable. */
function apart(a, b) {
  const mins = (hhmm) => {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || ''));
    return m ? Number(m[1]) * 60 + Number(m[2]) : null;
  };
  const x = mins(a); const y = mins(b);
  if (x === null || y === null) return null;
  return Math.abs(x - y);
}

/* ── the run ─────────────────────────────────────────────────────────────── */

/**
 * Ask qp the control question about one bar.
 *
 * Never throws. A control that can take the tick down with it is worse than no
 * control — the tick is where the real setups run.
 */
async function run({ bar, day, rows, setups, deps = {} } = {}) {
  const date = day || toETDate(Date.now());
  resetIfNewDay(date);
  const decide = deps.decide || qp.decide;
  const { symbols, fromCards } = symbolsFor(rows);
  const feed = deps.feed || feedFor(setups);
  const started = Date.now();

  const out = { bar, date, symbols, fromCards, feed, ok: false, fired: false,
                signalled: 0, evaluated: 0, lastBar: null, lagMin: null,
                pickAt: null, ms: 0, error: null };
  try {
    const d = await decide({
      strategies: [SPEC],
      symbols,
      date,
      tf: '1m',
      feed,
      topN: 0,
      metric: null,
      direction: null,
      fill: 'live',
      view: 'all',
      timeoutMs: TIMEOUT_MS,
      attempts: 1,
    });
    out.ok = true;
    out.lastBar = d.last_bar || null;
    out.lagMin = apart(bar, out.lastBar);
    out.evaluated = (d.counts && d.counts.evaluated) || 0;
    out.signalled = (d.counts && d.counts.signalled) || 0;
    /*
     * FIRED MEANS "ON THIS BAR", not "at some point today". qp re-reports every
     * entry of the session on every call, so a signal from 09:31 comes back at
     * 14:00 as well — and counting that as the control firing would report a
     * working chain off a five-hour-old bar, which is the exact failure this
     * desk keeps having.
     */
    /*
     * JUDGED AGAINST THE NEWEST BAR THE FEED HAD, not against the clock.
     *
     * The control fires on alternate bars, and any feed is one bar behind the
     * clock at :00 — the bar that just closed has not been published yet. So
     * judged against the asked bar, the one bar the feed HAS is the "off" bar
     * half the time, and the control cries wolf on half its checks. Seen at
     * 16:00 on 2026-09-04: "did not fire on the 15:59 bar although yahoo was
     * current (newest 15:58)". Whether the feed is late is a separate fact,
     * measured as lagMin and judged first in verdict().
     */
    const anchor = out.lastBar || bar;
    const near = (d.picks || [])
      .map(p => p.entry_at)
      .filter(at => { const n = apart(at, anchor); return n !== null && n <= TOLERANCE_MIN; });
    out.fired = near.length > 0;
    out.pickAt = near[0] || ((d.picks || [])[0] || {}).entry_at || null;
  } catch (err) {
    out.error = err.message;
  }
  out.ms = Date.now() - started;

  DAY.byBar.set(bar, out);
  try {
    sessionLog.record({
      kind: 'canary', date, at: Date.now(), bar,
      ok: out.ok, fired: out.fired, error: out.error || undefined,
      feed: out.feed, lastBar: out.lastBar, lagMin: out.lagMin,
      symbols: out.symbols, fromCards: out.fromCards,
      signalled: out.signalled, evaluated: out.evaluated, ms: out.ms,
    });
  } catch { /* a log that cannot be written must not stop the control */ }
  return out;
}

/* ── what it means ──────────────────────────────────────────────────────── */

/**
 * The sentence to put on the feed, or null when there is nothing to say.
 *
 * `runs` are the results `runDue` returned for this bar — so the pairing is
 * between what the setup did and what the control did on the SAME bar.
 */
function verdict(control, runs) {
  if (!control) return null;

  if (!control.ok) {
    return { level: 'error', key: `control-error-${control.error}`,
      detail: `CONTROL DID NOT ANSWER on the ${control.bar} bar: ${control.error}. `
        + 'The control asks qp a question that is true of every bar that exists, '
        + 'so this is the platform, not any strategy — every setup on this bar '
        + 'was decided blind or not at all.' };
  }

  /*
   * THE FEED FIRST. A feed fifteen minutes behind is what a fifteen-minute
   * feed looks like from the inside: the platform answers, the answer is about
   * a bar from a quarter of an hour ago, and NOTHING can fire on the bar being
   * asked about — whether or not the control found a pick on that older bar.
   * It is the single most likely reason a clock setup takes nothing, and until
   * now it produced the same silence a quiet market does.
   */
  if (control.lagMin !== null && control.lagMin > TOLERANCE_MIN) {
    return { level: 'warn', key: 'control-lag',
      detail: `CONTROL DID NOT FIRE on the ${control.bar} bar — the newest bar `
        + `${control.feed} had was ${control.lastBar}, ${control.lagMin} minutes `
        + 'behind. Nothing could have fired on that bar, including any setup '
        + 'deciding on it. This is the feed, not the rules.' };
  }

  if (!control.fired) {
    return { level: 'warn', key: 'control-quiet',
      detail: `CONTROL DID NOT FIRE on the ${control.bar} bar although `
        + `${control.feed} was current${control.lastBar ? ` (newest ${control.lastBar})` : ''}. `
        + `It asks for close > 0 over ${control.symbols.join(', ')}, so this is the `
        + 'chain rather than any strategy — check the platform and the card list.' };
  }

  /*
   * THE CONTROL FIRED. Now the useful half: which setups on this bar found
   * nothing, and what that means about them.
   */
  const quiet = (runs || []).filter(r => r && r.ok !== false && !r.error
    && !(Array.isArray(r.picks) ? r.picks.length : r.picks));
  if (!quiet.length) return null;

  return { level: 'info', key: `control-fired-${control.bar}`,
    detail: `CONTROL FIRED on the ${control.bar} bar `
      + `(${control.feed}, newest bar ${control.lastBar}) — cards, qp, the `
      + 'ranking and the plan all answered. '
      + `${quiet.map(r => r.setupId || r.setup).join(', ')} found nothing on the `
      + 'same bar, so what did not match is the strategy\'s own rules, not the desk.' };
}

/* ── the tick ────────────────────────────────────────────────────────────── */

/**
 * Run the control if it is due, and say what it means — at most once per thing.
 *
 * A control that repeated itself every five minutes would be the loudest thing
 * on the feed within an hour, and then it would be the thing nobody reads. So
 * a message goes out when the answer CHANGES: the first failure, each recovery
 * and the next failure after it, and one pairing line per bar.
 */
/*
 * WHERE IT RUNS, AND WHERE IT MUST NOT.
 *
 * The first version ran in every tool. Six processes, one control each, every
 * five minutes, all at :00 seconds, each a qp decide — on one qp, on a 912 MB
 * box. 2026-09-04 14:45:22: four identical "CONTROL DID NOT ANSWER" lines at
 * the same second. The controls had timed out EACH OTHER, and reported it as
 * the platform being down. Worse, at 09:35:00 the five tools with no setup
 * would have fired their cadence run while T2 ran the real decision — the
 * control competing for the platform in the one minute it exists to protect.
 *
 * So, two rules:
 *
 *   ONLY A TOOL THAT OWNS A SETUP RUNS IT. A tool with nothing to pair against
 *   has nothing to say — and its control was pure load plus a SPY fallback
 *   line on the feed. That is also what makes the feed read once per bar:
 *   there is one control now, not six each dedupeing only itself.
 *
 *   NEVER ON THE CADENCE IN A MINUTE ANY SETUP ANYWHERE DECIDES. The paired
 *   run — after runDue, in the owning tool — still covers that bar, which is
 *   the only place it should be covered from.
 *
 * `all` is every setup the catalog knows, across tools. `setups` is this
 * tool's own. Both are what the scheduler already has in hand.
 */
function ownsSetup(setups) {
  return (setups || []).some(s => s && s.enabled !== false);
}

function someoneDecides(bar, all, deps = {}) {
  const within = deps.withinWindow || require('./catalog').withinWindow;
  return (all || []).some(s => s && s.enabled !== false
    && within(bar, s.decidesOnBar || s.decisionTime, s.decidesUntilBar || s.windowEnd));
}

async function tick({ now, bar, day, rows, setups = [], all = null, ran = [],
                      deps = {} } = {}) {
  const date = day || toETDate(Date.now());
  resetIfNewDay(date);
  if (!ownsSetup(setups)) return null;

  const paired = (ran || []).length > 0;
  if (!due(now, paired)) return null;
  if (!paired) {
    /*
     * A cadence run. `all` is read only here, and only in a tool that got
     * this far — one catalog read every five minutes in one or two processes,
     * not one every minute in six.
     */
    let everyone = all;
    if (!everyone) {
      try { everyone = await (deps.catalog || require('./catalog')).list(); } catch { everyone = []; }
    }
    if (someoneDecides(bar, everyone, deps)) return null;
  }

  const control = await run({ bar, day: date, rows, setups, deps });
  const v = verdict(control, ran);
  console.log(`[Control] ${bar}: ${control.ok
    ? `${control.fired ? 'FIRED' : 'no signal'} · ${control.feed} newest `
      + `${control.lastBar || '—'}${control.lagMin !== null ? ` (${control.lagMin}m)` : ''}`
    : `did not answer — ${control.error}`}`);
  if (!v) return control;

  // The transition, not the state: an unchanged answer is not news.
  const changed = control.fired !== DAY.lastFired;
  DAY.lastFired = control.fired;
  if (!changed && DAY.said.has(v.key)) return control;
  DAY.said.add(v.key);

  const alertStore = deps.alertStore || require('../alerts/store');
  try {
    alertStore.publishFires([{
      ruleId: '__control__', rule: 'Control', ticker: null, toolId: config.toolId,
      date, at: Date.now(), kind: 'setup', level: v.level, detail: v.detail,
      // MARKED, so the desk's headline does not count it. "17 fired today,
      // 5 errors" on 2026-09-04 was mostly this — a diagnostic read as a
      // trading day. The page skips `control` rows in those two numbers.
      control: true,
    }], date);
  } catch (err) {
    console.warn('[Control] could not publish:', err.message);
  }
  return control;
}

module.exports = {
  run, tick, verdict, due, ownsSetup, someoneDecides, symbolsFor, feedFor,
  firedOn, resultOn,
  SPEC, CADENCE_MIN, MAX_SYMBOLS, FALLBACK_SYMBOLS, TOLERANCE_MIN, TIMEOUT_MS,
  // Test-only: the day's memory has to be resettable, or one test's bar leaks
  // into the next one's pairing.
  _reset: () => { DAY.date = null; resetIfNewDay(toETDate(Date.now())); },
};
