/*
 * Asking the quant platform to decide a setup.
 *
 * THE POINT OF THIS FILE IS THAT IT CONTAINS NO STRATEGY LOGIC.
 *
 * The strategy lives in qp as a seed built from qp primitives —
 * chart/seeds/t2_vwap_extension.json uses `vwap.session` for the level and the
 * stop, `levels.window_low/high` for the morning range, a risk block with the
 * stop frozen at the anchor and a 2R target, and window_start/window_end to pin
 * entry to one minute. The ranking is chart/decide.py, using the same
 * rank_metric a backtest uses. All of that is the platform's, and it is the
 * only implementation of it.
 *
 * A second implementation in JavaScript was the thing to remove. Two engines
 * for one strategy means two sets of rounding, two readings of "ten bars back",
 * and a live trade that can disagree with the backtest that justified it —
 * with no way to tell which is right, because both look correct.
 *
 * So the screener's job is now: hand over the card list, take back the ranked
 * picks, turn them into alerts. Everything between those is qp's.
 */

const axios = require('axios');

/** Where the platform is. Same box, so localhost and a generous timeout. */
function baseUrl() {
  return process.env.QP_URL || 'http://127.0.0.1:8765';
}

/**
 * Decide a setup: strategies × universe × date → ranked picks.
 *
 * `timeoutMs` is deliberately shorter than it might be. This runs at the
 * decision minute and the trade is entered at market on sight, so a platform
 * that is slow to answer has to become a reported failure rather than a
 * silently late alert.
 */
/*
 * `fill = 'close'` HERE IS CORRECT AND MUST STAY. It is not the optimistic
 * setting it is in a backtest.
 *
 * This call runs at 09:36:00, on the completed 09:35 bar, and the 09:36 bar is
 * zero seconds old. 'close' gives the pick an entry of close[09:35] and prices
 * the stop and every target from it — which is exactly what happens next: the
 * bracket is built from those numbers and sent to the broker. Live and the
 * backtest's 'desk' model agree by construction.
 *
 * Asking for 'desk' or 'next_open' here would ask the simulation to fill on a
 * bar that does not exist yet. It handles that correctly — a signal on the last
 * bar produces no trade — so the decision would return NOTHING, every day, and
 * say "nothing qualified".
 */
async function decide({ strategyId, strategies, symbols, date, tf = '1m',
                        feed = 'yahoo', topN = 0, targetR = 2.0,
                        metric = null, direction = null, ctx = null,
                        fill = 'close', timeoutMs = 45000 }) {
  const body = {
    symbols, date, tf, feed, top_n: topN, target_r: targetR, fill,
    // Named, never assumed — see catalog.js. qp refuses an unknown one rather
    // than guessing, and refuses to invent one when none is given.
    metric, direction, ctx,
  };
  if (strategies) body.strategies = strategies;
  else body.strategy_id = strategyId;

  const res = await axios.post(`${baseUrl()}/api/setup/decide`, body, {
    timeout: timeoutMs,
    headers: { 'Content-Type': 'application/json' },
  });

  const data = res.data || {};
  // qp answers 200 with ok:false for its own errors, so a status check is not
  // enough to know the decision succeeded.
  if (!data.ok) throw new Error(data.error || 'qp could not decide the setup');
  return data;
}

/**
 * What to do with a position that is ALREADY open.
 *
 * The half a broker cannot hold: an exit RULE — no broker watches for a VWAP
 * cross — and a stop that MOVES, when a broker is handed one price and keeps
 * it. Answered by qp from the same functions the backtest uses, so a managed
 * position is managed BY the strategy rather than by a second reading of it.
 *
 * A shorter timeout than the decision, and for the opposite reason: this runs
 * every minute and being late is normal. A slow answer is skipped and asked
 * again next minute; a wrong one would close a position.
 */
async function manage({ name, strategyId, symbol, side, entry, entryIso,
                        stopAtEntry = null, tf = '1m', feed = 'yahoo',
                        days = 2, asof = null, timeoutMs = 20000 }) {
  const body = { symbol, side, entry, entry_iso: entryIso,
                 stop_at_entry: stopAtEntry, tf, feed, days, asof };
  if (strategyId) body.strategy_id = strategyId; else body.name = name;

  const res = await axios.post(`${baseUrl()}/api/strategy/manage`, body, {
    timeout: timeoutMs,
    headers: { 'Content-Type': 'application/json' },
  });
  const data = res.data || {};
  // qp answers 200 with ok:false for its own errors. An unanswered question is
  // NOT "hold" — the caller has to be able to tell the two apart.
  if (!data.ok) throw new Error(data.error || 'qp could not manage the position');
  return data;
}

/**
 * Every strategy saved in qp.
 *
 * This is what makes the setups list live rather than copied: build a strategy
 * there, give it tools, and it appears in the screener; edit it and this
 * follows; delete it and it goes. Nothing on this side restates its logic, its
 * tools or its decision time.
 */
async function strategies(timeoutMs = 10000) {
  const res = await axios.get(`${baseUrl()}/api/strategies`, { timeout: timeoutMs });
  const d = res.data || {};
  return Array.isArray(d) ? d : (d.strategies || []);
}

/**
 * Assign the tools a strategy belongs to.
 *
 * The one write this side makes to qp, and it is deliberately the narrowest
 * one: which screeners run it. Not its rules, not its window — those are the
 * builder's, and a round trip through here is how a rule gets rewritten by
 * accident. qp has an endpoint that touches this field alone for that reason.
 *
 * It is here because assignment is the step that belongs on this side: a
 * strategy is built and backtested in qp, and the decision about which
 * screener's card list it should run against is made where those cards are.
 */
async function setTools(id, tools, timeoutMs = 10000) {
  const res = await axios.post(`${baseUrl()}/api/strategies/${id}/tools`,
    { tools }, { timeout: timeoutMs, headers: { 'Content-Type': 'application/json' } });
  const d = res.data || {};
  if (!d.ok) throw new Error(d.error || 'qp refused the tools');
  return d.strategy;
}

/** Is the platform up? Asked before a decision so "down" is a distinct answer. */
async function health(timeoutMs = 5000) {
  try {
    const res = await axios.get(`${baseUrl()}/api/health`, { timeout: timeoutMs });
    return { ok: true, ...(res.data || {}) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

module.exports = { decide, manage, strategies, setTools, health, baseUrl };
