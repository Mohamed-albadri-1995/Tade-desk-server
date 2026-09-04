/*
 * A minute-by-minute record of what the desk saw and what it decided.
 *
 * WHY. Everything the desk SENDS is already recorded: the ledger holds every
 * order attempt and the broker's reply, and the alert history holds every fire
 * with the whole plan behind it. Both are append-only and both survive.
 *
 * Nothing recorded what it DECIDED NOT to do.
 *
 * The manager looks at every open position once a minute and almost always
 * concludes "not yet". That conclusion is the entire content of a trading day
 * for a position that ran from 09:36 to 15:50, and it was thrown away — so
 * these questions had no answer at all after the fact:
 *
 *     why did it not close at 10:47, when I would have?
 *     where was the trailing stop at 11:00?
 *     was the exit rule ever close to firing?
 *     did Alpaca and this side agree all day, or only at the end?
 *
 * Not "hard to answer". No answer: the numbers existed for a few milliseconds
 * inside one pass and were dropped.
 *
 * WHY IT IS NOT THE ALERT FEED. The feed is for things worth waking a phone
 * for, and a line a minute saying "still holding" would bury the one line that
 * mattered — the failure that teaches you to stop reading it. This is the other
 * half: everything, unread, until a day is being reviewed.
 *
 * WHY IT IS NOT THE LEDGER. That file is what went to a broker, and its value
 * is that every line is a thing that really happened to money. Mixing
 * observations into it would end that.
 *
 * ONE LINE PER PASS, not per position — a pass is what the manager actually did
 * and its positions belong together. Roughly 390 lines a session, a few hundred
 * kilobytes a day, rotated by month like the alert history.
 *
 * BOTH HALVES OF THE DAY, in one file.
 *
 * The above is the EXIT side. The ENTRY side had the same hole and it was
 * bigger: the runner decides which names to take, and everything it decided
 * NOT to take went to `console.log` — kept by systemd for a while, read by
 * nobody, impossible to query, and gone by the time anyone asks. So these had
 * no answer after the fact either:
 *
 *     it took two names — out of how many, and what removed the rest?
 *     three picks came back and one order went out. What happened to the
 *       other two — stale bar, already alerted, no size, refused?
 *     which risk rule sized it, and which LEVEL did that rule come from?
 *     the ranking kept the top 2 by what number, out of how many signals?
 *     nothing fired all morning. Was it asked?
 *
 * The alert feed answers "what fired". It cannot answer "what did not, and
 * why", because a thing that did not fire produces no alert — and the reasons
 * are precisely where a strategy quietly stops being the one that was tested.
 *
 * Two shapes, one file, told apart by `kind`:
 *
 *     kind: 'run'   one decision — what was asked, ranked, dropped, sent
 *     kind: 'pass'  one management sweep — where the stops were, what closed
 *
 * A row written before `kind` existed has none, and is a pass: it has
 * `positions`, which a run never does. Every reader here treats it that way,
 * so the file that was being written last week still reads.
 */

const fs = require('fs');
const path = require('path');

const DIR = process.env.DATA_DIR || path.join(__dirname, '..', '..', 'data');
const LOG_DIR = process.env.SESSION_LOG_DIR || path.join(DIR, 'history');

/*
 * HOW LATE A BAR MAY BE AND STILL BE THE ONE THE DECISION IS ABOUT.
 *
 * The same one-bar tolerance the runner already applies to a pick, and for the
 * same reason: the desk's own order lands a bar late by construction, so one
 * minute is the feed publishing late rather than the desk reading the wrong
 * market. Two or more is a different bar, and on a one-minute strategy a
 * different trade. Kept beside `runner.FEED_LAG_WARN_MIN`, which decides when
 * the run says so; this decides when the DAY says so.
 */
const LAG_BAD_MIN = 2;

/** `session-2026-08.jsonl` — by month, so a day's review is one grep. */
function fileFor(date) {
  const month = String(date || '').slice(0, 7) || 'unknown';
  return path.join(LOG_DIR, `session-${month}.jsonl`);
}

/**
 * Record one pass.
 *
 * NEVER THROWS. This is an observer; a full disk or a bad permission must not
 * take down the loop that closes positions. A failed write is reported once to
 * the console and the pass carries on.
 */
function record(entry) {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(fileFor(entry.date), `${JSON.stringify(entry)}\n`);
    return true;
  } catch (err) {
    console.error('[SessionLog] could not write:', err.message);
    return false;
  }
}

/**
 * What the manager saw on one pass, reduced to what a review actually needs.
 *
 * DELIBERATELY NOT the whole qp answer. A pass a minute for six hours is 390
 * copies of every field, and the ones that never change — the strategy's name,
 * its shape — are noise repeated 390 times. What is kept is what MOVES: the
 * stop, whether the rule fired, whether the broker still held it.
 */
function passOf({ at, date, positions = [], held = null, acted = [] }) {
  return {
    at: at || Date.now(),
    date,
    kind: 'pass',
    // `null` means Alpaca was not asked or did not answer, which is NOT the
    // same as an empty list, and a review has to be able to tell them apart.
    heldAtBroker: held === null ? null : [...held],
    positions: positions.map(p => ({
      symbol: p.symbol,
      setupId: p.setupId,
      side: p.side,
      // A skipped position carries the ledger row rather than a qp answer, and
      // there the fill price is `price`. Same fact, two spellings.
      entry: p.entry === undefined ? (p.price === undefined ? null : p.price) : p.entry,
      // The three that move, and the reason the file exists.
      stop: p.stop_now === undefined ? null : p.stop_now,
      stopMoved: !!p.stop_moved,
      breached: !!p.breached,
      exitNow: !!p.exit_now,
      // How late the rule was caught. 0 is "this bar"; anything else is a cost
      // the backtest did not pay, and it is invisible unless it is written down.
      exitBarsAgo: p.exit_bars_ago === undefined ? null : p.exit_bars_ago,
      // Reported by qp and deliberately never acted on, so the ONLY trace it
      // leaves is here and in one alert.
      wrongSide: p.stop_wrong_side ? true : undefined,
      // Whether this pass had anything to decide at all. A frozen stop with no
      // exit rule is entirely the broker's, and a review that cannot tell that
      // apart from "watched and held" is reading the wrong thing.
      managed: p.managed === undefined ? undefined : !!p.managed,
      barsHeld: p.bars_held === undefined ? null : p.bars_held,
      // Only when there is one — an error every minute for a symbol qp cannot
      // price is the thing a review most needs to find, and it is invisible in
      // the alert feed because it never produced an order.
      error: p.error || undefined,
      skipped: p.skipped || undefined,
    })),
    acted: acted.map(a => ({
      symbol: a.symbol, why: a.why, sent: a.sent,
      alreadyFlat: a.alreadyFlat || undefined,
      dryRun: a.dryRun || undefined,
    })),
  };
}

/**
 * ONE DECISION: what was asked, what was ranked, what was dropped and why, and
 * what the broker did with what was left.
 *
 * The point of the shape is the FUNNEL. A run that took two names out of forty
 * and a run that took two out of twelve are different statements about the same
 * morning, and the alert feed shows the same two lines for both. Every stage
 * that removes a name is counted here, in the order it removes them:
 *
 *     cards on the list  →  the setup's own filter  →  qp evaluated
 *       →  had a direction  →  survived the ranking  →  fired on THIS bar
 *       →  not already alerted today  →  had a size  →  the broker took it
 *
 * DELIBERATELY NOT the whole qp answer. Every candidate's bars, indicators and
 * intermediate levels are megabytes a run and none of it is what the question
 * needs; what is kept is the count at each stage and the NAMES that fell out of
 * the last few, because by then a name is specific enough to go and look at.
 */
function runOf({
  at, date, setupId, setupName, bar, dryRun = false, rehearsal = false,
  ok = true, error = null,
  ms = null, universe = null, gate = null, counts = null, rank = null,
  picks = [], dropped = null, orders = null, routing = null, riskCfg = null,
  data = null, quiet = false,
} = {}) {
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  return {
    at: at || Date.now(),
    date,
    kind: 'run',
    setupId,
    setup: setupName || undefined,
    // WHICH BAR was decided, which is not the minute this ran. They differ by
    // one for every fill model that enters at the next open, and a review that
    // confuses them is comparing the wrong bar's close to the backtest.
    bar: bar || null,
    ok: !!ok,
    error: error || undefined,
    ms: num(ms),
    dryRun: dryRun || undefined,
    /*
     * A REHEARSAL IS NOT A RUN OF THE STRATEGY, and the day's review must not
     * read it as one. It decides on the current minute rather than the setup's,
     * publishes nothing and places nothing — so counted as a run it would show
     * a setup that "ran and found nothing" on a bar it was never asked about.
     */
    rehearsal: rehearsal || undefined,
    // Nothing to say on this bar of a watch window — recorded rather than
    // returned silently, because "asked and answered nothing" and "never asked"
    // are the two cases this file exists to tell apart.
    quiet: quiet || undefined,
    funnel: {
      cards: num(universe && universe.cards),
      kept: num(universe && universe.kept),
      // Why the filter removed them, as counts by reason — the gate is the
      // stage most likely to be blamed for the wrong thing.
      filtered: gate && gate.filtered ? (gate.reasons || {}) : undefined,
      evaluated: num(counts && counts.evaluated),
      signalled: num(counts && counts.signalled),
      errored: num(counts && counts.skipped),
      picked: picks.length,
    },
    rank: rank && (rank.metric || rank.ignored_top_n) ? {
      metric: rank.metric || null,
      direction: rank.direction || null,
      topN: num(rank.top_n),
      // A cut asked for and not honoured: "top 2" of an unordered list is two
      // arbitrary names, and it looks exactly like a working ranking.
      ignoredTopN: num(rank.ignored_top_n) || undefined,
      unscorable: (rank.unscorable || []).length ? rank.unscorable : undefined,
    } : undefined,
    // NAMES, not counts, for the last stages — by here the list is short and a
    // name is something you can go and put on a chart.
    dropped: dropped && (
      (dropped.stale || []).length || (dropped.latched || []).length
    ) ? {
      // Found on a bar it could not act on: the price is stale AND the name may
      // not have been on the watchlist yet, which is the gate the backtest applies.
      stale: (dropped.stale || []).length ? dropped.stale : undefined,
      // Already alerted today — the once-per-name latch.
      latched: (dropped.latched || []).length ? dropped.latched : undefined,
    } : undefined,
    picks: picks.map(p => ({
      ticker: p.ticker,
      side: p.signal || p.side || null,
      at: p.decisionAt || null,
      entry: num(p.plan && p.plan.entry),
      stop: num(p.plan && p.plan.stop),
      target: num(p.plan && p.plan.target),
      metric: num(p.extension),
      shares: num(p.shares),
      // Per destination: what it was sized for and what came back. "40 asked,
      // 12 sent" needs both numbers, and with two accounts the interesting case
      // is the one where they disagree.
      orders: ((orders || {})[p.ticker] || []).map(o => ({
        to: o.destination || o.broker || null,
        sizedFor: num(o.sizedFor),
        sent: !!o.sent,
        qty: num(o.quantity),
        status: o.status || undefined,
        skipped: o.skipped || undefined,
        partial: o.partial || undefined,
        error: o.sent ? undefined : (o.error || undefined),
      })),
    })),
    // WHICH RULE SIZED IT AND WHERE THAT RULE CAME FROM. The share count is the
    // number that is checked first and it cannot be checked without these: the
    // same $250 means one thing as a flat figure and another as half a percent.
    risk: riskCfg ? {
      rule: riskCfg.riskRule || null,
      from: (riskCfg.sources || {}).risk || null,
      perTrade: num(riskCfg.riskPerTrade),
      pct: num(riskCfg.riskPct),
      accountSize: num(riskCfg.accountSize),
      // One level naming both rules — a real ambiguity, not the ordinary case
      // of a setup overriding its account.
      conflicts: (riskCfg.conflicts || []).length ? riskCfg.conflicts : undefined,
      legacy: riskCfg.legacy || undefined,
    } : undefined,
    routing: routing ? {
      // NAMES ONLY. A destination config carries that account's own Alpaca key
      // and secret, and this file is read, copied and pasted into questions.
      // The caller passes `to` already reduced; the fallback is here so a future
      // caller that hands over the raw configs still cannot write one out.
      to: Array.isArray(routing.to) ? routing.to
        : (routing.cfgs || []).map(c => c.destinationName || c.destinationId),
      // The reason nothing was sent, which is the difference between a desk
      // that alerts on purpose and one that quietly stopped trading.
      error: routing.error || undefined,
      orderable: routing.orderable === undefined ? undefined : !!routing.orderable,
      blocking: (routing.blocking || []).length ? routing.blocking : undefined,
    } : undefined,
    feed: data ? {
      used: data.feed || null,
      mixed: data.mixed || undefined,
      // Ranked against nothing: a gap in the universe changes the ranking,
      // because the ranking is over the universe.
      missing: (data.missing || []).length ? data.missing : undefined,
      coverage: num(data.coverage),
      /*
       * WHICH BAR THE ANSWER WAS ABOUT. Coverage says how many symbols had
       * bars; it says nothing about WHEN those bars were. A delayed feed has
       * 100% coverage of a market fifteen minutes ago, and that reads on this
       * page as a perfectly healthy run.
       */
      askedBar: data.askedBar || undefined,
      lastBar: data.lastBar || undefined,
      lagMin: num(data.lagMin),
    } : undefined,
  };
}

/** Every pass recorded for a date, oldest first. */
function read(date) {
  let raw;
  try { raw = fs.readFileSync(fileFor(date), 'utf8'); } catch { return []; }
  const out = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const o = JSON.parse(line);
      if (!date || o.date === date) out.push(o);
    } catch { /* one bad line does not spoil the day */ }
  }
  return out.sort((a, b) => (a.at || 0) - (b.at || 0));
}

/**
 * The day for one position, as a story rather than 390 rows.
 *
 * The point of the file is the SHAPE of a day — where the stop went, when the
 * rule came close — and 390 near-identical lines hide that as thoroughly as
 * having no file at all. So consecutive passes that say the same thing are
 * collapsed, and only the changes are returned.
 */
function trackOf(date, symbol) {
  const want = String(symbol || '').toUpperCase();
  const out = [];
  let last = null;
  // Passes only. A run row carries picks, not positions, and reading it here
  // would be reading the entry side's answer as an exit-side observation.
  for (const pass of read(date).filter(isPass)) {
    const p = (pass.positions || []).find(x => String(x.symbol).toUpperCase() === want);
    if (!p) continue;
    // The fields whose CHANGE is the story. `barsHeld` moves every minute by
    // definition, so it is carried but never counted as a change — otherwise
    // nothing would ever collapse.
    const key = JSON.stringify([p.stop, p.breached, p.exitNow, p.wrongSide,
                                p.error, p.skipped,
                                pass.heldAtBroker === null
                                  ? null : pass.heldAtBroker.includes(want)]);
    if (key === last) continue;
    last = key;
    out.push({ at: pass.at, ...p,
               heldAtBroker: pass.heldAtBroker === null ? null
                 : pass.heldAtBroker.includes(want) });
  }
  return out;
}

/** Every name the manager looked at on a date, in the order it first saw them. */
function symbolsOn(date) {
  const seen = [];
  for (const pass of read(date).filter(isPass)) {
    for (const p of pass.positions || []) {
      const s = String(p.symbol || '').toUpperCase();
      if (s && !seen.includes(s)) seen.push(s);
    }
  }
  return seen;
}

/*
 * A row from before `kind` existed has none. It is a management pass — it has
 * `positions`, which a run never does. Written once here so the two readers
 * below and anything added later cannot disagree about it.
 */
function isRun(row) { return row && row.kind === 'run'; }
function isPass(row) { return row && (row.kind === 'pass' || (!row.kind && row.positions)); }

/** Every decision recorded on a date, oldest first; one setup if named. */
function runsOn(date, setupId) {
  return read(date).filter(r => isRun(r)
    && (!setupId || r.setupId === setupId));
}

/** Every management sweep on a date, oldest first. */
function passesOn(date) {
  return read(date).filter(isPass);
}

/**
 * The day in one object: what each setup was asked, and where the names went.
 *
 * The question this answers is "did the desk do what I set it up to do today",
 * and the honest answer is a funnel per setup rather than a count of alerts —
 * because the alerts are only the names that survived every stage, and the
 * stages are where a strategy stops being the one that was tested.
 */
function summaryOf(date) {
  const out = {};
  /*
   * REHEARSALS ARE RECORDED AND NOT COUNTED.
   *
   * A rehearsal is a check of the machine, taken on the current minute rather
   * than the setup's, publishing nothing. Summed in with the day's runs it
   * would show extra runs on bars the setup was never asked about, and — since
   * a rehearsal at 14:00 on a delayed feed measures a large lag by design — it
   * would report the feed as broken on a day it was fine.
   *
   * They stay in the log, because "I pressed Rehearse at 14:02 and it answered"
   * is exactly the thing worth being able to look up afterwards.
   */
  for (const r of runsOn(date).filter(x => !x.rehearsal)) {
    const g = out[r.setupId] || (out[r.setupId] = {
      setup: r.setup || r.setupId, runs: 0, failed: 0, quiet: 0,
      // The last bar it was asked about, so "it stopped running at 09:52" is
      // visible without reading every row.
      firstBar: r.bar || null, lastBar: null, msMax: 0,
      evaluated: 0, signalled: 0, picked: 0,
      staleDropped: 0, latched: 0,
      /*
       * THE SAME NAME ON NINETY BARS IS ONE SIGNAL, NOT NINETY.
       *
       * This file already says so, a few lines down, about `problems`: "the
       * same refusal on 31 bars of a watch window is one fact, not 31". The
       * counters did not follow the rule, and on 2026-09-03 the desk read:
       *
       *     1013 EVALUATED · 180 SIGNALLED · 0 TAKEN
       *     180 dropped as stale: GEO@09:45, IBKR@09:41
       *
       * Two names. qp re-reports every entry of the session on every bar it is
       * asked about (see runner.js's stale guard), so a watch setup running
       * ninety times counts the same two picks ninety times. "180 signalled, 0
       * taken" reads as a desk finding trades all morning and refusing them;
       * the truth is it found two, both before it could act, and said so 180
       * times.
       *
       * So the sums stay — they are the honest total of what qp answered — and
       * the DISTINCT counts sit beside them. The page shows the distinct one.
       */
      signalledBars: 0,          // how many runs reported at least one signal
      staleNames: [],            // distinct TICKER@HH:MM, in order first seen
      staleRepeats: 0,           // how many times those names came back
      ordersSent: 0, ordersFailed: 0, ordersSkipped: 0,
      // Only the reasons, deduped — the same refusal on 31 bars of a watch
      // window is one fact, not 31.
      problems: [],
    });
    g.runs += 1;
    if (r.ok === false) g.failed += 1;
    if (r.quiet) g.quiet += 1;
    if (r.bar) g.lastBar = r.bar;
    if (typeof r.ms === 'number') g.msMax = Math.max(g.msMax, r.ms);
    const f = r.funnel || {};
    g.evaluated += f.evaluated || 0;
    g.signalled += f.signalled || 0;
    if (f.signalled) g.signalledBars += 1;
    g.picked += f.picked || 0;
    // `TICKER@HH:MM` already identifies the signal — the name AND the bar it
    // fired on — so the string is the key and nothing has to be composed.
    for (const s of ((r.dropped || {}).stale || [])) {
      if (g.staleNames.includes(s)) g.staleRepeats += 1;
      else g.staleNames.push(s);
    }
    g.staleDropped = g.staleNames.length;
    g.latched += ((r.dropped || {}).latched || []).length;
    for (const p of r.picks || []) {
      for (const o of p.orders || []) {
        if (o.sent) g.ordersSent += 1;
        else if (o.skipped) g.ordersSkipped += 1;
        else g.ordersFailed += 1;
      }
    }
    /*
     * THE WORST LAG OF THE DAY, and how many bars had one.
     *
     * The single fact that separates "the market was quiet" from "the desk was
     * looking at the market fifteen minutes ago". It belongs in the summary
     * rather than only on each run, because on a delayed feed EVERY run has it
     * and the reader needs one line, not ninety.
     */
    const lag = (r.feed || {}).lagMin;
    if (typeof lag === 'number') {
      g.lagMaxMin = Math.max(g.lagMaxMin || 0, lag);
      if (lag >= LAG_BAD_MIN) {
        g.lagBars = (g.lagBars || 0) + 1;
        g.lagFeed = (r.feed || {}).used || g.lagFeed || null;
      }
    }

    const note = (s) => { if (s && !g.problems.includes(s)) g.problems.push(s); };
    if (r.error) note(r.error);
    if ((r.routing || {}).error) note(r.routing.error);
    for (const c of (r.risk || {}).conflicts || []) note(c);
    if ((r.risk || {}).legacy) note(r.risk.legacy);
    if ((r.rank || {}).ignoredTopN) {
      note(`"top ${r.rank.ignoredTopN}" ignored — no ranking metric is set`);
    }
  }

  /*
   * SAID ONCE PER SETUP, AFTER THE WHOLE DAY IS READ.
   *
   * Not inside the loop: the worst lag grows as more runs are counted, so the
   * sentence would change and the deduping — which matches on the exact string
   * — would let three near-identical lines through. One line, with the final
   * number, is the point of a summary.
   */
  for (const g of Object.values(out)) {
    if (g.lagBars) {
      g.problems.push(`the '${g.lagFeed || 'feed'}' feed ran up to `
        + `${g.lagMaxMin} minutes behind on ${g.lagBars} of ${g.runs} runs — `
        + 'the levels came from an older bar, and any signal found on one is '
        + 'refused as stale. A one-minute setup cannot run on a delayed feed.');
    }
  }
  return out;
}

module.exports = {
  record, passOf, runOf, read, trackOf, symbolsOn,
  runsOn, passesOn, summaryOf, isRun, isPass, fileFor, LOG_DIR,
};
