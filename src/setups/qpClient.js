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

/*
 * HOW LONG A DECISION MAY TAKE, AND HOW MANY GOES IT GETS.
 *
 * A BUDGET, NOT A TIMEOUT. The decision has to land inside the minute it
 * decides for: `OR + VWAP 09:35` enters on the 09:35 open, the tick fires when
 * the clock reads 09:35, and the order has to reach the tape inside that
 * minute. So the question is not "how long are we willing to wait" but "how
 * much of the minute may one attempt spend".
 *
 * It was one attempt of 45 seconds, and on 2026-09-03 that lost the whole day:
 *
 *     OR + VWAP 09:35   1 run · FAILED · timeout of 45000ms exceeded
 *
 * A CLOCK SETUP DECIDES ON ONE BAR. `runDue` caught the timeout, published an
 * error, and moved on; the scheduler's window is one minute wide, so it never
 * matched again. One slow answer and the strategy did not trade at all — and
 * 45 seconds was too long to be useful anyway: an answer arriving at 09:35:44
 * is three quarters of the way through the bar it was meant to open on.
 *
 * Two attempts of eighteen seconds fit in the same minute with room left for
 * the order, and a platform that is briefly busy — the nightly walk, a heavy
 * scan — no longer costs a session.
 */
const DECIDE_TIMEOUT_MS = 18000;
const DECIDE_ATTEMPTS = 2;

/*
 * NETWORK CODES ONLY — a second attempt must be the SAME question.
 *
 * qp answering "no signal", or answering with a 500, is an ANSWER. Asking it
 * again would not be a retry, it would be a second opinion, and a desk that
 * asks twice and takes the friendlier answer is not running the strategy that
 * was backtested. Only a request that never got an answer at all may be
 * repeated.
 */
const NEVER_ANSWERED = new Set(['ECONNABORTED', 'ETIMEDOUT', 'ECONNRESET',
                                'ECONNREFUSED', 'EPIPE', 'EAI_AGAIN',
                                'ERR_CANCELED']);

function neverAnswered(err) {
  if (!err) return false;
  // A STATUS IS AN ANSWER, including 500. qp reached a conclusion and said so.
  if (err.response) return false;
  // ok:false is an answer too — the flag is set where that error is thrown.
  if (err.qpAnswered) return false;
  return NEVER_ANSWERED.has(err.code)
    // axios reports its own timeout by message on some versions, not by code.
    || /timeout of \d+ms exceeded/i.test(err.message || '');
}

/**
 * Decide a setup: strategies × universe × date → ranked picks.
 *
 * Retries ONCE when the platform never answered — see the budget above. Never
 * retries an answer, however unwelcome.
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
                        fill = 'live', view = 'all',
                        timeoutMs = DECIDE_TIMEOUT_MS,
                        attempts = DECIDE_ATTEMPTS }) {
  const body = {
    symbols, date, tf, feed, top_n: topN, target_r: targetR, fill,
    // WHICH BARS qp EVALUATES ON. 'regular' was hardcoded on qp's side while
    // every backtest defaults to 'all', so the same strategy read a different
    // ATR warm-up live, and a setup whose window opens at 09:30 could never
    // fire — its decision bar is 09:29, which 'regular' does not contain.
    view,
    // Named, never assumed — see catalog.js. qp refuses an unknown one rather
    // than guessing, and refuses to invent one when none is given.
    metric, direction, ctx,
  };
  if (strategies) body.strategies = strategies;
  else body.strategy_id = strategyId;

  const tries = Math.max(1, Number(attempts) || 1);
  let last = null;
  for (let i = 1; i <= tries; i += 1) {
    try {
      const res = await axios.post(`${baseUrl()}/api/setup/decide`, body, {
        timeout: timeoutMs,
        headers: { 'Content-Type': 'application/json' },
      });
      const data = res.data || {};
      // qp answers 200 with ok:false for its own errors, so a status check is
      // not enough to know the decision succeeded.
      if (!data.ok) {
        const e = new Error(data.error || 'qp could not decide the setup');
        e.qpAnswered = true;              // an answer. Never asked again.
        throw e;
      }
      // SAID OUT LOUD when the answer only arrived on the second ask. A
      // decision that needed a retry is one that nearly did not happen, and
      // that is worth seeing before the day it does not.
      if (i > 1) data.attempts = i;
      return data;
    } catch (err) {
      last = err;
      if (i >= tries || !neverAnswered(err)) throw err;
      console.warn(`[qp] decide did not answer (${err.code || err.message}) `
        + `— attempt ${i} of ${tries}, asking again inside the same minute`);
    }
  }
  throw last;
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

module.exports = {
  decide, manage, strategies, setTools, health, baseUrl,
  // Exported so the retry rule can be tested against real error shapes rather
  // than trusted — "only a request that never got an answer may be repeated"
  // is a sentence until something executes it.
  neverAnswered, DECIDE_TIMEOUT_MS, DECIDE_ATTEMPTS,
};
