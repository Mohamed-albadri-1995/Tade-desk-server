/**
 * Side C — Position Size Calculator
 *
 * Computes recommended share count and dollar risk given:
 *   - Account equity
 *   - Risk % per trade
 *   - Stop distance (|entry - SL|)
 *   - Side A sizing multiplier
 *   - Scanner _score multiplier
 *   - Hard caps
 */

const db = require('../db');
const { fetchAccountEquity } = require('../alpaca/client');

function getSetting(key, fallback) {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key);
  if (!row || row.value === '' || row.value == null) return fallback;
  const n = parseFloat(row.value);
  return Number.isFinite(n) ? n : fallback;
}

// ─── Alpaca equity cache ──────────────────────────────────────────────────────
// The plan calls for equity from the Alpaca account API. We refresh it in
// the background (see refreshAlpacaEquity below), cache the last good value
// for a few minutes, and fall back to the static trading_equity setting if
// Alpaca is unreachable or unconfigured.

const EQUITY_CACHE_MS = 5 * 60 * 1000;
let _equityCache = { value: null, at: 0, source: 'none' };

async function refreshAlpacaEquity() {
  const eq = await fetchAccountEquity();
  if (eq != null && Number.isFinite(eq)) {
    _equityCache = { value: eq, at: Date.now(), source: 'alpaca' };
  }
  return _equityCache;
}

function getEffectiveEquity() {
  const fallback = getSetting('trading_equity', 25000);
  if (_equityCache.value != null && Date.now() - _equityCache.at < EQUITY_CACHE_MS) {
    return { equity: _equityCache.value, source: 'alpaca', ageMs: Date.now() - _equityCache.at };
  }
  return { equity: fallback, source: 'setting', ageMs: null };
}

function getSettings() {
  const eq = getEffectiveEquity();
  return {
    equity:              eq.equity,
    equitySource:        eq.source,
    equityAgeMs:         eq.ageMs,
    riskPct:             getSetting('trading_risk_pct', 1.0),
    maxShares:           getSetting('trading_max_shares', 1000),
    maxDollarRisk:       getSetting('trading_max_dollar_risk', 500),
    maxTotalExposure:    getSetting('trading_max_total_exposure', 10000),
    scoreThresholdHigh:  getSetting('trading_score_threshold_high', 85),
    scoreThresholdLow:   getSetting('trading_score_threshold_low', 70),
    scoreMultiplierHigh: getSetting('trading_score_multiplier_high', 1.2),
    scoreMultiplierLow:  getSetting('trading_score_multiplier_low', 0.8),
  };
}

/**
 * Compute score-based multiplier.
 */
function scoreMultiplier(score, settings) {
  if (score == null) return 1.0;
  if (score >= settings.scoreThresholdHigh) return settings.scoreMultiplierHigh;
  if (score < settings.scoreThresholdLow) return settings.scoreMultiplierLow;
  return 1.0;
}

const GRADE_MULTIPLIERS = { 'A+': 1.2, 'A': 1.0, 'B': 0.85, 'C': 0.7 };

/**
 * Sum position value across currently open positions (used to enforce
 * the max-total-exposure cap so a new trade can't push us over the limit).
 */
function currentOpenExposure() {
  const row = db
    .prepare("SELECT COALESCE(SUM(shares * entry_price), 0) AS exp FROM trading_positions WHERE status = 'open'")
    .get();
  return row ? Number(row.exp) || 0 : 0;
}

/**
 * Calculate position size.
 *
 * @param {object} params
 * @param {number} params.entryPrice - expected entry price
 * @param {number} params.sl - stop loss price
 * @param {number} params.sideAMultiplier - from Side A register (default 1.0)
 * @param {number|null} params.score - scanner _score (null = no adjustment)
 * @param {string|null} params.setupGrade - historical setup grade A+/A/B/C (null = no adjustment)
 * @returns {object} { shares, dollarRisk, positionValue, riskPct, equity, ...inputs }
 */
function calculate({ entryPrice, sl, sideAMultiplier = 1.0, score = null, setupGrade = null }) {
  if (!entryPrice || !sl) throw new Error('entryPrice and sl are required');

  const stopDistance = Math.abs(entryPrice - sl);
  if (stopDistance === 0) throw new Error('Stop distance is zero');

  const s = getSettings();
  const scoreMult = scoreMultiplier(score, s);
  const gradeMult = GRADE_MULTIPLIERS[setupGrade] ?? 1.0;

  const riskDollars = Math.min(
    s.equity * (s.riskPct / 100) * sideAMultiplier * scoreMult * gradeMult,
    s.maxDollarRisk
  );

  let shares = Math.floor(riskDollars / stopDistance);
  if (s.maxShares > 0) shares = Math.min(shares, s.maxShares);

  // Max total exposure cap — clamp shares so open exposure + this new
  // position doesn't exceed the configured limit.
  const capReasons = [];
  if (s.maxTotalExposure > 0 && entryPrice > 0) {
    const openExposure = currentOpenExposure();
    const remaining = s.maxTotalExposure - openExposure;
    const maxSharesByExposure = remaining > 0 ? Math.floor(remaining / entryPrice) : 0;
    if (shares > maxSharesByExposure) {
      shares = Math.max(0, maxSharesByExposure);
      capReasons.push('maxTotalExposure');
    }
  }

  const positionValue = shares * entryPrice;
  const actualDollarRisk = shares * stopDistance;

  return {
    shares,
    dollarRisk: parseFloat(actualDollarRisk.toFixed(2)),
    positionValue: parseFloat(positionValue.toFixed(2)),
    stopDistance: parseFloat(stopDistance.toFixed(4)),
    sideAMultiplier,
    scoreMultiplier: scoreMult,
    gradeMultiplier: gradeMult,
    setupGrade: setupGrade || null,
    riskPct: s.riskPct,
    equity: s.equity,
    maxTotalExposure: s.maxTotalExposure,
    capsHit: capReasons,
  };
}

module.exports = {
  calculate,
  getSettings,
  currentOpenExposure,
  refreshAlpacaEquity,
  getEffectiveEquity,
};
