const db = require('../db');
const { toETDate } = require('../utils/time');

// Custom bucket boundaries for critical numerical features
const CRITICAL_BUCKETS = {
  rvol:         [0, 2, 5, 10, 20, Infinity],
  change:       [-Infinity, -10, -5, -2, 0, 2, 5, 10, Infinity],
  gapPct:       [-Infinity, -10, -5, -2, 0, 2, 5, 10, Infinity],
  monthRangePos:[0, 20, 40, 60, 80, 100],
  secScore:     [-100, -40, -20, 0, 20, 40, 100],
  pmAdrRatio:   [0, 0.5, 1, 2, 3, Infinity],
  adrPct:       [0, 5, 10, 15, 20, 30, Infinity],
};

const QUANTILE_FEATURES = [
  'price936','prevClose','open','vwap','sma5','ema9','ema13','ema20','ema50',
  'atr','dayHigh','dayLow','monthHigh','monthLow','mcap','floatShares',
  'shortFloat','pmHigh','pmLow','pmRange',
];

const CATEGORICAL_FEATURES = [
  'regime','secBias','sector','longTerm','midTerm','shortTerm',
  'catalyst','screenerKeys','secHot','themes','dayOfWeek',
];

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
  if (value == null || isNaN(value) || sortedValues.length === 0) return null;
  const rank = sortedValues.findIndex(v => value <= v);
  const idx = rank === -1 ? numBuckets - 1 : Math.floor((rank / sortedValues.length) * numBuckets);
  return `Q${Math.min(idx + 1, numBuckets)}`;
}

function dayOfWeek(dateStr) {
  const d = new Date(dateStr + 'T12:00:00Z');
  return ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][d.getUTCDay()];
}

function loadR4ARows(days) {
  // Get dates range
  const dates = db.prepare(
    'SELECT DISTINCT date FROM r1_frozen ORDER BY date DESC LIMIT ?'
  ).all(days).map(r => r.date);

  if (dates.length === 0) return [];

  const rows = [];
  for (const date of dates) {
    const r1Rows = db.prepare('SELECT * FROM r1_frozen WHERE date = ?').all(date);
    const r3aMap = {};
    for (const r of db.prepare('SELECT * FROM r3a WHERE date = ?').all(date)) {
      r3aMap[r.ticker] = r;
    }
    for (const r1 of r1Rows) {
      const d = JSON.parse(r1.data);
      const r3a = r3aMap[d.ticker];
      if (!r3a || r3a.up_r_a == null) continue; // skip rows without outcome
      rows.push({
        date,
        ticker: d.ticker,
        // Critical numerical
        rvol: d.stock?.rvol,
        change: d.stock?.change,
        gapPct: d.stock?.gapPct,
        monthRangePos: d.stock?.monthRangePos,
        secScore: d.context?.secScore,
        pmAdrRatio: d.stock?.pmAdrRatio,
        adrPct: d.stock?.adrPct,
        // Quantile numerical
        price936: d.stock?.price,
        prevClose: d.stock?.prevClose,
        open: d.stock?.open,
        vwap: d.stock?.vwap,
        sma5: d.stock?.sma5,
        ema9: d.stock?.ema9,
        ema13: d.stock?.ema13,
        ema20: d.stock?.ema20,
        ema50: d.stock?.ema50,
        atr: d.stock?.atr,
        dayHigh: d.stock?.dayHigh,
        dayLow: d.stock?.dayLow,
        monthHigh: d.stock?.monthHigh,
        monthLow: d.stock?.monthLow,
        mcap: d.stock?.mcap,
        floatShares: d.stock?.floatShares,
        shortFloat: d.stock?.shortFloat,
        pmHigh: d.stock?.pmHigh,
        pmLow: d.stock?.pmLow,
        pmRange: d.stock?.pmRange,
        // Categorical
        regime: d.context?.regime,
        secBias: d.context?.secBias,
        sector: d.stock?.sector,
        longTerm: d.context?.longTerm,
        midTerm: d.context?.midTerm,
        shortTerm: d.context?.shortTerm,
        catalyst: d.catalyst?.label || 'none',
        screenerKeys: Array.isArray(d.screenerKeys) ? d.screenerKeys.sort().join('+') : 'none',
        secHot: d.context?.secHot ? 'yes' : 'no',
        themes: Array.isArray(d.context?.themes) ? d.context.themes.sort().join('+') : 'none',
        dayOfWeek: dayOfWeek(date),
        // Outcome
        upR_A: r3a.up_r_a,
      });
    }
  }
  return rows;
}

function computeQuantileBoundaries(rows, feature, numBuckets = 6) {
  const vals = rows.map(r => r[feature]).filter(v => v != null && !isNaN(v)).sort((a, b) => a - b);
  if (vals.length === 0) return [];
  const boundaries = [];
  for (let i = 1; i < numBuckets; i++) {
    const idx = Math.floor((i / numBuckets) * vals.length);
    boundaries.push(vals[Math.min(idx, vals.length - 1)]);
  }
  return boundaries; // store sorted values for lookup
}

function assignBuckets(rows, quantileBoundaries) {
  return rows.map(row => {
    const buckets = {};
    // Critical numerical
    for (const [feat, bounds] of Object.entries(CRITICAL_BUCKETS)) {
      buckets[feat] = getBucket(row[feat], bounds);
    }
    // Quantile numerical
    for (const feat of QUANTILE_FEATURES) {
      const sortedVals = quantileBoundaries[feat] || [];
      buckets[feat] = getQuantileBucket(row[feat], sortedVals);
    }
    // Categorical
    for (const feat of CATEGORICAL_FEATURES) {
      const v = row[feat];
      buckets[feat] = v != null ? String(v) : 'unknown';
    }
    return { ...row, buckets };
  });
}

function computeFeatureImportance(rows, successThreshold) {
  const totalRows = rows.length;
  const globalWins = rows.filter(r => r.upR_A >= successThreshold).length;
  const globalWinRate = totalRows > 0 ? globalWins / totalRows : 0;

  const allFeatures = [
    ...Object.keys(CRITICAL_BUCKETS),
    ...QUANTILE_FEATURES,
    ...CATEGORICAL_FEATURES,
  ];

  const featureData = {};

  for (const feat of allFeatures) {
    const bucketMap = {};
    for (const row of rows) {
      const b = row.buckets[feat];
      if (b == null) continue;
      if (!bucketMap[b]) bucketMap[b] = { count: 0, wins: 0 };
      bucketMap[b].count++;
      if (row.upR_A >= successThreshold) bucketMap[b].wins++;
    }

    let importance = 0;
    const buckets = {};
    for (const [b, stats] of Object.entries(bucketMap)) {
      const winRate = stats.count > 0 ? stats.wins / stats.count : 0;
      const weight = stats.count / totalRows;
      importance += weight * Math.pow(winRate - globalWinRate, 2);
      buckets[b] = { count: stats.count, wins: stats.wins, winRate };
    }

    featureData[feat] = { importance, buckets, globalWinRate };
  }

  // Normalize
  const totalImportance = Object.values(featureData).reduce((s, f) => s + f.importance, 0);
  for (const feat of allFeatures) {
    featureData[feat].importancePct = totalImportance > 0
      ? (featureData[feat].importance / totalImportance) * 100
      : 0;
  }

  return { featureData, globalWinRate, totalRows };
}

function trainModel(overrides = {}) {
  const getSetting = k => {
    const r = db.prepare('SELECT value FROM settings WHERE key = ?').get(k);
    return r ? r.value : null;
  };

  const config = {
    entryType: overrides.entryType || getSetting('analysisEntryType') || 'A',
    directionalBias: overrides.directionalBias || getSetting('analysisDirectionalBias') || 'Up',
    successThreshold: parseFloat(overrides.successThreshold || getSetting('analysisSuccessThreshold') || '1.5'),
    trainingWindow: parseInt(overrides.trainingWindow || getSetting('analysisTrainingWindow') || '90', 10),
  };

  console.log('[Train] Loading R4A data for last', config.trainingWindow, 'days...');
  const rawRows = loadR4ARows(config.trainingWindow);
  console.log('[Train] Loaded', rawRows.length, 'rows');

  if (rawRows.length < 20) {
    throw new Error(`Insufficient data: only ${rawRows.length} rows with outcomes. Need at least 20.`);
  }

  // Compute quantile boundaries from full training set
  const quantileBoundaries = {};
  for (const feat of QUANTILE_FEATURES) {
    quantileBoundaries[feat] = rawRows
      .map(r => r[feat]).filter(v => v != null && !isNaN(v)).sort((a, b) => a - b);
  }

  const rowsWithBuckets = assignBuckets(rawRows, quantileBoundaries);
  const { featureData, globalWinRate, totalRows } = computeFeatureImportance(rowsWithBuckets, config.successThreshold);

  console.log('[Train] Feature importance computed.');

  // Serialize: store quantile boundaries as sorted arrays (needed for live scoring)
  const modelFeatures = {};
  for (const [feat, fd] of Object.entries(featureData)) {
    modelFeatures[feat] = {
      importance: fd.importance,
      importancePct: fd.importancePct,
      buckets: fd.buckets,
      quantileSorted: QUANTILE_FEATURES.includes(feat) ? quantileBoundaries[feat] : undefined,
    };
  }

  const model = {
    config,
    features: modelFeatures,
    globalWinRate,
    totalRows,
    trainedAt: Date.now(),
  };

  db.prepare(`
    INSERT OR REPLACE INTO analysis_model (id, trained_at, config, features, backtest, insights)
    VALUES (1, ?, ?, ?, ?, NULL)
  `).run(
    model.trainedAt,
    JSON.stringify(config),
    JSON.stringify(modelFeatures),
    JSON.stringify({ globalWinRate, totalRows })
  );

  console.log('[Train] Model saved to DB');
  return model;
}

function loadModel() {
  const row = db.prepare('SELECT * FROM analysis_model WHERE id = 1').get();
  if (!row) return null;
  return {
    config: JSON.parse(row.config),
    features: JSON.parse(row.features),
    backtest: JSON.parse(row.backtest),
    insights: row.insights ? JSON.parse(row.insights) : null,
    trainedAt: row.trained_at,
  };
}

module.exports = { trainModel, loadModel, CRITICAL_BUCKETS, QUANTILE_FEATURES, CATEGORICAL_FEATURES };
