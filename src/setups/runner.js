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
function describePick(pick) {
  const p = pick.plan;
  const side = pick.signal === 'LONG' ? 'BUY' : 'SHORT';
  return `${side} ${pick.ticker} — now ~${p.entry.toFixed(2)}, `
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

  const data = await barsSource.fetchMorning(list, day, {
    lastWanted: lastWantedBar(setup.decisionTime),
  });

  const out = setup.module.run(data.bars, setup.params);

  const fires = out.picks.map(pick => ({
    ruleId: setup.id,
    rule: setup.name,
    ticker: pick.ticker,
    toolId: setup.toolId,
    date: day,
    at: Date.now(),
    kind: 'setup',
    level: 'trade',
    detail: describePick(pick),
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
      source: data.sources[pick.ticker] || 'unknown',
      caution: setup.caution,
      // Only where it applies. IEX volume is a fraction of the tape, so this
      // stop is not the level a chart would draw.
      feedWarning: data.degraded.includes(pick.ticker)
        ? 'VWAP from the IEX feed only — the chart\'s VWAP will differ. Check before using this stop.'
        : null,
    },
  }));

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
