const db = require('../db');

const REGIME_SLUGS = [
  'EXTENDED_UP','STRONG_UP','UP','WEAK_UP','PULLBACK_BULL','RECOVERY',
  'BASING','CHOP_BULL','CHOP_BEAR','CORRECTION','TOPPING',
  'BEAR_RALLY','DOWN','STRONG_DOWN','CAPITULATION',
];

const MEASURES = ['up', 'down', 'either'];

// Custom bucket boundaries for critical numerical features
const CRITICAL_BUCKETS = {
  rvol:          [0, 2, 5, 10, 20, Infinity],
  change:        [-Infinity, -10, -5, -2, 0, 2, 5, 10, Infinity],
  gapPct:        [-Infinity, -10, -5, -2, 0, 2, 5, 10, Infinity],
  monthRangePos: [0, 20, 40, 60, 80, 100],
  secScore:      [-100, -40, -20, 0, 20, 40, 100],
  pmAdrRatio:    [0, 0.5, 1, 2, 3, Infinity],
  adrPct:        [0, 5, 10, 15, 20, 30, Infinity],
};

const QUANTILE_FEATURES = [
  'price936','prevClose','open','vwap','sma5','ema9','ema13','ema20','ema50',
  'atr','dayHigh','dayLow','monthHigh','monthLow','mcap','floatShares',
  'shortFloat','pmHigh','pmLow','pmRange',
];

const CATEGORICAL_FEATURES = [
  'secBias','sector','longTerm','midTerm','shortTerm',
  'catalyst','screenerKeys','secHot','themes','dayOfWeek',
];

const CATEGORICAL_FEATURES_WITH_REGIME = ['regime', ...CATEGORICAL_FEATURES];

const SCORE_MIN = -0.5;
const SCORE_MAX = 2.5;

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

function loadRows(days, entryType) {
  const table = entryType === 'B' ? 'r3b' : 'r3a';
  const dates = db.prepare(
    'SELECT DISTINCT date FROM r1_frozen ORDER BY date DESC LIMIT ?'
  ).all(days).map(r => r.date);

  if (dates.length === 0) return [];

  const rows = [];
  for (const date of dates) {
    const r1Rows = db.prepare('SELECT * FROM r1_frozen WHERE date = ?').all(date);
    const r3Map = {};
    for (const r of db.prepare(`SELECT * FROM ${table} WHERE date = ?`).all(date)) {
      r3Map[r.ticker] = r;
    }
    for (const r1 of r1Rows) {
      const d = JSON.parse(r1.data);
      const r3 = r3Map[d.ticker];
      if (!r3) continue;

      const upR = entryType === 'B' ? r3.up_r_b : r3.up_r_a;
      const downR = entryType === 'B' ? r3.down_r_b : r3.down_r_a;
      if (upR == null && downR == null) continue;

      rows.push({
        date,
        ticker: d.ticker,
        // Critical numerical
        rvol:          d.stock?.rvol,
        change:        d.stock?.change,
        gapPct:        d.stock?.gapPct,
        monthRangePos: d.stock?.monthRangePos,
        secScore:      d.context?.secScore,
        pmAdrRatio:    d.stock?.pmAdrRatio,
        adrPct:        d.stock?.adrPct,
        // Quantile numerical
        price936:      d.stock?.price,
        prevClose:     d.stock?.prevClose,
        open:          d.stock?.open,
        vwap:          d.stock?.vwap,
        sma5:          d.stock?.sma5,
        ema9:          d.stock?.ema9,
        ema13:         d.stock?.ema13,
        ema20:         d.stock?.ema20,
        ema50:         d.stock?.ema50,
        atr:           d.stock?.atr,
        dayHigh:       d.stock?.dayHigh,
        dayLow:        d.stock?.dayLow,
        monthHigh:     d.stock?.monthHigh,
        monthLow:      d.stock?.monthLow,
        mcap:          d.stock?.mcap,
        floatShares:   d.stock?.floatShares,
        shortFloat:    d.stock?.shortFloat,
        pmHigh:        d.stock?.pmHigh,
        pmLow:         d.stock?.pmLow,
        pmRange:       d.stock?.pmRange,
        // Categorical
        regime:        d.context?.regime,
        secBias:       d.context?.secBias,
        sector:        d.stock?.sector,
        longTerm:      d.context?.longTerm,
        midTerm:       d.context?.midTerm,
        shortTerm:     d.context?.shortTerm,
        catalyst:      d.catalyst?.label || 'none',
        screenerKeys:  Array.isArray(d.screenerKeys) ? d.screenerKeys.sort().join('+') : 'none',
        secHot:        d.context?.secHot ? 'yes' : 'no',
        themes:        Array.isArray(d.context?.themes) ? d.context.themes.sort().join('+') : 'none',
        dayOfWeek:     dayOfWeek(date),
        // Raw outcomes
        upR,
        downR,
      });
    }
  }
  return rows;
}

function getOutcome(row, measure) {
  if (measure === 'up') return row.upR;
  if (measure === 'down') return row.downR;
  // either: best of the two directions
  const u = row.upR ?? -Infinity;
  const d = row.downR ?? -Infinity;
  return Math.max(u, d) === -Infinity ? null : Math.max(u, d);
}

function assignBuckets(rows, quantileBoundaries, includeRegime) {
  const catFeatures = includeRegime ? CATEGORICAL_FEATURES_WITH_REGIME : CATEGORICAL_FEATURES;
  return rows.map(row => {
    const buckets = {};
    for (const [feat, bounds] of Object.entries(CRITICAL_BUCKETS)) {
      buckets[feat] = getBucket(row[feat], bounds);
    }
    for (const feat of QUANTILE_FEATURES) {
      buckets[feat] = getQuantileBucket(row[feat], quantileBoundaries[feat] || []);
    }
    for (const feat of catFeatures) {
      const v = row[feat];
      buckets[feat] = v != null ? String(v) : 'unknown';
    }
    return { ...row, buckets };
  });
}

function computeGlobalStats(rows, measure, winThreshold) {
  let wins = 0, winSum = 0, lossSum = 0, lossCount = 0;
  for (const row of rows) {
    const outcome = getOutcome(row, measure);
    if (outcome == null) continue;
    if (outcome >= winThreshold) {
      wins++;
      winSum += outcome;
    } else {
      lossCount++;
      lossSum += outcome;
    }
  }
  const total = wins + lossCount;
  const winRate = total > 0 ? wins / total : 0;
  const avgWinR = wins > 0 ? winSum / wins : 0;
  const avgLossR = lossCount > 0 ? lossSum / lossCount : 0;
  const globalExpectancy = (winRate * avgWinR) + ((1 - winRate) * avgLossR);
  return { total, winRate, avgWinR, avgLossR, globalExpectancy };
}

function normalizeScore(expectancy) {
  const clamped = Math.max(SCORE_MIN, Math.min(SCORE_MAX, expectancy));
  return ((clamped - SCORE_MIN) / (SCORE_MAX - SCORE_MIN)) * 100;
}

function computeFeatures(rows, measure, winThreshold, globalStats, includeRegime) {
  const { total: totalRows, globalExpectancy } = globalStats;
  const catFeatures = includeRegime ? CATEGORICAL_FEATURES_WITH_REGIME : CATEGORICAL_FEATURES;
  const allFeatures = [...Object.keys(CRITICAL_BUCKETS), ...QUANTILE_FEATURES, ...catFeatures];

  const globalExpectancyScore = normalizeScore(globalExpectancy);
  const featureData = {};

  for (const feat of allFeatures) {
    const bucketMap = {};
    for (const row of rows) {
      const b = row.buckets?.[feat];
      if (b == null) continue;
      const outcome = getOutcome(row, measure);
      if (outcome == null) continue;
      if (!bucketMap[b]) bucketMap[b] = { count: 0, wins: 0, winSum: 0, lossSum: 0, lossCount: 0 };
      const bm = bucketMap[b];
      bm.count++;
      if (outcome >= winThreshold) {
        bm.wins++;
        bm.winSum += outcome;
      } else {
        bm.lossCount++;
        bm.lossSum += outcome;
      }
    }

    const nFeat = Object.values(bucketMap).reduce((s, b) => s + b.count, 0);
    const buckets = {};

    for (const [b, bm] of Object.entries(bucketMap)) {
      const winRate = bm.count > 0 ? bm.wins / bm.count : 0;
      const avgWinR = bm.wins > 0 ? bm.winSum / bm.wins : 0;
      const avgLossR = bm.lossCount > 0 ? bm.lossSum / bm.lossCount : 0;
      const rawExpectancy = (winRate * avgWinR) + ((1 - winRate) * avgLossR);
      const credibility = nFeat > 0 ? bm.count / nFeat : 0;
      const adjustedExpectancy = credibility * rawExpectancy + (1 - credibility) * globalExpectancy;
      const bucketScore = normalizeScore(adjustedExpectancy);
      const lift = bucketScore - globalExpectancyScore;

      buckets[b] = {
        count: bm.count,
        wins: bm.wins,
        winRate,
        avgWinR,
        avgLossR,
        rawExpectancy,
        adjustedExpectancy,
        bucketScore,
        lift,
      };
    }

    // Feature importance = weighted variance of adjustedExpectancy
    const weightedMean = nFeat > 0
      ? Object.values(buckets).reduce((s, bk) => s + (bk.count / nFeat) * bk.adjustedExpectancy, 0)
      : 0;
    const importance = Object.values(buckets).reduce(
      (s, bk) => s + (bk.count / (nFeat || 1)) * Math.pow(bk.adjustedExpectancy - weightedMean, 2),
      0
    );

    featureData[feat] = { importance, buckets, nFeat };
  }

  // Normalize importance to pct
  const totalImportance = Object.values(featureData).reduce((s, f) => s + f.importance, 0);
  for (const feat of allFeatures) {
    featureData[feat].importancePct = totalImportance > 0
      ? (featureData[feat].importance / totalImportance) * 100
      : 0;
  }

  return featureData;
}

function saveTable(measure, regime, config, globalStats, featureData, rowCount, isEmpty) {
  const featuresPayload = {};
  for (const [feat, fd] of Object.entries(featureData)) {
    featuresPayload[feat] = {
      importance:    fd.importance,
      importancePct: fd.importancePct,
      nFeat:         fd.nFeat,
      buckets:       fd.buckets,
    };
  }

  db.prepare(`
    INSERT OR REPLACE INTO analysis_model
      (measure, regime, trained_at, config, global_stats, features, is_empty, row_count)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    measure,
    regime,
    Date.now(),
    JSON.stringify(config),
    JSON.stringify(globalStats),
    JSON.stringify(featuresPayload),
    isEmpty ? 1 : 0,
    rowCount
  );
}

function trainAllModels(overrides = {}) {
  const getSetting = k => {
    const r = db.prepare('SELECT value FROM settings WHERE key = ?').get(k);
    return r ? r.value : null;
  };

  const config = {
    entryType:      overrides.entryType      || getSetting('analysisEntryType')      || 'A',
    winThreshold:   parseFloat(overrides.winThreshold   || getSetting('analysisWinThreshold')   || '1.3'),
    trainingWindow: parseInt(overrides.trainingWindow   || getSetting('analysisTrainingWindow')  || '90', 10),
    minRegimeRows:  parseInt(overrides.minRegimeRows    || getSetting('analysisMinRegimeRows')   || '10', 10),
  };

  console.log('[Train] Loading R4 data, entryType=%s, window=%d days...', config.entryType, config.trainingWindow);
  const rawRows = loadRows(config.trainingWindow, config.entryType);
  console.log('[Train] Loaded %d rows', rawRows.length);

  if (rawRows.length < 10) {
    throw new Error(`Insufficient data: only ${rawRows.length} rows with outcomes. Need at least 10.`);
  }

  // Compute quantile boundaries from full training set
  const quantileBoundaries = {};
  for (const feat of QUANTILE_FEATURES) {
    quantileBoundaries[feat] = rawRows
      .map(r => r[feat]).filter(v => v != null && !isNaN(v)).sort((a, b) => a - b);
  }

  // Assign buckets once for all rows (general — includes regime)
  const rowsWithBuckets = assignBuckets(rawRows, quantileBoundaries, true);

  let tablesWritten = 0;

  for (const measure of MEASURES) {
    // --- General table (all rows, regime IS a feature) ---
    const globalStats = computeGlobalStats(rowsWithBuckets, measure, config.winThreshold);
    const generalFeatures = computeFeatures(rowsWithBuckets, measure, config.winThreshold, globalStats, true);
    saveTable(measure, 'general', config, globalStats, generalFeatures, rawRows.length, false);
    tablesWritten++;
    console.log('[Train] measure=%s regime=general rows=%d', measure, rawRows.length);

    // --- Regime-specific tables (regime EXCLUDED as feature) ---
    for (const regime of REGIME_SLUGS) {
      const regimeRows = rowsWithBuckets.filter(r => r.regime === regime);
      const rowCount = regimeRows.length;

      if (rowCount < config.minRegimeRows) {
        // Store empty marker
        saveTable(measure, regime, config, { total: rowCount }, {}, rowCount, true);
        tablesWritten++;
        console.log('[Train] measure=%s regime=%s rows=%d (empty — below threshold)', measure, regime, rowCount);
        continue;
      }

      // Re-assign buckets without regime field
      const regimeRowsNoBucket = regimeRows.map(r => {
        const b = { ...r.buckets };
        delete b.regime;
        return { ...r, buckets: b };
      });

      const regimeGlobalStats = computeGlobalStats(regimeRowsNoBucket, measure, config.winThreshold);
      const regimeFeatures = computeFeatures(regimeRowsNoBucket, measure, config.winThreshold, regimeGlobalStats, false);
      saveTable(measure, regime, config, regimeGlobalStats, regimeFeatures, rowCount, false);
      tablesWritten++;
      console.log('[Train] measure=%s regime=%s rows=%d', measure, regime, rowCount);
    }
  }

  console.log('[Train] Done — %d tables written to DB', tablesWritten);
  return {
    tablesWritten,
    totalRows: rawRows.length,
    config,
    trainedAt: Date.now(),
  };
}

function loadTable(measure, regime) {
  const row = db.prepare(
    'SELECT * FROM analysis_model WHERE measure = ? AND regime = ?'
  ).get(measure, regime);
  if (!row) return null;
  return {
    measure:     row.measure,
    regime:      row.regime,
    trainedAt:   row.trained_at,
    config:      JSON.parse(row.config),
    globalStats: JSON.parse(row.global_stats),
    features:    JSON.parse(row.features),
    isEmpty:     row.is_empty === 1,
    rowCount:    row.row_count,
    insights:    row.insights ? JSON.parse(row.insights) : null,
  };
}

function listTables() {
  return db.prepare(
    'SELECT measure, regime, trained_at, is_empty, row_count FROM analysis_model ORDER BY measure, regime'
  ).all();
}

module.exports = {
  trainAllModels,
  loadTable,
  listTables,
  CRITICAL_BUCKETS,
  QUANTILE_FEATURES,
  CATEGORICAL_FEATURES,
  MEASURES,
  REGIME_SLUGS,
};
