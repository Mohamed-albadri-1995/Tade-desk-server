const { loadModel, CRITICAL_BUCKETS, QUANTILE_FEATURES, CATEGORICAL_FEATURES } = require('./train');

function getBucket(value, boundaries) {
  if (value == null || isNaN(value)) return null;
  for (let i = 0; i < boundaries.length - 1; i++) {
    if (value >= boundaries[i] && value < boundaries[i + 1]) {
      return `${boundaries[i]}–${boundaries[i + 1]}`;
    }
  }
  return `>${boundaries[boundaries.length - 2]}`;
}

function getQuantileBucket(value, sortedValues, numBuckets = 6) {
  if (value == null || isNaN(value) || !sortedValues || sortedValues.length === 0) return null;
  const rank = sortedValues.findIndex(v => value <= v);
  const idx = rank === -1 ? numBuckets - 1 : Math.floor((rank / sortedValues.length) * numBuckets);
  return `Q${Math.min(idx + 1, numBuckets)}`;
}

function dayOfWeek(dateStr) {
  if (!dateStr) return 'Mon';
  const d = new Date(dateStr + 'T12:00:00Z');
  return ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][d.getUTCDay()];
}

function extractFeatures(row) {
  const s = row.stock || {};
  const ctx = row.context || {};
  const cat = row.catalyst || {};
  return {
    rvol: s.rvol, change: s.change, gapPct: s.gapPct,
    monthRangePos: s.monthRangePos, secScore: ctx.secScore,
    pmAdrRatio: s.pmAdrRatio, adrPct: s.adrPct,
    price936: s.price, prevClose: s.prevClose, open: s.open,
    vwap: s.vwap, sma5: s.sma5, ema9: s.ema9, ema13: s.ema13,
    ema20: s.ema20, ema50: s.ema50, atr: s.atr,
    dayHigh: s.dayHigh, dayLow: s.dayLow,
    monthHigh: s.monthHigh, monthLow: s.monthLow,
    mcap: s.mcap, floatShares: s.floatShares, shortFloat: s.shortFloat,
    pmHigh: s.pmHigh, pmLow: s.pmLow, pmRange: s.pmRange,
    regime: ctx.regime, secBias: ctx.secBias,
    sector: s.sector, longTerm: ctx.longTerm,
    midTerm: ctx.midTerm, shortTerm: ctx.shortTerm,
    catalyst: cat.label || 'none',
    screenerKeys: Array.isArray(row.screenerKeys) ? row.screenerKeys.sort().join('+') : 'none',
    secHot: ctx.secHot ? 'yes' : 'no',
    themes: Array.isArray(ctx.themes) ? ctx.themes.sort().join('+') : 'none',
    dayOfWeek: dayOfWeek(row.date),
  };
}

let _cachedModel = null;
let _modelLoadedAt = 0;

function getModel() {
  const now = Date.now();
  if (_cachedModel && now - _modelLoadedAt < 60000) return _cachedModel;
  _cachedModel = loadModel();
  _modelLoadedAt = now;
  return _cachedModel;
}

function scoreRow(row) {
  const model = getModel();
  if (!model) return null;

  const { features, globalWinRate } = model;
  const vals = extractFeatures(row);

  let weightedWinRate = 0;
  let totalWeight = 0;

  for (const [feat, fd] of Object.entries(features)) {
    if (!fd || fd.importance === 0) continue;

    let bucket;
    if (CRITICAL_BUCKETS[feat]) {
      bucket = getBucket(vals[feat], CRITICAL_BUCKETS[feat]);
    } else if (QUANTILE_FEATURES.includes(feat)) {
      bucket = getQuantileBucket(vals[feat], fd.quantileSorted);
    } else {
      const v = vals[feat];
      bucket = v != null ? String(v) : 'unknown';
    }

    if (!bucket || !fd.buckets[bucket]) continue;
    weightedWinRate += fd.importance * fd.buckets[bucket].winRate;
    totalWeight += fd.importance;
  }

  const rawScore = totalWeight > 0 ? weightedWinRate / totalWeight : (globalWinRate || 0.5);

  // Scale to 0-100 using global win rate as midpoint reference
  const gwr = globalWinRate || 0.5;
  let score;
  if (rawScore >= gwr) {
    score = 50 + ((rawScore - gwr) / (1 - gwr)) * 50;
  } else {
    score = 50 - ((gwr - rawScore) / gwr) * 50;
  }

  return Math.max(0, Math.min(100, Math.round(score)));
}

function scoreAllRows(rows) {
  const model = getModel();
  if (!model) {
    return rows.map(row => ({ ...row, _score: null }));
  }
  return rows.map(row => ({ ...row, _score: scoreRow(row) }));
}

function invalidateCache() {
  _cachedModel = null;
}

module.exports = { scoreRow, scoreAllRows, invalidateCache };
