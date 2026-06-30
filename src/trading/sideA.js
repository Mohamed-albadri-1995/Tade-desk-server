/**
 * Side A — Market Conditions Register
 *
 * Evaluates per-ticker direction gate (longAllowed / shortAllowed)
 * and sizing multiplier from scanner context. Refreshed every 30s
 * during the 9:35–10:00 window.
 */

const db = require('../db');

// In-memory register: Map<ticker, { longAllowed, shortAllowed, multiplier, context, updatedAt }>
const register = new Map();

function getSetting(key, fallback) {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key);
  return row ? row.value : fallback;
}

/**
 * Evaluate direction gate and sizing multiplier from scanner context fields.
 * Rules are intentionally simple and configurable — extend as needed.
 */
function evaluate(context = {}) {
  const { broadResolved, secBias, shortTerm, midTerm, longTerm, secScore } = context;

  // Direction gate
  let longAllowed = true;
  let shortAllowed = true;

  // Long blocked if broad market is clearly bearish
  if (broadResolved === 'BEARISH' && secBias === 'BEARISH') longAllowed = false;
  if (broadResolved === 'BEARISH' && shortTerm === 'BEARISH') longAllowed = false;

  // Short blocked if broad market is clearly bullish
  if (broadResolved === 'BULLISH' && secBias === 'BULLISH') shortAllowed = false;
  if (broadResolved === 'BULLISH' && shortTerm === 'BULLISH') shortAllowed = false;

  // Sizing multiplier based on conditions
  let multiplier = 1.0;
  const secScoreNum = parseFloat(secScore) || 0;

  if (broadResolved === 'NEUTRAL' || !broadResolved) multiplier = Math.min(multiplier, 0.75);
  if (Math.abs(secScoreNum) < 10) multiplier = Math.min(multiplier, 0.8);

  return { longAllowed, shortAllowed, multiplier: parseFloat(multiplier.toFixed(2)) };
}

/**
 * Update a ticker's entry in the register from fresh scanner context.
 */
function update(ticker, context, score, scoreDetails) {
  const gate = evaluate(context);
  register.set(ticker.toUpperCase(), {
    ...gate,
    context,
    score,
    scoreDetails,
    updatedAt: Date.now(),
  });
}

/**
 * Bulk update from shortlist + context poll.
 */
function updateAll(entries) {
  for (const e of entries) {
    update(e.ticker, e.context || {}, e._score, e._scoreDetails);
  }
}

function get(ticker) {
  return register.get(ticker.toUpperCase()) || null;
}

function getAll() {
  const out = {};
  for (const [ticker, val] of register.entries()) out[ticker] = val;
  return out;
}

function clear() {
  register.clear();
}

module.exports = { update, updateAll, get, getAll, clear, evaluate };
