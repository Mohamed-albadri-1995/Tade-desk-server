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

function getSetting(key, fallback) {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key);
  if (!row || row.value === '' || row.value == null) return fallback;
  const n = parseFloat(row.value);
  return Number.isFinite(n) ? n : fallback;
}

function getSettings() {
  return {
    equity:              getSetting('trading_equity', 25000),
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
  };
}

module.exports = { calculate, getSettings };
