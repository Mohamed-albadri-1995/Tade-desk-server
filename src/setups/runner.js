/*
 * Running a setup, and turning its picks into alerts you actually receive.
 *
 * The pieces are deliberately separate: vwapExtension.js decides, bars.js
 * fetches, and this file is the only thing that knows about the clock, the
 * registry and the alert feed. That is what lets the decision be tested against
 * the spec without a network, and lets this be read as "where does the data
 * come from and where does the answer go".
 *
 * A run always publishes something. If nothing qualifies, that is an answer —
 * "looked at 34, nothing qualified" — and it is the answer that stops you
 * wondering at 10:05 whether the thing ran at all. Silence and failure are
 * indistinguishable from a phone, so the setup never goes silent.
 */

const config = require('../config');
const r0 = require('../r0/registry');
const { toETDate } = require('../utils/time');
const setups = require('./index');
const barsSource = require('./bars');
const risk = require('./risk');
const alertStore = require('../alerts/store');

/** The minute before the decision — the last bar that must have closed. */
function lastWantedBar(decisionTime) {
  const [h, m] = String(decisionTime).split(':').map(Number);
  const prev = h * 60 + m - 1;
  return `${String(Math.floor(prev / 60)).padStart(2, '0')}:${String(prev % 60).padStart(2, '0')}`;
}

/** The universe: this tool's card list for today, and nothing else about it. */
function universe() {
  return r0.getTodayRows()
    .map(row => String(row.ticker || '').toUpperCase())
    .filter(Boolean);
}

/**
 * One line a person can act on from a notification, without opening anything.
 * Direction, ticker, where the stop is and where the target is — the four
 * things needed to place the trade.
 */
function describePick(pick, size) {
  const p = pick.plan;
  const side = pick.signal === 'LONG' ? 'BUY' : 'SHORT';
  // The share count leads when it is known, because it is the part you cannot
  // work out in your head while the bar you are entering on is forming.
  const qty = size && size.shares > 0 ? `${size.shares} ` : '';
  return `${side} ${qty}${pick.ticker} — now ~${p.entry.toFixed(2)}, `
    + `stop ${p.stop.toFixed(2)} (VWAP, fixed), target ${p.target.toFixed(2)} `
    + `· risk ${p.riskPct.toFixed(2)}% · ${pick.extension.toFixed(2)}% from VWAP`;
}

/**
 * Run one setup and publish the result.
 *
 * `dryRun` computes everything and publishes nothing — that is what the preview
 * endpoint uses, so a setup can be inspected on a past date without putting
 * yesterday's trades into today's alert feed.
 */
async function runSetup(setup, { date, dryRun = false, tickers = null } = {}) {
  const day = date || toETDate(Date.now());
  const started = Date.now();

  if (setup.toolId !== config.toolId && !dryRun) {
    return { ok: false, reason: `belongs to ${setup.toolId}, this is ${config.toolId}` };
  }

  const list = tickers && tickers.length ? tickers : universe();
  if (!list.length) {
    const fire = {
      ruleId: setup.id, rule: setup.name, ticker: null, toolId: setup.toolId,
      date: day, at: Date.now(), kind: 'setup', level: 'info',
      detail: 'No cards on the list at the decision — nothing to rank.',
    };
    if (!dryRun) alertStore.publishFires([fire], day);
    return { ok: true, picks: [], universe: 0, fires: [fire] };
  }

  const fetched = await barsSource.fetchMorning(list, day, {
    lastWanted: lastWantedBar(setup.decisionTime),
  });
  // Defaults for every field this function reads. The fetch reports a lot about
  // its own quality and every one of those fields is optional to produce, so a
  // missing one must degrade the ALERT's detail, never take out the run that
  // was about to name two trades.
  const data = {
    bars: {}, sources: {}, missing: [], degraded: [], used: [],
    feed: null, mixed: false, coverage: 1, waitedMs: 0, attempts: 1,
    ...fetched,
  };

  const out = setup.module.run(data.bars, setup.params);

  // Read once for the whole run, so both picks are sized against the same
  // settings even if they are edited while this is executing.
  const riskCfg = risk.settings();

  const fires = out.picks.map(pick => {
    const size = risk.sizeFor(
      { entry: pick.plan.entry, riskPerShare: pick.plan.risk }, riskCfg);
    return {
    ruleId: setup.id,
    rule: setup.name,
    ticker: pick.ticker,
    toolId: setup.toolId,
    date: day,
    at: Date.now(),
    kind: 'setup',
    level: 'trade',
    detail: describePick(pick, size),
    price: pick.plan.entry,
    // Everything the card cannot show but the trade needs. Kept on the fire so
    // the record of what was signalled survives the day it was signalled.
    setup: {
      signal: pick.signal,
      extension: pick.extension,
      entry: pick.plan.entry,
      stop: pick.plan.stop,
      target: pick.plan.target,
      risk: pick.plan.risk,
      riskPct: pick.plan.riskPct,
      decisionVwap: pick.decisionVwap,
      decisionClose: pick.decisionClose,
      rangePosition: pick.rangePosition,
      // Which minute the decision was actually taken on. Normally 09:59; when
      // the feed had not published it inside the deadline it is the last bar
      // that existed, and that changes both the close and the VWAP slightly.
      decisionAt: pick.decisionAt,
      source: data.sources[pick.ticker] || 'unknown',
      caution: setup.caution,
      // Only where it applies. IEX volume is a fraction of the tape, so this
      // stop is not the level a chart would draw.
      feedWarning: data.degraded.includes(pick.ticker)
        ? 'VWAP from the IEX feed only — the chart\'s VWAP will differ. Check before using this stop.'
        : null,
      // null when account size and risk per trade have not been set. An
      // invented size is worse than none: it looks like a decision.
      size,
    },
    };
  });

  // Always say something, including "nothing". From a phone, a setup that
  // published nothing and a setup that never ran look exactly the same.
  if (!fires.length) {
    fires.push({
      ruleId: setup.id, rule: setup.name, ticker: null, toolId: setup.toolId,
      date: day, at: Date.now(), kind: 'setup', level: 'info',
      detail: `Nothing qualified. ${out.counts.evaluated} evaluated, `
        + `${out.counts.signalled} had a direction, ${out.counts.invalidated} invalidated`
        + `${out.counts.skipped ? `, ${out.counts.skipped} short of bars` : ''}.`,
    });
  }

  /*
   * The ranking is only as comparable as the tape underneath it. Extension
   * decides which two names are taken, extension comes from VWAP, and VWAP
   * comes from volume — so candidates measured on different feeds were not
   * ranked against each other on the same ruler. That is a caveat about the
   * SELECTION, not about any one pick, so it gets its own line.
   */
  if (data.mixed) {
    fires.push({
      ruleId: setup.id, rule: setup.name, ticker: null, toolId: setup.toolId,
      date: day, at: Date.now(), kind: 'setup', level: 'warn',
      detail: `Ranked across mixed feeds (${data.used.join(' + ')}) — no single feed `
        + 'covered the list. Extensions from different tapes are not directly '
        + 'comparable, so the choice of the top 2 is less reliable than usual.',
    });
  }

  /*
   * The decision was taken on an earlier bar than intended.
   *
   * The 09:59 bar closes at 10:00:00.000 and no feed is obliged to have
   * published it by then. Rather than wait past the minute the trade is worth
   * entering in, the run decides on the last bar that existed — which is the
   * right trade-off and still a different decision from the tested one, so it
   * is said out loud rather than absorbed.
   */
  const wanted = lastWantedBar(setup.decisionTime);
  const early = out.picks.filter(p => p.decisionAt && p.decisionAt < wanted);
  if (early.length) {
    fires.push({
      ruleId: setup.id, rule: setup.name, ticker: null, toolId: setup.toolId,
      date: day, at: Date.now(), kind: 'setup', level: 'warn',
      detail: `The ${wanted} bar had not been published, so `
        + `${early.map(p => `${p.ticker} was decided on ${p.decisionAt}`).join(' and ')}`
        + '. Close and VWAP differ slightly from the tested setup.',
    });
  }

  // A gap in the universe changes the ranking, because the ranking is over the
  // universe. Worth its own line rather than a footnote on a pick.
  if (data.missing.length) {
    fires.push({
      ruleId: setup.id, rule: setup.name, ticker: null, toolId: setup.toolId,
      date: day, at: Date.now(), kind: 'setup', level: 'warn',
      detail: `No ${lastWantedBar(setup.decisionTime)} bar for `
        + `${data.missing.slice(0, 8).join(', ')}`
        + `${data.missing.length > 8 ? ` +${data.missing.length - 8} more` : ''}`
        + ' — these were ranked against nothing and could not be picked.',
    });
  }

  if (!dryRun) alertStore.publishFires(fires, day);

  const result = {
    ok: true,
    setupId: setup.id,
    date: day,
    universe: list.length,
    picks: out.picks,
    counts: out.counts,
    data: {
      feed: data.feed,
      mixed: data.mixed,
      used: data.used,
      coverage: data.coverage,
      missing: data.missing,
      degraded: data.degraded,
      waitedMs: data.waitedMs,
      attempts: data.attempts,
    },
    tookMs: Date.now() - started,
    fires,
  };
  console.log(`[Setups] ${setup.id}: ${out.picks.length} pick(s) from ${list.length} cards `
    + `on ${data.feed || data.used.join('+') || 'no feed'} `
    + `(${Math.round(data.coverage * 100)}% had bars, waited ${Math.round(data.waitedMs / 1000)}s)`);
  return result;
}

/** Every setup this tool owns, run in turn. Used by the scheduler. */
async function runDue(decisionTime, opts = {}) {
  const mine = setups.forTool(config.toolId).filter(s => s.decisionTime === decisionTime);
  const out = [];
  for (const setup of mine) {
    try {
      out.push(await runSetup(setup, opts));
    } catch (err) {
      console.error(`[Setups] ${setup.id} failed:`, err.message);
      // A crash must not be silence either.
      const day = opts.date || toETDate(Date.now());
      alertStore.publishFires([{
        ruleId: setup.id, rule: setup.name, ticker: null, toolId: setup.toolId,
        date: day, at: Date.now(), kind: 'setup', level: 'error',
        detail: `Did not run: ${err.message}`,
      }], day);
      out.push({ ok: false, setupId: setup.id, error: err.message });
    }
  }
  return out;
}

module.exports = { runSetup, runDue, universe, describePick, lastWantedBar };
