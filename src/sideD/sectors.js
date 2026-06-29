const db = require('../db');
const { SECTOR_ETF_MAP } = require('./marketContext');

function getSetting(key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? parseFloat(row.value) : null;
}

// State: { [sectorName]: { hot: bool, consecutiveSessions: number, coolOffSessions: number } }
const hotState = {};

function sectorShortTermBias(sectorName, etfData, spyData) {
  const spyChange = spyData['change'] || 0;
  const spyWeekChg = spyData['change|1W'] || 0;
  const etfChange = etfData['change'] || 0;
  const dRS = etfChange - spyChange;

  const close = etfData['close'] || 0;
  const sma20 = etfData['SMA20'] || 0;
  const sma50 = etfData['SMA50'] || 0;
  const vwap = etfData['VWAP'] || 0;
  const weekChg = etfData['change|1W'] || 0;
  const adx = etfData['ADX'] || 0;

  const c1 = close > sma20;
  const c2 = sma20 > sma50;
  const c3 = close > vwap;
  const c4 = dRS > 0;
  const c5 = weekChg > 0;

  const bullCount = [c1, c2, c3, c4, c5].filter(Boolean).length;

  // ADX amplifier: strong trend amplifies score
  let adxFactor;
  if (adx > 25) adxFactor = 1.3;
  else if (adx >= 20) adxFactor = 1.1;
  else adxFactor = 0.8;

  // Base score: each condition is 20 points, max 100
  const baseScore = (bullCount / 5) * 100;
  // Apply RS influence (±5 per RS point, capped at ±30)
  const rsInfluence = Math.max(-30, Math.min(30, dRS * 5));
  let score = Math.round((baseScore + rsInfluence) * adxFactor);
  score = Math.max(-100, Math.min(100, score));

  const bullishThreshold = getSetting('sectorBullishThreshold') || 20;
  const bearishThreshold = getSetting('sectorBearishThreshold') || -20;

  let bias;
  if (score > bullishThreshold) bias = 'BULLISH';
  else if (score < bearishThreshold) bias = 'BEARISH';
  else bias = 'NEUTRAL';

  const wRS = weekChg - spyWeekChg;
  return { bias, score, dRS, wRS, adx };
}

function updateHotSector(sectorName, score) {
  const hotImmediate = getSetting('hotImmediateThreshold') || 60;
  const hotSustained = getSetting('hotSustainedThreshold') || 40;
  const hotSustainedN = getSetting('hotSustainedSessions') || 3;
  const hotFloor = getSetting('hotFloorThreshold') || 20;
  const coolOff = getSetting('coolOffDays') || 2;

  if (!hotState[sectorName]) {
    hotState[sectorName] = { hot: false, consecutiveSessions: 0, coolOffSessions: 0 };
  }
  const state = hotState[sectorName];

  if (state.hot) {
    if (score >= hotFloor) {
      state.coolOffSessions = 0;
    } else {
      state.coolOffSessions++;
      if (state.coolOffSessions > coolOff) {
        state.hot = false;
        state.consecutiveSessions = 0;
        state.coolOffSessions = 0;
      }
    }
  } else {
    if (score >= hotImmediate) {
      state.hot = true;
      state.consecutiveSessions = 0;
      state.coolOffSessions = 0;
    } else if (score >= hotSustained) {
      state.consecutiveSessions++;
      if (state.consecutiveSessions >= hotSustainedN) {
        state.hot = true;
        state.consecutiveSessions = 0;
      }
    } else {
      state.consecutiveSessions = 0;
    }
  }

  return state.hot;
}

function computeAllSectors(marketData, spyData) {
  const result = {};
  for (const [sectorName, info] of Object.entries(SECTOR_ETF_MAP)) {
    const etfData = marketData[info.etf] || {};
    const biasData = sectorShortTermBias(sectorName, etfData, spyData);
    const hot = updateHotSector(sectorName, biasData.score);
    result[sectorName] = {
      etf: info.etf,
      close: etfData['close'] || null,
      change: etfData['change'] || null,
      weekChg: etfData['change|1W'] || null,
      adx: etfData['ADX'] || null,
      bias: biasData.bias,
      score: biasData.score,
      hot,
      dRS: biasData.dRS,
      wRS: biasData.wRS,
    };
  }
  return result;
}

module.exports = { sectorShortTermBias, computeAllSectors, hotState };
