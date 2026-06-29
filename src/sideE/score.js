const axios = require('axios');

const SCORER_URL = process.env.SCORER_URL || 'http://127.0.0.1:3001';
const SCORER_TIMEOUT = 5000;

// Maps r0 bias field → LiveScorer bias string
function resolveCardBias(row) {
  const b = row.bias || 'auto';
  if (b === 'long') return 'Long';
  if (b === 'short') return 'Short';
  // auto: derive from context
  const short = row.context?.shortTerm;
  const sec   = row.context?.secBias;
  if (short === 'BULLISH' && sec === 'BULLISH') return 'Long';
  if (short === 'BEARISH' || sec === 'BEARISH')  return 'Short';
  return 'Undefined';
}

// Build a flat card dict from r0 row (matches LiveScorer ALL_FEATURES)
function buildCard(row) {
  const s   = row.stock   || {};
  const ctx = row.context || {};
  const cat = row.catalyst || {};
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
    // numerics
    _score:        row._score,
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
    const card = buildCard(row);
    const resp = await axios.post(`${SCORER_URL}/score`, { card, bias }, { timeout: SCORER_TIMEOUT });
    if (resp.data?.ok) return Math.round(resp.data.final_score);
    return null;
  } catch {
    return null;
  }
}

async function scoreAllRows(rows) {
  if (!(await checkScorer())) {
    return rows.map(row => ({ ...row, _score: null }));
  }
  const scored = await Promise.all(rows.map(async row => ({
    ...row,
    _score: await scoreRow(row),
  })));
  return scored;
}

module.exports = { scoreRow, scoreAllRows, checkScorer, buildCard };
