/**
 * Side A — Market Conditions Register
 *
 * Per-ticker direction gate (longAllowed / shortAllowed) and sizing
 * multiplier derived from scanner context. Refreshed every 30s during the
 * 9:35–10:00 window by the session's context poll.
 *
 * Rules are configurable in the settings table (see getRules).
 */

const db = require('../db');

// In-memory register: Map<ticker, { longAllowed, shortAllowed, multiplier, context, updatedAt }>
const register = new Map();

function getSettingRaw(key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : null;
}

function getBool(key, fallback) {
  const v = getSettingRaw(key);
  if (v === null || v === undefined || v === '') return fallback;
  return v === '1' || v === 'true' || v === 'on';
}

function getNum(key, fallback) {
  const v = getSettingRaw(key);
  if (v === null || v === undefined || v === '') return fallback;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Reads the full rule config from settings so users can tune Side A
 * behaviour without a code change (per the original plan).
 */
function getRules() {
  return {
    // Direction gate — turn off entirely to allow both directions unconditionally
    gateEnabled:            getBool('trading_sideA_gate_enabled', true),

    // Sizing — reductions applied when conditions are marginal
    neutralMultiplier:      getNum('trading_sideA_neutral_multiplier', 0.75),
    weakSecScoreThreshold:  getNum('trading_sideA_weak_sec_score', 10),
    weakSecMultiplier:      getNum('trading_sideA_weak_sec_multiplier', 0.8),
  };
}

/**
 * Compute direction gate + sizing multiplier from scanner context.
 * Uses shortTerm / secBias / longTerm — the fields the scanner actually
 * publishes (the earlier version compared broadResolved against
 * BULLISH/BEARISH, which never matched because broadResolved is the
 * resolved sector name).
 */
function evaluate(context = {}, rules = getRules()) {
  const { secBias, shortTerm, longTerm, secScore } = context;

  let longAllowed = true;
  let shortAllowed = true;

  if (rules.gateEnabled) {
    // Block long when short-term bias is BEARISH AND either the sector
    // is BEARISH or the long-term trend is BEARISH — i.e. the broad
    // market is confirming the bearish direction.
    if (shortTerm === 'BEARISH' && (secBias === 'BEARISH' || longTerm === 'BEARISH')) {
      longAllowed = false;
    }
    // Symmetric block for shorts.
    if (shortTerm === 'BULLISH' && (secBias === 'BULLISH' || longTerm === 'BULLISH')) {
      shortAllowed = false;
    }
  }

  // Sizing multiplier — take the minimum of every applicable reducer.
  let multiplier = 1.0;

  // No context yet, or short-term is NEUTRAL → reduce
  if (!shortTerm || shortTerm === 'NEUTRAL') {
    multiplier = Math.min(multiplier, rules.neutralMultiplier);
  }

  // Weak sector conviction → reduce
  const secScoreNum = parseFloat(secScore);
  if (!Number.isFinite(secScoreNum) || Math.abs(secScoreNum) < rules.weakSecScoreThreshold) {
    multiplier = Math.min(multiplier, rules.weakSecMultiplier);
  }

  return {
    longAllowed,
    shortAllowed,
    multiplier: parseFloat(multiplier.toFixed(2)),
  };
}

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

module.exports = { update, updateAll, get, getAll, clear, evaluate, getRules };
