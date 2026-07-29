/*
 * Relational signals — Side B.
 *
 * The raw card carries price, sma5, ema9/13/20/50, vwap, prevClose … all as
 * dollar amounts. Because those all scale with the share price they move
 * together, which is why the factor model collapses them into a single
 * "how expensive is one share" axis that says nothing about the setup.
 *
 * What actually describes a setup is the RELATIONSHIP between them, which is
 * unit-free and therefore comparable across a $1 stock and a $99 one. Each
 * relationship is emitted twice:
 *
 *   - a flag  ('above' / 'below')  -> a tag on the card, and a filter
 *   - a distance (percent)         -> what the model needs, because "40% above
 *                                     ema20" and "0.1% above" are the same flag
 *                                     but very different facts
 *
 * Everything is null-safe: a missing input yields null rather than NaN, so a
 * partial card degrades one field at a time instead of poisoning the row.
 */

const num = v => (Number.isFinite(v) ? v : null);

// Percent distance of `price` from `ref`, positive when price is higher.
function pctFrom(price, ref) {
  const p = num(price), r = num(ref);
  if (p === null || r === null || r === 0) return null;
  return ((p - r) / Math.abs(r)) * 100;
}

function side(dist) {
  if (dist === null) return null;
  return dist >= 0 ? 'above' : 'below';
}

// Moving-average stack. 'bull' when each faster average sits above the slower
// one, 'bear' when fully inverted, otherwise 'mixed'. `stackScore` keeps the
// magnitude the label throws away: how many of the three orderings hold.
function maStack(ema9, ema13, ema20, ema50) {
  const a = num(ema9), b = num(ema13), c = num(ema20), d = num(ema50);
  if ([a, b, c, d].some(v => v === null)) return { maStack: null, maStackScore: null };
  const up = [a > b, b > c, c > d];
  const hits = up.filter(Boolean).length;
  const label = hits === 3 ? 'bull' : hits === 0 ? 'bear' : 'mixed';
  return { maStack: label, maStackScore: hits };
}

// Quarter of the 1-month range the price sits in. Q1 is the bottom quarter —
// the "lower quarter of monthly range" case.
function rangeQuarter(pos) {
  const p = num(pos);
  if (p === null) return null;
  if (p < 25) return 'Q1';
  if (p < 50) return 'Q2';
  if (p < 75) return 'Q3';
  return 'Q4';
}

// Pre-market range measured against a normal day's range. Banded because the
// raw ratio is heavily skewed (values from 0 to 30+).
function pmBand(ratio) {
  const r = num(ratio);
  if (r === null) return null;
  if (r < 0.5) return '<0.5';
  if (r < 1) return '0.5-1';
  if (r < 2) return '1-2';
  if (r < 3) return '2-3';
  return '3+';
}

/**
 * Compute every relational signal for one stock snapshot.
 * @param {object} stock - an r0 row's `stock` object (post Side B derivations)
 * @returns {object} flags, distances and structure labels
 */
function computeRelations(stock) {
  const s = stock || {};
  const price = num(s.price);

  // price vs each reference level
  const refs = {
    Ema9: s.ema9, Ema13: s.ema13, Ema20: s.ema20, Ema50: s.ema50,
    Sma5: s.sma5, Vwap: s.vwap, PrevClose: s.prevClose, Open: s.open,
    PmHigh: s.pmHigh, PmLow: s.pmLow,
  };

  const out = {};
  for (const [name, ref] of Object.entries(refs)) {
    const d = pctFrom(price, ref);
    out[`dist${name}`] = d === null ? null : Number(d.toFixed(3));
    out[`vs${name}`] = side(d);
  }

  // "clean" states worth a single tag rather than reading five flags
  const maSides = ['vsEma9', 'vsEma13', 'vsEma20', 'vsEma50'].map(k => out[k]);
  const known = maSides.filter(v => v !== null);
  out.aboveAllMas = known.length === 4 && known.every(v => v === 'above');
  out.belowAllMas = known.length === 4 && known.every(v => v === 'below');

  Object.assign(out, maStack(s.ema9, s.ema13, s.ema20, s.ema50));

  out.monthQuarter = rangeQuarter(s.monthRangePos);
  out.pmAdrBand = pmBand(s.pmAdrRatio);

  // where price sits inside today's range: 0 = on the low, 100 = on the high
  const dh = num(s.dayHigh), dl = num(s.dayLow);
  out.dayRangePos = (dh !== null && dl !== null && dh > dl && price !== null)
    ? Number((((price - dl) / (dh - dl)) * 100).toFixed(2))
    : null;

  return out;
}

function applyRelations(rows) {
  return rows.map(row => ({ ...row, signals: computeRelations(row.stock) }));
}

// Field groups, exported so the scorer, the registers and the card all agree
// on the names instead of each keeping its own copy.
const RELATION_FLAGS = [
  'vsEma9', 'vsEma13', 'vsEma20', 'vsEma50', 'vsSma5', 'vsVwap',
  'vsPrevClose', 'vsOpen', 'vsPmHigh', 'vsPmLow',
  'maStack', 'monthQuarter', 'pmAdrBand',
];

const RELATION_NUMERICS = [
  'distEma9', 'distEma13', 'distEma20', 'distEma50', 'distSma5', 'distVwap',
  'distPrevClose', 'distOpen', 'distPmHigh', 'distPmLow',
  'maStackScore', 'dayRangePos',
];

const RELATION_BOOLS = ['aboveAllMas', 'belowAllMas'];

const RELATION_FIELDS = [...RELATION_FLAGS, ...RELATION_NUMERICS, ...RELATION_BOOLS];

module.exports = {
  computeRelations,
  applyRelations,
  RELATION_FLAGS,
  RELATION_NUMERICS,
  RELATION_BOOLS,
  RELATION_FIELDS,
};
