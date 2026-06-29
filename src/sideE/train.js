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

function runWalkForwardBacktest(config) {
  const { successThreshold, trainingWindow } = config;
  const allDates = db.prepare('SELECT DISTINCT date FROM r1_frozen ORDER BY date ASC').all().map(r => r.date);

  const backtestDays = [];
  for (let i = trainingWindow; i < allDates.length; i++) {
    const testDate = allDates[i];
    const trainDates = allDates.slice(Math.max(0, i - trainingWindow), i);

    // Load training rows
    const trainRows = [];
    for (const d of trainDates) {
      const r1Rows = db.prepare('SELECT * FROM r1_frozen WHERE date = ?').all(d);
      const r3aMap = {};
      for (const r of db.prepare('SELECT * FROM r3a WHERE date = ?').all(d)) {
        r3aMap[r.ticker] = r;
      }
      for (const r1 of r1Rows) {
        const dj = JSON.parse(r1.data);
        const r3a = r3aMap[dj.ticker];
        if (!r3a || r3a.up_r_a == null) continue;
        trainRows.push({
          date: d, ticker: dj.ticker,
          rvol: dj.stock?.rvol, change: dj.stock?.change, gapPct: dj.stock?.gapPct,
          monthRangePos: dj.stock?.monthRangePos, secScore: dj.context?.secScore,
          pmAdrRatio: dj.stock?.pmAdrRatio, adrPct: dj.stock?.adrPct,
          price936: dj.stock?.price, prevClose: dj.stock?.prevClose, open: dj.stock?.open,
          vwap: dj.stock?.vwap, sma5: dj.stock?.sma5, ema9: dj.stock?.ema9,
          ema13: dj.stock?.ema13, ema20: dj.stock?.ema20, ema50: dj.stock?.ema50,
          atr: dj.stock?.atr, dayHigh: dj.stock?.dayHigh, dayLow: dj.stock?.dayLow,
          monthHigh: dj.stock?.monthHigh, monthLow: dj.stock?.monthLow,
          mcap: dj.stock?.mcap, floatShares: dj.stock?.floatShares,
          shortFloat: dj.stock?.shortFloat, pmHigh: dj.stock?.pmHigh,
          pmLow: dj.stock?.pmLow, pmRange: dj.stock?.pmRange,
          regime: dj.context?.regime, secBias: dj.context?.secBias,
          sector: dj.stock?.sector, longTerm: dj.context?.longTerm,
          midTerm: dj.context?.midTerm, shortTerm: dj.context?.shortTerm,
          catalyst: dj.catalyst?.label || 'none',
          screenerKeys: Array.isArray(dj.screenerKeys) ? dj.screenerKeys.sort().join('+') : 'none',
          secHot: dj.context?.secHot ? 'yes' : 'no',
          themes: Array.isArray(dj.context?.themes) ? dj.context.themes.sort().join('+') : 'none',
          dayOfWeek: dayOfWeek(d),
          upR_A: r3a.up_r_a,
        });
      }
    }

    if (trainRows.length < 10) continue;

    // Compute quantile boundaries from training data
    const quantileBoundaries = {};
    for (const feat of QUANTILE_FEATURES) {
      quantileBoundaries[feat] = trainRows
        .map(r => r[feat]).filter(v => v != null && !isNaN(v)).sort((a, b) => a - b);
    }

    const trainWithBuckets = assignBuckets(trainRows, quantileBoundaries);
    const { featureData, globalWinRate } = computeFeatureImportance(trainWithBuckets, successThreshold);

    // Score test day tickers
    const testR1 = db.prepare('SELECT * FROM r1_frozen WHERE date = ?').all(testDate);
    const testR3aMap = {};
    for (const r of db.prepare('SELECT * FROM r3a WHERE date = ?').all(testDate)) {
      testR3aMap[r.ticker] = r;
    }

    const scored = [];
    for (const r1 of testR1) {
      const dj = JSON.parse(r1.data);
      const r3a = testR3aMap[dj.ticker];
      if (!r3a || r3a.up_r_a == null) continue;

      const testRow = {
        date: testDate, ticker: dj.ticker,
        rvol: dj.stock?.rvol, change: dj.stock?.change, gapPct: dj.stock?.gapPct,
        monthRangePos: dj.stock?.monthRangePos, secScore: dj.context?.secScore,
        pmAdrRatio: dj.stock?.pmAdrRatio, adrPct: dj.stock?.adrPct,
        price936: dj.stock?.price, prevClose: dj.stock?.prevClose, open: dj.stock?.open,
        vwap: dj.stock?.vwap, sma5: dj.stock?.sma5, ema9: dj.stock?.ema9,
        ema13: dj.stock?.ema13, ema20: dj.stock?.ema20, ema50: dj.stock?.ema50,
        atr: dj.stock?.atr, dayHigh: dj.stock?.dayHigh, dayLow: dj.stock?.dayLow,
        monthHigh: dj.stock?.monthHigh, monthLow: dj.stock?.monthLow,
        mcap: dj.stock?.mcap, floatShares: dj.stock?.floatShares,
        shortFloat: dj.stock?.shortFloat, pmHigh: dj.stock?.pmHigh,
        pmLow: dj.stock?.pmLow, pmRange: dj.stock?.pmRange,
        regime: dj.context?.regime, secBias: dj.context?.secBias,
        sector: dj.stock?.sector, longTerm: dj.context?.longTerm,
        midTerm: dj.context?.midTerm, shortTerm: dj.context?.shortTerm,
        catalyst: dj.catalyst?.label || 'none',
        screenerKeys: Array.isArray(dj.screenerKeys) ? dj.screenerKeys.sort().join('+') : 'none',
        secHot: dj.context?.secHot ? 'yes' : 'no',
        themes: Array.isArray(dj.context?.themes) ? dj.context.themes.sort().join('+') : 'none',
        dayOfWeek: dayOfWeek(testDate),
        upR_A: r3a.up_r_a,
      };

      const rowWithBuckets = assignBuckets([testRow], quantileBoundaries)[0];

      // Score using trained model
      let weightedWinRate = 0;
      let totalWeight = 0;
      for (const [feat, fd] of Object.entries(featureData)) {
        const b = rowWithBuckets.buckets[feat];
        if (!b || !fd.buckets[b]) continue;
        weightedWinRate += fd.importance * fd.buckets[b].winRate;
        totalWeight += fd.importance;
      }
      const rawScore = totalWeight > 0 ? weightedWinRate / totalWeight : globalWinRate;
      scored.push({ ticker: dj.ticker, score: rawScore, upR_A: r3a.up_r_a });
    }

    if (scored.length < 5) continue;

    scored.sort((a, b) => b.score - a.score);
    const n = Math.max(1, Math.floor(scored.length / 10));
    const top = scored.slice(0, n);
    const bottom = scored.slice(-n);

    const topWR = top.filter(r => r.upR_A >= successThreshold).length / top.length;
    const bottomWR = bottom.filter(r => r.upR_A >= successThreshold).length / bottom.length;
    const baseWR = scored.filter(r => r.upR_A >= successThreshold).length / scored.length;

    backtestDays.push({ date: testDate, topWR, bottomWR, baseWR, n: scored.length });
  }

  if (backtestDays.length === 0) return { days: [], avgTopWR: null, avgBottomWR: null, avgBaseWR: null };

  const avgTopWR = backtestDays.reduce((s, d) => s + d.topWR, 0) / backtestDays.length;
  const avgBottomWR = backtestDays.reduce((s, d) => s + d.bottomWR, 0) / backtestDays.length;
  const avgBaseWR = backtestDays.reduce((s, d) => s + d.baseWR, 0) / backtestDays.length;

  return { days: backtestDays, avgTopWR, avgBottomWR, avgBaseWR };
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

  console.log('[Train] Feature importance computed, running walk-forward backtest...');
  const backtest = runWalkForwardBacktest(config);

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
    backtest,
    trainedAt: Date.now(),
  };

  db.prepare(`
    INSERT OR REPLACE INTO analysis_model (id, trained_at, config, features, backtest, insights)
    VALUES (1, ?, ?, ?, ?, NULL)
  `).run(
    model.trainedAt,
    JSON.stringify(config),
    JSON.stringify(modelFeatures),
    JSON.stringify({ ...backtest, globalWinRate, totalRows })
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
