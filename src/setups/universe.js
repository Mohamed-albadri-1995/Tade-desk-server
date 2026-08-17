/*
 * The card-field layer: which stocks a setup is even allowed to consider.
 *
 * WHY THIS IS NOT A SECOND STRATEGY BUILDER.
 *
 * qp decides everything about bars — VWAP, ranges, breakouts, the stop. That is
 * one engine and it stays one engine. But qp has never heard of `bias`,
 * `score`, `catalyst` or `canslim`: those are this screener's own analysis,
 * they exist only on a card, and no qp strategy can read them. So a filter over
 * them is not a duplicate of anything. It is the layer qp cannot have.
 *
 * WHY IT RUNS BEFORE qp AND NOT AFTER.
 *
 * The setup RANKS and takes the top two. Filtering afterwards means the filter
 * eats picks and leaves gaps: rank 1 and 2 come back, one fails the bias check,
 * and you trade one name while rank 3 — which passed — was discarded before you
 * ever saw it. Filtering first means the ranking happens among the names you
 * would actually take, and every one of the two is a name that passed.
 *
 * It is also cheaper, which matters at 10:00: twelve symbols to evaluate
 * instead of forty.
 *
 * A filter never needs a ranking, which is the thing that makes the order
 * possible at all — "is this card's bias bullish" is answered by looking at one
 * card, with no reference to any other.
 */

/*
 * What can be filtered on, and where it lives on a row.
 *
 * Two families, deliberately named the way they appear on the card rather than
 * the way they are stored: `score` not `_score`, because the person writing a
 * filter is reading a card, not this file.
 */
const FIELDS = {
  // The screener's own analysis — the whole reason this layer exists.
  score:        { path: r => r._score, kind: 'number', label: 'Model score' },
  bias:         { path: r => r.bias, kind: 'text', label: 'Bias' },
  autoBias:     { path: r => r.autoBias, kind: 'text', label: 'Auto bias' },
  catalyst:     { path: r => r.catalyst, kind: 'text', label: 'Catalyst' },
  canslim:      { path: r => (r.canslim ? 'yes' : 'no'), kind: 'text', label: 'On the CANSLIM list' },
  inShortlist:  { path: r => (r.inShortlist ? 'yes' : 'no'), kind: 'text', label: 'Shortlisted here' },
  shortlistedElsewhere: { path: r => r.shortlistedElsewhere, kind: 'text', label: 'Shortlisted by another tool' },
  screener:     { path: r => (r.screenerKeys || []).join(','), kind: 'text', label: 'Found by screener' },

  // Card numbers. These overlap with what an alert rule can compare, and the
  // names match on purpose: one way to say "rvol above 5" on this side.
  price:        { path: r => r.stock?.price, kind: 'number', label: 'Price' },
  change:       { path: r => r.stock?.change, kind: 'number', label: 'Change %' },
  rvol:         { path: r => r.stock?.rvol, kind: 'number', label: 'RVOL' },
  adrPct:       { path: r => r.stock?.adrPct, kind: 'number', label: 'ADR %' },
  gapPct:       { path: r => r.stock?.gapPct, kind: 'number', label: 'Gap %' },
  mcap:         { path: r => r.stock?.mcap, kind: 'number', label: 'Market cap' },
  floatShares:  { path: r => r.stock?.floatShares, kind: 'number', label: 'Float' },
  pmAdrRatio:   { path: r => r.stock?.pmAdrRatio, kind: 'number', label: 'PM / ADR' },
  monthRangePos:{ path: r => r.stock?.monthRangePos, kind: 'number', label: 'Month range %' },
  yearRangePos: { path: r => r.stock?.yearRangePos, kind: 'number', label: 'Year range %' },
};

const OPERATORS = [
  { value: 'above',    label: 'is above',      kinds: ['number'] },
  { value: 'below',    label: 'is below',      kinds: ['number'] },
  { value: 'egreater', label: 'is at least',   kinds: ['number'] },
  { value: 'eless',    label: 'is at most',    kinds: ['number'] },
  { value: 'eq',       label: 'is',            kinds: ['number', 'text'] },
  { value: 'ne',       label: 'is not',        kinds: ['number', 'text'] },
  { value: 'contains', label: 'contains',      kinds: ['text'] },
  { value: 'has',      label: 'has any of',    kinds: ['text'] },
  /*
   * ABSENCE AS A VALUE, not as "cannot tell".
   *
   * Every other operator here treats a missing field as unknown, and an
   * unknown rule DROPS the card. That is right for a gate — a card whose bias
   * has not been computed has not passed a bias test — and it makes "no news"
   * impossible to ask for: the cards with no catalyst are exactly the ones
   * that return unknown, so the filter removed the entire list it was written
   * to find.
   *
   * A setup whose whole premise is an unexplained move ("it went 15% with no
   * reason, so it should come back") cannot be built without this.
   */
  { value: 'empty',    label: 'is empty',      kinds: ['number', 'text'] },
  { value: 'notempty', label: 'has any value', kinds: ['number', 'text'] },
];
const OP_SET = new Set(OPERATORS.map(o => o.value));

/*
 * A number, including the way people actually write the big ones.
 *
 * "market cap below 50M" is the natural way to say it and 50000000 is not —
 * on a phone it is also nine taps and a miscount. Without this, "50M" parses
 * to nothing, the rule cannot be evaluated, and an unevaluable rule DROPS the
 * card: the filter silently removes the entire list and the setup reports that
 * nothing qualified. The failure is invisible and points at the wrong thing.
 *
 * Suffixes are read case-insensitively and a bare number is unchanged, so
 * anything already saved keeps meaning what it meant.
 */
const SUFFIX = { k: 1e3, m: 1e6, b: 1e9, t: 1e12 };
function num(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const s = String(v).trim().replace(/[$,\s]/g, '');
  const m = /^(-?\d*\.?\d+)([kmbt])?%?$/i.exec(s);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  return m[2] ? n * SUFFIX[m[2].toLowerCase()] : n;
}

/**
 * One rule against one card.
 *
 * Returns true, false, or null for "cannot tell" — a card whose score has not
 * been computed yet is not a card that failed the score test, and the two must
 * not be collapsed. What to do about null is the caller's decision.
 */
function testRule(rule, row) {
  const field = FIELDS[String(rule?.left || '')];
  if (!field) return null;
  const got = field.path(row);
  const missing = (got === null || got === undefined || got === '');
  // Asked BEFORE the unknown short-circuit, because for these two operators
  // absence IS the answer rather than the absence of one.
  const op0 = rule.operator || rule.op;
  if (op0 === 'empty') return missing;
  if (op0 === 'notempty') return !missing;
  if (missing) return null;

  if (field.kind === 'number') {
    const l = num(got);
    const r = num(rule.right);
    if (l === null || r === null) return null;
    switch (rule.operator || rule.op) {
      case 'above': return l > r;
      case 'below': return l < r;
      case 'egreater': return l >= r;
      case 'eless': return l <= r;
      case 'eq': return l === r;
      case 'ne': return l !== r;
      default: return null;
    }
  }

  // Text is compared case-insensitively: BULLISH, Bullish and bullish are the
  // same answer, and a filter that depended on which one the pipeline happened
  // to write would fail silently the day that changed.
  const l = String(got).toUpperCase();
  const r = String(rule.right ?? '').toUpperCase();
  switch (rule.operator || rule.op) {
    case 'eq': return l === r;
    case 'ne': return l !== r;
    case 'contains': return l.includes(r);
    // "has any of": BULLISH,BEARISH matches a card that is either.
    case 'has': return r.split(',').map(x => x.trim()).filter(Boolean)
      .some(x => l.split(',').map(y => y.trim()).includes(x));
    default: return null;
  }
}

/**
 * Apply a filter to a card list.
 *
 * `unknown` decides what a rule that cannot be evaluated means. It defaults to
 * 'drop', which is the safe reading for a gate: a card whose bias has not been
 * computed has not passed a bias test, and letting it through would quietly
 * turn the filter off for exactly the rows it was meant to catch. 'keep' is
 * offered because the opposite reading is defensible for a filter meant only
 * to remove the obviously wrong.
 */
function apply(rows, filter) {
  if (!filter || !Array.isArray(filter.rules) || !filter.rules.length) {
    return { kept: rows, dropped: [], reasons: {}, filtered: false };
  }
  const logic = String(filter.logic || 'AND').toUpperCase();
  const unknown = filter.unknown === 'keep' ? 'keep' : 'drop';

  const kept = [];
  const dropped = [];
  const reasons = {};

  for (const row of rows) {
    const results = filter.rules.map(rule => {
      const got = testRule(rule, row);
      return got === null ? (unknown === 'keep') : got;
    });
    const pass = logic === 'OR' ? results.some(Boolean) : results.every(Boolean);
    if (pass) { kept.push(row); continue; }
    dropped.push(row);
    // Which rule turned it away, so a filter that removes everything can be
    // understood rather than only noticed.
    const i = results.findIndex(x => !x);
    if (i >= 0) {
      const r = filter.rules[i];
      const key = describeRule(r);
      reasons[key] = (reasons[key] || 0) + 1;
    }
  }
  return { kept, dropped, reasons, filtered: true };
}

/** A rule in words, for the alert and for the setups list. */
function describeRule(rule) {
  const field = FIELDS[String(rule?.left || '')];
  const op = OPERATORS.find(o => o.value === (rule?.operator || rule?.op));
  return `${field ? field.label : rule?.left} ${op ? op.label : (rule?.operator || rule?.op)} ${rule?.right}`;
}

/** The whole filter in words. */
function describe(filter) {
  if (!filter || !Array.isArray(filter.rules) || !filter.rules.length) return null;
  const joiner = String(filter.logic || 'AND').toUpperCase() === 'OR' ? ' OR ' : ' AND ';
  return filter.rules.map(describeRule).join(joiner);
}

/** Reject a malformed filter at the door, with a reason. */
function validate(filter) {
  const errors = [];
  if (!filter) return errors;
  if (!Array.isArray(filter.rules)) return ['rules must be a list'];
  filter.rules.forEach((r, i) => {
    const field = FIELDS[String(r?.left || '')];
    if (!field) {
      errors.push(`rule ${i + 1}: unknown field ${JSON.stringify(r?.left)}`);
    }
    if (!OP_SET.has(String(r?.operator || r?.op || ''))) {
      errors.push(`rule ${i + 1}: unknown operator ${JSON.stringify(r?.operator || r?.op)}`);
    }
    if (r?.right === undefined || r?.right === null || r?.right === '') {
      errors.push(`rule ${i + 1}: needs a value to compare against`);
    } else if (field && field.kind === 'number' && num(r.right) === null) {
      // Refused at the door rather than at 10:00. A value that cannot be read
      // makes its rule unevaluable, and an unevaluable rule drops every card —
      // so the setup would report "nothing qualified" every morning and the
      // typo would never be the obvious suspect.
      errors.push(`rule ${i + 1}: ${field.label} needs a number `
        + `— ${JSON.stringify(r.right)} is not one (50M, 1.5B and 500k are fine)`);
    }
  });
  return errors;
}

module.exports = { FIELDS, OPERATORS, apply, testRule, describe, describeRule, validate };
