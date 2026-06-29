// computeMarketBiasDetail — Short-Term
function computeMarketBiasDetail(indices) {
  const SPY = indices.SPY || {};
  const QQQ = indices.QQQ || {};
  const IWM = indices.IWM || {};
  const VIX = indices.VIX || {};

  const spyDay = SPY['change'] || 0;
  const qqqDay = QQQ['change'] || 0;
  const iwmDay = IWM['change'] || 0;
  const vixDay = VIX['change'] || 0;
  const spyWeek = SPY['change|1W'] || 0;
  const qqqWeek = QQQ['change|1W'] || 0;

  const sig1 = spyDay > 0.3 ? 1 : spyDay < -0.3 ? -1 : 0;
  const sig2 = qqqDay > 0.3 ? 1 : qqqDay < -0.3 ? -1 : 0;
  const sig3 = iwmDay > 0.3 ? 1 : iwmDay < -0.3 ? -1 : 0;

  let sig4;
  if (vixDay > 3) sig4 = -2;
  else if (vixDay > 1) sig4 = -1;
  else if (vixDay < -2) sig4 = 1;
  else sig4 = 0;

  const sig5 = spyWeek > 1 ? 1 : spyWeek < -1 ? -1 : 0;
  const sig6 = qqqWeek > 1 ? 1 : qqqWeek < -1 ? -1 : 0;

  const score = sig1 + sig2 + sig3 + sig4 + sig5 + sig6;

  let result;
  if (score >= 3) result = 'BULLISH';
  else if (score <= -3) result = 'BEARISH';
  else result = 'NEUTRAL';

  return {
    result,
    score,
    signals: [
      { name: 'SPY Day', value: sig1 },
      { name: 'QQQ Day', value: sig2 },
      { name: 'IWM Day', value: sig3 },
      { name: 'VIX', value: sig4 },
      { name: 'SPY Week', value: sig5 },
      { name: 'QQQ Week', value: sig6 },
    ],
  };
}

// computeMarketStage — Mid-Term
function computeMarketStage(indices) {
  const src = indices.SPY || indices.QQQ || {};

  const close = src['close'] || 0;
  const sma5 = src['SMA5'] || 0;
  const sma20 = src['SMA20'] || 0;
  const sma50 = src['SMA50'] || 0;
  const sma200 = src['SMA200'] || 0;
  const bbUpper = src['BB.upper'] || 0;
  const bbLower = src['BB.lower'] || 0;

  // Daily signals
  const s1 = close > sma5;
  const s2 = close > sma20;
  const s3 = sma5 > sma20;
  const s4 = sma20 > sma50;
  // Hourly signals — using daily proxies as spec notes hourly inputs
  // NOTE: TV scanner does not return hourly data; using daily SMA20 and SMA5 as proxy
  // for 1H Close > 20H MA and 1H 5MA > 20H MA
  const s5 = close > sma20; // proxy for 1H Close > 20H MA
  const s6 = sma5 > sma20;  // proxy for 1H 5MA > 20H MA

  const bullCount = [s1, s2, s3, s4, s5, s6].filter(Boolean).length;
  const CA5 = close > sma5;
  const S5A20 = sma5 > sma20;

  // BB%
  const bbRange = bbUpper - bbLower;
  let bbPct = bbRange > 0 ? (close - bbLower) / bbRange : 0.5;
  bbPct = Math.max(0, Math.min(1, bbPct));
  let bb;
  if (bbPct >= 0.75) bb = 'UPPER';
  else if (bbPct <= 0.25) bb = 'LOWER';
  else bb = 'MID';

  let result;
  if (bullCount >= 5 || (bullCount === 4 && CA5)) {
    result = 'UPTREND';
  } else if (bullCount >= 3 && bullCount <= 4 && !CA5 && S5A20) {
    result = 'PULLBACK';
  } else if (bullCount >= 2 && bullCount <= 3 && CA5 && !S5A20) {
    result = 'REBOUND';
  } else if (bullCount >= 2 && bullCount <= 3) {
    result = 'SIDEWAYS';
  } else {
    result = 'DOWNTREND';
  }

  const srcName = indices.SPY ? 'SPY' : 'QQQ';
  return {
    result,
    stageLabel: result,
    src: srcName,
    bull: bullCount,
    unk: 6 - bullCount,
    bb,
    bbPct,
    signals: [
      { name: 'Close > SMA5', value: s1 },
      { name: 'Close > SMA20', value: s2 },
      { name: 'SMA5 > SMA20', value: s3 },
      { name: 'SMA20 > SMA50', value: s4 },
      { name: '1H Close > 20H MA (proxy)', value: s5 },
      { name: '1H 5MA > 20H MA (proxy)', value: s6 },
    ],
    _meta: { sma5, sma20, sma50, sma200, bbUpper, bbLower, bbPct, bb, close },
  };
}

// computeLongTermBias
function computeLongTermBias(indices) {
  const src = indices.SPY || indices.QQQ || {};
  const close = src['close'] || 0;
  const sma50 = src['SMA50'] || 0;
  const sma200 = src['SMA200'] || 0;

  const above200 = close > sma200;
  const goldenCross = sma50 > sma200;

  let result;
  if (above200 && goldenCross) result = 'BULLISH';
  else if (above200 && !goldenCross) result = 'RECOVERING';
  else if (!above200 && goldenCross) result = 'WEAKENING';
  else result = 'BEARISH';

  const dist = sma200 > 0 ? ((close - sma200) / sma200) * 100 : 0;
  const srcName = indices.SPY ? 'SPY' : 'QQQ';

  return {
    result,
    label: result,
    src: srcName,
    dist,
    above200,
    goldenCross,
  };
}

// REGIME MATRIX
const REGIME_MATRIX = {
  BULLISH: {
    UPTREND: 'STRONG_UP',
    PULLBACK: 'PULLBACK_BULL',
    REBOUND: 'UP',
    SIDEWAYS: 'CHOP_BULL',
    DOWNTREND: 'CORRECTION',
  },
  RECOVERING: {
    UPTREND: 'WEAK_UP',
    PULLBACK: 'RECOVERY',
    REBOUND: 'RECOVERY',
    SIDEWAYS: 'BASING',
    DOWNTREND: 'DOWN',
  },
  WEAKENING: {
    UPTREND: 'RECOVERY',
    PULLBACK: 'TOPPING',
    REBOUND: 'BEAR_RALLY',
    SIDEWAYS: 'CHOP_BEAR',
    DOWNTREND: 'DOWN',
  },
  BEARISH: {
    UPTREND: 'BEAR_RALLY',
    PULLBACK: 'DOWN',
    REBOUND: 'BEAR_RALLY',
    SIDEWAYS: 'BASING',
    DOWNTREND: 'STRONG_DOWN',
  },
};

const REGIME_CATALOG = {
  EXTENDED_UP: { bias: 'LONG', icon: '🟢⬆️', color: '#22c55e', label: 'Extended Up', stance: 'LONG', guidance: 'Market extended. Momentum strong. Pullbacks are buying opportunities.' },
  STRONG_UP: { bias: 'LONG', icon: '🟢⬆️', color: '#16a34a', label: 'Strong Uptrend', stance: 'LONG', guidance: 'Strong bullish conditions. Favor long setups with momentum.' },
  UP: { bias: 'LONG', icon: '🟢↗️', color: '#4ade80', label: 'Uptrend', stance: 'LONG', guidance: 'Bullish but recovering. Favor long setups selectively.' },
  WEAK_UP: { bias: 'LONG', icon: '🟡↗️', color: '#86efac', label: 'Weak Uptrend', stance: 'LONG', guidance: 'Recovering from weakness. Light long bias.' },
  PULLBACK_BULL: { bias: 'LONG', icon: '🟠⤵️', color: '#f97316', label: 'Pullback (bull intact)', stance: 'LONG', guidance: 'Short-term pullback in a bull market. Watch for long re-entries.' },
  RECOVERY: { bias: 'NEUTRAL', icon: '🟡↔️', color: '#eab308', label: 'Recovery', stance: 'NEUTRAL', guidance: 'Recovering structure. Be selective. Wait for confirmation.' },
  BASING: { bias: 'NEUTRAL', icon: '⚪↔️', color: '#6b7280', label: 'Basing', stance: 'NEUTRAL', guidance: 'Market is basing. No clear direction. Reduce exposure.' },
  CHOP_BULL: { bias: 'NEUTRAL', icon: '🟡↔️', color: '#ca8a04', label: 'Chop (bull bias)', stance: 'NEUTRAL', guidance: 'Choppy but leaning bullish. Trade small and be selective.' },
  CHOP_BEAR: { bias: 'NEUTRAL', icon: '🟠↔️', color: '#ea580c', label: 'Chop (bear bias)', stance: 'NEUTRAL', guidance: 'Choppy with bear undertone. Reduce position size.' },
  CORRECTION: { bias: 'NEUTRAL', icon: '🟠⤵️', color: '#f97316', label: 'Correction (bull intact)', stance: 'NEUTRAL', guidance: 'Correction in a bull market. Monitor for stabilization before re-entering.' },
  TOPPING: { bias: 'SHORT', icon: '🔴⬇️', color: '#ef4444', label: 'Topping', stance: 'SHORT', guidance: 'Signs of topping. Reduce longs. Hedge or go short on weakness.' },
  BEAR_RALLY: { bias: 'NEUTRAL', icon: '🟠↗️', color: '#f87171', label: 'Bear Rally', stance: 'NEUTRAL', guidance: 'Counter-trend rally in bear market. Fade strength cautiously.' },
  DOWN: { bias: 'SHORT', icon: '🔴⬇️', color: '#dc2626', label: 'Downtrend', stance: 'SHORT', guidance: 'Bearish conditions. Avoid longs. Short on rallies.' },
  STRONG_DOWN: { bias: 'SHORT', icon: '🔴⬇️', color: '#991b1b', label: 'Strong Downtrend', stance: 'SHORT', guidance: 'Strongly bearish. Reduce all risk. Short only.' },
  CAPITULATION: { bias: 'SHORT', icon: '🔴💥', color: '#7f1d1d', label: 'Capitulation', stance: 'SHORT', guidance: 'Market in capitulation. Extreme caution. Watch for reversal signals.' },
};

function computeRegime(longTerm, midTerm, bbPosition) {
  const slug = (REGIME_MATRIX[longTerm.result] || {})[midTerm.result] || 'BASING';

  let finalSlug = slug;
  if (slug === 'STRONG_UP' && bbPosition === 'UPPER') finalSlug = 'EXTENDED_UP';
  if (slug === 'STRONG_DOWN' && bbPosition === 'LOWER') finalSlug = 'CAPITULATION';

  const catalog = REGIME_CATALOG[finalSlug] || REGIME_CATALOG.BASING;

  return {
    slug: finalSlug,
    label: catalog.label,
    icon: catalog.icon,
    color: catalog.color,
    stance: catalog.stance,
    guidance: catalog.guidance,
    confidence: 'medium',
    aligned: longTerm.result === 'BULLISH' && midTerm.result === 'UPTREND',
  };
}

module.exports = {
  computeMarketBiasDetail,
  computeMarketStage,
  computeLongTermBias,
  computeRegime,
  REGIME_MATRIX,
  REGIME_CATALOG,
};
