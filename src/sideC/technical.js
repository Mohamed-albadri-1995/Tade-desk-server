/*
 * Technical catalysts — price/volume events the tape itself proves, detected
 * from the row's stock data (Side A/B fields), no news required.
 *
 * Hard rules to keep them from fighting the news classifier:
 *  1. A news catalyst ALWAYS outranks a technical one. Technicals can only be
 *     the primary catalyst when the ticker has no news catalyst at all — and
 *     then confidence is capped, because a move without a story is never a
 *     high-conviction catalyst.
 *  2. When a news primary exists, technicals that agree with (or are
 *     orthogonal to a neutral) news primary are appended to `others`;
 *     technicals that CONTRADICT the news primary's direction are dropped
 *     entirely — no ambiguity, no two arrows pointing different ways.
 *  3. Only unambiguous, high-bar signals are detected. Anything marginal is
 *     left out by design; thresholds live in TECH so they're tunable.
 */

const TECH = {
  gapPct: 4,          // min |gap| % for a gap catalyst
  gapRvol: 2.5,       // ...with at least this relative volume
  surgeRvol: 5,       // volume surge threshold
  surgeMinChange: 2,  // ...but only if price actually moved (%)
  bigMoveAdrMult: 2,  // |change| must exceed this × ADR%
  bigMoveMin: 5,      // ...and be at least this % absolute
  levelRvol: 2,       // min rvol for a monthly-range break to count
  squeezeShortFloat: 20, // min short float % for squeeze setup
  squeezeChange: 3,   // ...moving up at least this %
  squeezeRvol: 3,
};

const TIER_NAME = { 1: 'major', 2: 'notable', 3: 'minor' };

function mk(label, sentiment, color, tier, detail) {
  return {
    label, sentiment, color, tier,
    tierName: TIER_NAME[tier],
    source: 'technical',
    score: tier === 2 ? 60 : 30,
    detail,
  };
}

const num = v => (Number.isFinite(v) ? v : null);

/**
 * Detect technical catalysts from a stock snapshot (r0 row.stock).
 * Returns [] when data is missing or nothing clears the bar. Within the
 * "move" family (gap / surge / big move) only the strongest is kept — it is
 * one fact ("the stock is moving hard") worded three ways.
 */
function detectTechnicalCatalysts(stock) {
  const s = stock || {};
  const gap = num(s.gapPct), rvol = num(s.rvol), change = num(s.change);
  const price = num(s.price), monthHigh = num(s.monthHigh), monthLow = num(s.monthLow);
  const adrPct = num(s.adrPct), shortFloat = num(s.shortFloat);

  const move = [];
  if (gap != null && rvol != null && Math.abs(gap) >= TECH.gapPct && rvol >= TECH.gapRvol) {
    move.push(gap > 0
      ? mk('Gap Up', 'bull', '#4ade80', 2, `gap +${gap.toFixed(1)}% on ${rvol.toFixed(1)}× vol`)
      : mk('Gap Down', 'bear', '#f87171', 2, `gap ${gap.toFixed(1)}% on ${rvol.toFixed(1)}× vol`));
  }
  if (change != null && adrPct != null && adrPct > 0 && rvol != null
      && Math.abs(change) >= TECH.bigMoveAdrMult * adrPct
      && Math.abs(change) >= TECH.bigMoveMin && rvol >= TECH.levelRvol) {
    move.push(mk(change > 0 ? 'Big Move Up' : 'Big Move Down',
      change > 0 ? 'bull' : 'bear', change > 0 ? '#4ade80' : '#f87171', 2,
      `${change > 0 ? '+' : ''}${change.toFixed(1)}% = ${(Math.abs(change) / adrPct).toFixed(1)}× ADR`));
  }
  if (rvol != null && change != null && rvol >= TECH.surgeRvol && Math.abs(change) >= TECH.surgeMinChange) {
    move.push(mk('Volume Surge', change > 0 ? 'bull' : 'bear', '#fb923c', 2,
      `${rvol.toFixed(1)}× volume, ${change > 0 ? '+' : ''}${change.toFixed(1)}%`));
  }

  const out = [];
  if (move.length) out.push(move[0]); // one "it's moving" catalyst, first = strongest signal type

  if (price != null && rvol != null && rvol >= TECH.levelRvol) {
    if (monthHigh != null && price >= monthHigh && change != null && change > 0) {
      out.push(mk('Monthly Breakout', 'bull', '#22d3ee', 2, `above 1-month high $${monthHigh}`));
    } else if (monthLow != null && price <= monthLow && change != null && change < 0) {
      out.push(mk('Monthly Breakdown', 'bear', '#f87171', 2, `below 1-month low $${monthLow}`));
    }
  }

  if (shortFloat != null && change != null && rvol != null
      && shortFloat >= TECH.squeezeShortFloat && change >= TECH.squeezeChange && rvol >= TECH.squeezeRvol) {
    out.push(mk('Squeeze Setup', 'bull', '#fb923c', 3, `${shortFloat.toFixed(0)}% short float, +${change.toFixed(1)}% on ${rvol.toFixed(1)}× vol`));
  }

  return out;
}

/**
 * Merge the news catalyst with technical detections under the no-conflict
 * rules above. Always returns a catalyst-shaped object or null.
 */
function combineCatalyst(newsCatalyst, stock) {
  const tech = detectTechnicalCatalysts(stock);
  if (!tech.length) return newsCatalyst || null;

  if (!newsCatalyst) {
    const [primary, ...rest] = tech;
    return {
      ...primary,
      confidence: primary.tier <= 2 ? 'medium' : 'low', // tape without a story is never 'high'
      corroboration: 1,
      ageHours: 0,
      stale: false,
      others: rest,
    };
  }

  // News wins. Keep only technicals that don't fight the news direction;
  // a neutral news primary (e.g. plain "Earnings") accepts either direction —
  // the tape is what disambiguates it.
  const aligned = tech.filter(t =>
    newsCatalyst.sentiment === 'neutral' || t.sentiment === newsCatalyst.sentiment);
  if (!aligned.length) return newsCatalyst;
  return { ...newsCatalyst, others: [...(newsCatalyst.others || []), ...aligned] };
}

module.exports = { detectTechnicalCatalysts, combineCatalyst, TECH };
