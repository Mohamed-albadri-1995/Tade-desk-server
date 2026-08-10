/*
 * Running a setup, and turning its picks into alerts you actually receive.
 *
 * This file knows about the clock, the card list and the alert feed. It does
 * not know how the setup decides anything — that is qp's, entirely. The
 * strategy is a seed built from qp primitives and the ranking is
 * chart/decide.py, using the same metric a backtest uses.
 *
 * There used to be a second implementation here, in JavaScript. Two engines for
 * one strategy means two readings of "ten bars back" and a live trade that can
 * disagree with the backtest that justified it, with no way to tell which is
 * right because both look correct. It is gone.
 *
 * A run always publishes something. If nothing qualifies, that is an answer —
 * "looked at 34, nothing qualified" — and it is the answer that stops you
 * wondering at 10:05 whether the thing ran at all. Silence and failure are
 * indistinguishable from a phone, so the setup never goes silent.
 */

const config = require('../config');
const r0 = require('../r0/registry');
const { toETDate } = require('../utils/time');
const catalog = require('./catalog');
const qp = require('./qpClient');
const risk = require('./risk');
const universeFilter = require('./universe');
const prefs = require('./prefs');
const broker = require('../broker/signalstack');
const alertStore = require('../alerts/store');

/** The minute before the decision — the last bar that must have closed. */
function lastWantedBar(decisionTime) {
  const [h, m] = String(decisionTime).split(':').map(Number);
  const prev = h * 60 + m - 1;
  return `${String(Math.floor(prev / 60)).padStart(2, '0')}:${String(prev % 60).padStart(2, '0')}`;
}

/** This tool's card list for today — the rows, not just the tickers. */
function universeRows() {
  return r0.getTodayRows().filter(r => r && r.ticker);
}

/** The universe: this tool's card list for today, and nothing else about it. */
function universe() {
  return universeRows().map(row => String(row.ticker).toUpperCase());
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
 * What the broker did, in the same sentence as the trade.
 *
 * Appended to the detail line rather than added below it, because the detail
 * line is what a notification shows on a locked phone — and "did it actually go
 * in" is the second thing anyone wants to know there. Silence would read as
 * "yes": an alert that looks identical whether or not an order was placed is
 * the one failure this must not have.
 */
function orderLine(o) {
  if (!o) return '';
  if (o.skipped) return ` · ORDER: not sent (${o.skipped})`;
  if (!o.sent) return ` · ORDER FAILED — ${o.error || 'refused'}. Place it by hand.`;
  const filled = o.status === 'filled';
  return ` · ORDER ${filled ? 'FILLED' : String(o.status || 'accepted').toUpperCase()}`
    + ` ${o.quantity}${o.fillPrice ? ` @ ${o.fillPrice}` : ''}`
    // A scale-out is several orders and one position. Said plainly, because
    // three confirmations at the broker for one signal is otherwise alarming.
    + `${o.scaleOut > 1 ? ` in ${o.scaleOut} legs` : ''}`
    + `${o.bracket ? ' with stop+target' : ' — STOP NOT SENT, place it'}`
    + `${o.partial ? ' — PARTIAL: ' + (o.error || 'some legs did not go in') : ''}`
    + `${o.reduced ? ` (${o.reduced})` : ''}`;
}

/*
 * The part of the strategy's exit that a broker cannot be handed.
 *
 * A stop that follows an indicator — the 9 EMA, session VWAP — is wherever that
 * line sits on each bar. No broker-side trailing stop can follow it, so what
 * goes out is the frozen level and the trade needs managing by hand. Saying so
 * on the alert is the difference between knowing that and finding out.
 */
function unmanagedLine(plan) {
  if (!plan) return '';
  const notes = [];
  if (plan.stop_anchored) {
    notes.push('the stop trails an indicator — sent as a fixed level, so it will '
      + 'NOT follow. Manage it yourself');
  }
  if (plan.breakeven_after_leg) {
    notes.push('moves to breakeven after the first leg — the broker will not do '
      + 'that, move it yourself');
  }
  const anchored = (plan.legs || []).filter(l => l && l.anchored).length;
  if (anchored) {
    notes.push(`${anchored} target(s) follow an indicator and cannot rest at the `
      + 'broker — that part rides the stop');
  }
  return notes.length ? ` · NOTE: ${notes.join('; ')}.` : '';
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

  // A setup names the tools it belongs to — the qp strategy carries them — so a
  // setup used by three tools is one object rather than three copies that drift.
  const owners = setup.tools || (setup.toolId ? [setup.toolId] : []);
  if (owners.length && !owners.includes(config.toolId) && !dryRun) {
    return { ok: false, reason: `belongs to ${owners.join(', ')}, this is ${config.toolId}` };
  }

  /*
   * The card-field layer, applied BEFORE qp rather than after.
   *
   * qp has never heard of bias, score or catalyst — they exist only on a card —
   * so this is the one thing it cannot do rather than a duplicate of anything.
   * It runs first because the setup ranks and takes the top two: filtering
   * afterwards means the filter eats picks and leaves gaps, while filtering
   * first means the ranking happens among the names that would actually be
   * taken. It is also the difference between evaluating twelve symbols at 10:00
   * and evaluating forty.
   */
  let list;
  let gate = { filtered: false, kept: [], dropped: [], reasons: {} };
  if (tickers && tickers.length) {
    list = tickers;
  } else {
    const rows = universeRows();
    gate = universeFilter.apply(rows, setup.universe);
    list = gate.kept.map(r => String(r.ticker).toUpperCase());
  }

  if (!list.length && gate.filtered && gate.dropped.length) {
    // Distinct from "no cards": the tool found stocks and the filter removed
    // every one. That is a fact about the filter, and a filter nobody can see
    // working is a filter that gets blamed for the wrong thing.
    const fire = {
      ruleId: setup.id, rule: setup.name, ticker: null, toolId: config.toolId,
      date: day, at: Date.now(), kind: 'setup', level: 'info',
      detail: `All ${gate.dropped.length} card(s) were removed by the filter `
        + `(${universeFilter.describe(setup.universe)}). `
        + Object.entries(gate.reasons).map(([k, n]) => `${n}× ${k}`).join('; '),
    };
    if (!dryRun) alertStore.publishFires([fire], day);
    return { ok: true, picks: [], universe: 0, gate, fires: [fire] };
  }

  if (!list.length) {
    const fire = {
      ruleId: setup.id, rule: setup.name, ticker: null, toolId: config.toolId,
      date: day, at: Date.now(), kind: 'setup', level: 'info',
      detail: 'No cards on the list at the decision — nothing to rank.',
    };
    if (!dryRun) alertStore.publishFires([fire], day);
    return { ok: true, picks: [], universe: 0, fires: [fire] };
  }

  /*
   * The decision itself belongs to qp, and nothing here recomputes any part of
   * it. The strategy is a seed built from qp primitives; the ranking is
   * chart/decide.py using the same metric a backtest uses. This function hands
   * over the card list and formats what comes back.
   */
  const decided = await qp.decide({
    strategyId: setup.strategyId,
    symbols: list,
    date: day,
    tf: setup.tf || '1m',
    feed: setup.feed || 'yahoo',
    topN: (setup.rank && setup.rank.topN) || 2,
    targetR: setup.targetR || 2.0,
    fill: setup.fill || 'close',
  });

  // qp's shape, translated once into the shape the alerts already speak. Every
  // number comes from qp — none is recalculated here.
  const out = {
    picks: (decided.picks || []).map(p => ({
      ticker: p.symbol,
      signal: String(p.side || '').toUpperCase(),
      extension: p.metric,
      decisionAt: p.entry_at,
      exitPlan: p.exit_plan || null,
      decisionVwap: p.stop,        // the stop IS the session VWAP, frozen
      decisionClose: p.entry,
      rangePosition: null,         // qp asserts it in the rules; it is not returned
      plan: {
        entry: p.entry, stop: p.stop, risk: p.risk,
        riskPct: p.risk_pct, target: p.target, targetR: p.target_r,
      },
    })),
    counts: {
      evaluated: (decided.counts && decided.counts.evaluated) || list.length,
      signalled: (decided.counts && decided.counts.signalled) || 0,
      invalidated: 0,              // qp rejects inside the strategy, not as a stage
      skipped: (decided.counts && decided.counts.errored) || 0,
    },
  };

  // What the fetch used to report about its own quality now comes from qp, or
  // is simply not knowable from here. Kept in the same shape so the alert
  // formatting below did not have to change.
  const data = {
    sources: Object.fromEntries((decided.picks || []).map(p => [p.symbol, decided.feed])),
    missing: (decided.errors || []).map(e => e.symbol),
    degraded: decided.feed === 'alpaca' ? (decided.picks || []).map(p => p.symbol) : [],
    used: [decided.feed], feed: decided.feed, mixed: false,
    coverage: list.length ? 1 - ((decided.errors || []).length / list.length) : 1,
    waitedMs: 0, attempts: 1,
  };

  // Read once for the whole run, so both picks are sized against the same
  // settings even if they are edited while this is executing.
  const riskCfg = risk.settings();

  /*
   * The orders, placed before the alerts are published.
   *
   * That order matters. The entry is taken at market on sight, so the seconds
   * between the decision and the order are the difference between the price
   * that was ranked and the price that is paid — and publishing first would
   * spend them formatting text. The alert then CARRIES what the broker did, so
   * one message answers "what fired" and "did it go in".
   *
   * Sequential rather than parallel: the second order is sized against what the
   * first one actually committed, and firing both at once would size both
   * against the full buying power and overspend it by design.
   */
  const orders = {};
  /*
   * TWO switches have to be on, and they mean different things.
   *
   *   the broker is ARMED   this box may place orders at all — one decision for
   *                         the account, made on the alerts page
   *   the setup AUTO-TRADES  this particular strategy may place them
   *
   * One switch would have meant that arming to trade a strategy you have
   * backtested for months also arms the scalp you assigned to a tool five
   * minutes ago to see what it does. The strategy earns it separately, and the
   * default for a strategy that has never said so is no.
   */
  if (!dryRun && setup.autoTrade === true) {
    for (const pick of out.picks) {
      const size = risk.sizeFor(
        { entry: pick.plan.entry, riskPerShare: pick.plan.risk }, riskCfg);
      if (!size || !(size.shares > 0)) continue;
      try {
        orders[pick.ticker] = await broker.placeOrder({
          symbol: pick.ticker,
          signal: pick.signal,
          quantity: size.shares,
          price: pick.plan.entry,
          // The stop is the frozen VWAP and the target is 2R — both decided at
          // this same instant, so they go with the entry as a bracket rather
          // than being left for whoever reaches their phone first.
          stop: pick.plan.stop,
          target: pick.plan.target,
          date: day,
          source: `${setup.id} (${config.toolId})`,
          // Both caps are enforced in the broker, against the ledger, so a
          // restart between the two picks cannot hand the allowance back.
          setupId: setup.id,
          maxPerDay: setup.maxTradesPerDay || null,
          // The strategy's OWN exit plan — its scale-out legs and whether its
          // stop trails — straight from qp. Without it every trade was given a
          // single 2R target whatever the strategy said, which for a
          // scale-out strategy is not a smaller version of the tested trade,
          // it is a different one.
          plan: pick.exitPlan || null,
        });
      } catch (err) {
        // A broker that cannot be reached must not stop the alert. The alert is
        // the thing you can still act on by hand; losing it because the
        // automatic path failed would turn a degraded morning into a blind one.
        orders[pick.ticker] = { sent: false, error: err.message };
      }
    }
  }

  const fires = out.picks.map(pick => {
    const size = risk.sizeFor(
      { entry: pick.plan.entry, riskPerShare: pick.plan.risk }, riskCfg);
    return {
    ruleId: setup.id,
    rule: setup.name,
    ticker: pick.ticker,
    toolId: config.toolId,
    date: day,
    at: Date.now(),
    kind: 'setup',
    level: 'trade',
    detail: describePick(pick, size) + orderLine(orders[pick.ticker])
      + unmanagedLine(pick.exitPlan),
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
      // Kept on the fire so the record shows the exit the strategy asked for,
      // not just the one leg that fitted in the alert text.
      exitPlan: pick.exitPlan,
      // What the broker did with it, on the alert itself. One message answers
      // both "what fired" and "did it go in" — two messages, or a state you
      // have to go and look up, is how a rejected order becomes a position
      // somebody believes they are holding.
      order: orders[pick.ticker] || null,
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

  /*
   * What the filter did, when there was one. A gate that silently halves the
   * universe is a gate you cannot audit: two picks out of forty and two out of
   * twelve are different statements about the same morning, and only one of
   * them is what happened.
   */
  if (gate.filtered) {
    fires.push({
      ruleId: setup.id, rule: setup.name, ticker: null, toolId: config.toolId,
      date: day, at: Date.now(), kind: 'setup', level: 'info',
      detail: `Filter: ${gate.kept.length + gate.dropped.length} card(s) → `
        + `${gate.kept.length} passed (${universeFilter.describe(setup.universe)})`
        + (Object.keys(gate.reasons).length
          ? ` · removed by ${Object.entries(gate.reasons)
            .map(([k, n]) => `${n}× ${k}`).join('; ')}`
          : ''),
    });
  }

  // Always say something, including "nothing". From a phone, a setup that
  // published nothing and a setup that never ran look exactly the same.
  if (!fires.length) {
    fires.push({
      ruleId: setup.id, rule: setup.name, ticker: null, toolId: config.toolId,
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
      ruleId: setup.id, rule: setup.name, ticker: null, toolId: config.toolId,
      date: day, at: Date.now(), kind: 'setup', level: 'warn',
      detail: `Ranked across mixed feeds (${data.used.join(' + ')}) — no single feed `
        + 'covered the list. Extensions from different tapes are not directly '
        + 'comparable, so the choice of the top 2 is less reliable than usual.',
    });
  }

  // A gap in the universe changes the ranking, because the ranking is over the
  // universe. Worth its own line rather than a footnote on a pick.
  if (data.missing.length) {
    fires.push({
      ruleId: setup.id, rule: setup.name, ticker: null, toolId: config.toolId,
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
    gate: { filtered: gate.filtered, kept: list.length, dropped: gate.dropped.length },
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
  // Read live, so a strategy built in qp this morning runs this morning and one
  // deleted there stops — the whole reason the catalog is not a snapshot.
  const mine = (await catalog.forTool(config.toolId))
    .filter(s => s.decisionTime === decisionTime)
    // Switched off from the alerts page. Silently skipped rather than
    // publishing "nothing qualified": you turned it off, and a message every
    // morning saying so is the thing that makes people stop reading the feed.
    .filter(s => prefs.isEnabled(s.id));
  const out = [];
  for (const setup of mine) {
    try {
      out.push(await runSetup(setup, opts));
    } catch (err) {
      console.error(`[Setups] ${setup.id} failed:`, err.message);
      // A crash must not be silence either.
      const day = opts.date || toETDate(Date.now());
      alertStore.publishFires([{
        ruleId: setup.id, rule: setup.name, ticker: null, toolId: config.toolId,
        date: day, at: Date.now(), kind: 'setup', level: 'error',
        detail: `Did not run: ${err.message}`,
      }], day);
      out.push({ ok: false, setupId: setup.id, error: err.message });
    }
  }
  return out;
}

module.exports = {
  runSetup, runDue, universe, describePick, lastWantedBar, orderLine, unmanagedLine,
};
