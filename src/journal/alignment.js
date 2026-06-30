/**
 * Direction-aware alignment logic.
 *
 * For each condition key, defines what "aligned" means for Long vs Short.
 * Returns true (aligned), false (not aligned), or null (data not available).
 */

const ALIGNMENT_RULES = {
  // Price vs levels — Long: above = aligned; Short: below = aligned
  price_vs_vwap:    (v, dir) => v?.price_rel_vwap  === (dir === 'Long' ? 'above' : 'below'),
  price_vs_ema9:    (v, dir) => v?.price_rel_ema9   === (dir === 'Long' ? 'above' : 'below'),
  price_vs_ema13:   (v, dir) => v?.price_rel_ema13  === (dir === 'Long' ? 'above' : 'below'),
  price_vs_ema20:   (v, dir) => v?.price_rel_ema20  === (dir === 'Long' ? 'above' : 'below'),
  price_vs_ema50:   (v, dir) => v?.price_rel_ema50  === (dir === 'Long' ? 'above' : 'below'),
  price_vs_sma20:   (v, dir) => {
    if (v?.price == null || v?.sma20 == null) return null;
    return dir === 'Long' ? v.price > v.sma20 : v.price < v.sma20;
  },
  price_vs_bb_mid:  (v, dir) => {
    if (v?.price == null || v?.bb_mid == null) return null;
    return dir === 'Long' ? v.price > v.bb_mid : v.price < v.bb_mid;
  },

  // MA stack: EMA9 > EMA13 > EMA20 = bullish for Long, bearish for Short
  ema_stack: (v, dir) => {
    if (v?.ema_stack_bullish == null) return null;
    return dir === 'Long' ? v.ema_stack_bullish === 1 : v.ema_stack_bullish === 0;
  },

  // BB zone
  bb_zone: (v, dir) => {
    if (!v?.bb_zone) return null;
    return dir === 'Long' ? v.bb_zone === 'upper' : v.bb_zone === 'lower';
  },

  // Pre-market levels
  pm_high: (v, dir) => {
    if (v?.price == null || v?.pm_high == null) return null;
    return dir === 'Long' ? v.price > v.pm_high : v.price < v.pm_high;
  },
  pm_low: (v, dir) => {
    if (v?.price == null || v?.pm_low == null) return null;
    // For long: above PM Low (support held). For short: below PM Low (support broke).
    return dir === 'Long' ? v.price > v.pm_low : v.price < v.pm_low;
  },

  // rvol — threshold-based, same logic for both directions
  rvol: (v, dir, params) => {
    const threshold = params?.rvol_threshold || 1.5;
    if (v?.rvol == null) return null;
    return v.rvol >= threshold;
  },

  // Scanner context fields
  sec_bias: (v, dir, _p, ctx) => {
    if (!ctx?.sec_bias) return null;
    return dir === 'Long' ? ctx.sec_bias === 'BULLISH' : ctx.sec_bias === 'BEARISH';
  },
  broad_resolved: (v, dir, _p, ctx) => {
    if (!ctx?.broad_resolved) return null;
    return dir === 'Long' ? ctx.broad_resolved === 'BULLISH' : ctx.broad_resolved === 'BEARISH';
  },
  short_term: (v, dir, _p, ctx) => {
    if (!ctx?.short_term) return null;
    return dir === 'Long' ? ctx.short_term === 'BULLISH' : ctx.short_term === 'BEARISH';
  },
  mid_term: (v, dir, _p, ctx) => {
    if (!ctx?.mid_term) return null;
    return dir === 'Long' ? ctx.mid_term === 'BULLISH' : ctx.mid_term === 'BEARISH';
  },
  long_term: (v, dir, _p, ctx) => {
    if (!ctx?.long_term) return null;
    return dir === 'Long' ? ctx.long_term === 'BULLISH' : ctx.long_term === 'BEARISH';
  },
  hot_sector: (v, dir, params, ctx) => {
    const threshold = params?.hot_sector_threshold || 20;
    if (ctx?.sec_score == null) return null;
    return dir === 'Long' ? ctx.sec_score >= threshold : ctx.sec_score <= -threshold;
  },
};

/**
 * Evaluate alignment for a single condition key.
 *
 * @param {string} key - condition key (e.g. 'price_vs_vwap')
 * @param {string} direction - 'Long' or 'Short'
 * @param {object} technical - technical snapshot fields
 * @param {object} context - scanner context snapshot fields
 * @param {object} params - condition-specific params (thresholds etc)
 * @returns {boolean|null} true=aligned, false=not aligned, null=no data
 */
function evaluate(key, direction, technical = {}, context = {}, params = {}) {
  const rule = ALIGNMENT_RULES[key];
  if (!rule) return null;
  try {
    const result = rule(technical, direction, params, context);
    if (result == null) return null;
    return Boolean(result);
  } catch {
    return null;
  }
}

/**
 * Evaluate all conditions from a setup template for a trade.
 *
 * @param {Array} conditions - setup template conditions [{key, label, section, mandatory, params}]
 * @param {string} direction - 'Long' or 'Short'
 * @param {object} technical - technical snapshot
 * @param {object} context - context snapshot
 * @returns {Array} [{key, label, section, mandatory, value, aligned}]
 */
function evaluateAll(conditions, direction, technical, context) {
  return conditions.map(cond => ({
    condition_key: cond.key,
    label: cond.label,
    section: cond.section || 'General',
    mandatory: cond.mandatory ? 1 : 0,
    value: getDisplayValue(cond.key, technical, context),
    aligned: evaluate(cond.key, direction, technical, context, cond.params),
  }));
}

function getDisplayValue(key, tech, ctx) {
  const map = {
    price_vs_vwap: tech?.price != null && tech?.vwap != null
      ? `$${tech.price.toFixed(2)} vs VWAP $${tech.vwap.toFixed(2)}`
      : null,
    rvol:       tech?.rvol != null ? `${tech.rvol.toFixed(2)}×` : null,
    sec_bias:   ctx?.sec_bias || null,
    broad_resolved: ctx?.broad_resolved || null,
    short_term: ctx?.short_term || null,
    mid_term:   ctx?.mid_term || null,
    long_term:  ctx?.long_term || null,
    hot_sector: ctx?.sec_score != null ? `secScore ${ctx.sec_score}` : null,
    ema_stack:  tech?.ema9 != null ? `EMA9 ${tech.ema9?.toFixed(2)} / EMA13 ${tech.ema13?.toFixed(2)} / EMA20 ${tech.ema20?.toFixed(2)}` : null,
    bb_zone:    tech?.bb_zone || null,
  };
  return map[key] ?? null;
}

module.exports = { evaluate, evaluateAll, ALIGNMENT_RULES };
