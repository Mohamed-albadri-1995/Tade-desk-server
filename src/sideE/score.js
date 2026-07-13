const axios = require('axios');
const db = require('../db');

const SCORER_URL = process.env.SCORER_URL || 'http://127.0.0.1:3001';
const SCORER_TIMEOUT = 5000;

function getEntryTime() {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'scorerEntryTime'").get();
  return row?.value || '9:40';
}

function getRegimeSampleThreshold() {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'regimeSampleThreshold'").get();
  return row?.value ? parseInt(row.value, 10) : 10;
}

const { resolveAutoBias } = require('../sideC/bias');

// Maps r0 bias field → LiveScorer bias string. Manual bias wins, then a
// fresh directional catalyst, then trend/sector context (see sideC/bias.js).
function resolveCardBias(row) {
  return resolveAutoBias(row).bias === 'short' ? 'Short' : 'Long';
}

// Build a flat card dict from r0 row (matches LiveScorer ALL_FEATURES)
function buildCard(row) {
  const s   = row.stock   || {};
  const ctx = row.context || {};
  const cat = row.catalyst || {};
  // Normalize bias to its resolved value so 'auto' that resolves to long
  // and explicit 'long' encode identically in the PCA feature matrix.
  const resolvedBias = resolveCardBias(row); // 'Long' | 'Short' | 'Undefined'
  const normalizedBias = resolvedBias === 'Long' ? 'long' : resolvedBias === 'Short' ? 'short' : 'auto';
  return {
    ticker:        row.ticker,
    date:          row.date,
    // categoricals
    sector:        s.sector       || null,
    industry:      s.industry     || null,
    regime:        ctx.regime     || null,
    regimeLabel:   ctx.regimeLabel || null,
    secBias:       ctx.secBias    || null,
    themes:        Array.isArray(ctx.themes) ? ctx.themes.sort().join('+') : null,
    catalyst:      cat.label      || null,
    screenerKeys:  Array.isArray(row.screenerKeys) ? row.screenerKeys.sort().join('+') : null,
    longTerm:      ctx.longTerm   || null,
    midTerm:       ctx.midTerm    || null,
    shortTerm:     ctx.shortTerm  || null,
    broadResolved: ctx.broadResolved || null,
    inShortlist:   row.inShortlist ? 'true' : 'false',
    bias:          normalizedBias,
    // numerics
    price:         s.price,
    prevClose:     s.prevClose,
    open:          s.open,
    change:        s.change,
    gapPct:        s.gapPct,
    vwap:          s.vwap,
    sma5:          s.sma5,
    ema9:          s.ema9,
    ema13:         s.ema13,
    ema20:         s.ema20,
    ema50:         s.ema50,
    rvol:          s.rvol,
    atr:           s.atr,
    adrPct:        s.adrPct,
    dayHigh:       s.dayHigh,
    dayLow:        s.dayLow,
    monthHigh:     s.monthHigh,
    monthLow:      s.monthLow,
    monthRangePos: s.monthRangePos,
    mcap:          s.mcap,
    floatShares:   s.floatShares,
    shortFloat:    s.shortFloat,
    pmHigh:        s.pmHigh,
    pmLow:         s.pmLow,
    pmRange:       s.pmRange,
    pmAdrRatio:    s.pmAdrRatio,
    secScore:      ctx.secScore,
  };
}

let _scorerAvailable = null;
let _lastCheck = 0;

async function checkScorer() {
  const now = Date.now();
  if (now - _lastCheck < 30000) return _scorerAvailable; // cache for 30s
  _lastCheck = now;
  try {
    const resp = await axios.get(`${SCORER_URL}/health`, { timeout: 2000 });
    _scorerAvailable = resp.data?.ready === true;
  } catch {
    _scorerAvailable = false;
  }
  return _scorerAvailable;
}

async function scoreRow(row) {
  if (!(await checkScorer())) return null;
  try {
    const bias = resolveCardBias(row);
    const resolvedBiasLower = bias === 'Long' ? 'long' : bias === 'Short' ? 'short' : 'auto';
    const card = buildCard(row);
    const entry_time = getEntryTime();
    const regime_sample_threshold = getRegimeSampleThreshold();
    const resp = await axios.post(`${SCORER_URL}/score`, { card, bias, entry_time, regime_sample_threshold }, { timeout: SCORER_TIMEOUT });
    if (resp.data?.ok) {
      const finalScore = resp.data.final_score;
      if (!Number.isFinite(finalScore)) {
        // ok:true + NaN happens when the trained model has a NaN
        // bucket cell — surface as null instead of silently rounding
        // to NaN → JSON null → mysterious empty score in the UI.
        console.warn(`[Scorer] ${row.ticker}: non-finite final_score (${finalScore}); buckets=${JSON.stringify(resp.data.bucket_scores)}`);
        return null;
      }
      return {
        _score: Math.round(finalScore),
        _scoreDetails: {
          table: resp.data.used_table,
          base: resp.data.used_base || (resp.data.used_table || '').split('_')[0] || null,
          tableType: resp.data.used_table_type || ((resp.data.used_table || '').includes('_sub_') ? 'sub' : 'main'),
          cardRegime: resp.data.card_regime,
          subRegimeUsed: resp.data.sub_regime_used || ((resp.data.used_table || '').split('_sub_')[1] || null),
          fallbackReason: resp.data.fallback_reason,
          confidence: Math.round((resp.data.confidence || 0) * 100),
          samples: resp.data.total_samples_used,
          factorScores: resp.data.factor_scores,
          bucketScores: resp.data.bucket_scores,
          entryTime: entry_time,
          bias,
          normalizedBias: resolvedBiasLower,
        },
      };
    }
    return null;
  } catch {
    return null;
  }
}

async function scoreAllRows(rows) {
  if (!(await checkScorer())) {
    return rows.map(row => ({ ...row, _score: null, _scoreDetails: null }));
  }
  const scored = await Promise.all(rows.map(async row => {
    const result = await scoreRow(row);
    return result ? { ...row, ...result } : { ...row, _score: null, _scoreDetails: null };
  }));
  return scored;
}

module.exports = { scoreRow, scoreAllRows, checkScorer, buildCard };
