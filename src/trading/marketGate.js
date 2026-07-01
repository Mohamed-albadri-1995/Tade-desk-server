/**
 * Market Gate (was "Side A — Market Conditions Register")
 *
 * Per-ticker direction gate (longAllowed / shortAllowed) and sizing
 * multiplier derived from the scanner's context. Refreshed every 30s
 * during the 9:35–10:00 ET window by the session's context poll.
 *
 * Rules are configurable via the settings table (see getRules).
 */

const db = require('../db');

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

function getRules() {
  return {
    gateEnabled:            getBool('trading_gate_enabled', true),
    neutralMultiplier:      getNum('trading_gate_neutral_multiplier', 0.75),
    weakSecScoreThreshold:  getNum('trading_gate_weak_sec_score', 10),
    weakSecMultiplier:      getNum('trading_gate_weak_sec_multiplier', 0.8),
  };
}

function evaluate(context = {}, rules = getRules()) {
  const { secBias, shortTerm, longTerm, secScore } = context;

  let longAllowed = true;
  let shortAllowed = true;

  if (rules.gateEnabled) {
    if (shortTerm === 'BEARISH' && (secBias === 'BEARISH' || longTerm === 'BEARISH')) {
      longAllowed = false;
    }
    if (shortTerm === 'BULLISH' && (secBias === 'BULLISH' || longTerm === 'BULLISH')) {
      shortAllowed = false;
    }
  }

  let multiplier = 1.0;
  if (!shortTerm || shortTerm === 'NEUTRAL') {
    multiplier = Math.min(multiplier, rules.neutralMultiplier);
  }
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

function get(ticker) { return register.get(ticker.toUpperCase()) || null; }
function getAll() {
  const out = {};
  for (const [ticker, val] of register.entries()) out[ticker] = val;
  return out;
}
function clear() { register.clear(); }

module.exports = { update, updateAll, get, getAll, clear, evaluate, getRules };
