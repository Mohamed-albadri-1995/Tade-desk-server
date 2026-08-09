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
async function decide({ strategyId, strategies, symbols, date, tf = '1m',
                        feed = 'yahoo', topN = 2, targetR = 2.0,
                        fill = 'close', timeoutMs = 45000 }) {
  const body = {
    symbols, date, tf, feed, top_n: topN, target_r: targetR, fill,
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

/** Is the platform up? Asked before a decision so "down" is a distinct answer. */
async function health(timeoutMs = 5000) {
  try {
    const res = await axios.get(`${baseUrl()}/api/health`, { timeout: timeoutMs });
    return { ok: true, ...(res.data || {}) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

module.exports = { decide, strategies, health, baseUrl };
