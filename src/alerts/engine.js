/*
 * Alert rules, evaluated against the cards the screener already has.
 *
 * "Break pre-market high" needs no new data source. Every card in r0 carries
 * price, pmHigh, pmLow, vwap, the moving averages, prevClose and the day's
 * range, and the refresh re-quotes all of them every five minutes. So the
 * simple half of the alerting the trader asked for is a comparison between two
 * numbers that are already on the row — no feed, no keys, no new failure mode.
 *
 * What that buys is bounded and worth stating: five-minute granularity. A break
 * that happens at 10:01 is seen at 10:05, and one that breaks and fails inside
 * the same five minutes is never seen at all. That is the honest limit of
 * alerting from snapshots, and it is why the strategy alerts — which need
 * one-minute bars — are a separate route through qp rather than an extension of
 * this one.
 *
 * A RULE FIRES ON A TRANSITION, NOT ON A STATE. "Broke the pre-market high"
 * means it crossed, not that it happens to be above. Firing on the state would
 * re-alert every five minutes for the rest of the day, which is not an alert,
 * it is a status bar — and it is the failure that makes people switch alerts
 * off. So the previous side is remembered per (rule, ticker, day) and only the
 * change is reported.
 *
 * MISSING DATA NEVER FIRES. A null pmHigh is not "price is above it"; it is a
 * question nobody can answer. An alert that fires because a field was empty is
 * worse than a missed one, because it teaches you to ignore the next one.
 */

// What a rule may compare. Everything here is on the r0 row and refreshed by
// the same scan, so the two sides of a comparison are always from one instant —
// mixing a fresh price against a stale level would invent crossings.
const FIELDS = [
  'price', 'pmHigh', 'pmLow', 'vwap', 'open', 'prevClose',
  'ema9', 'ema13', 'ema20', 'ema50', 'sma5',
  'dayHigh', 'dayLow', 'monthHigh', 'monthLow',
  'atr', 'adrPct', 'rvol', 'gapPct', 'pmAdrRatio',
  'monthRangePos', 'weekRangePos', 'quarterRangePos', 'yearRangePos',
];
const FIELD_SET = new Set(FIELDS);

const OPERATORS = [
  { value: 'crosses_above', label: 'crosses above', kind: 'cross' },
  { value: 'crosses_below', label: 'crosses below', kind: 'cross' },
  { value: 'above', label: 'goes above', kind: 'state' },
  { value: 'below', label: 'goes below', kind: 'state' },
];
const OP_KIND = new Map(OPERATORS.map(o => [o.value, o.kind]));

const num = v => (v === null || v === undefined || v === '' || Number.isNaN(Number(v))
  ? null : Number(v));

/** The numeric value of one side of a comparison, or null if unknowable. */
function operand(side, stock) {
  if (typeof side === 'number') return Number.isFinite(side) ? side : null;
  const s = String(side ?? '').trim();
  if (s === '') return null;
  if (FIELD_SET.has(s)) return num(stock?.[s]);
  // A bare number written as text — the UI sends form values as strings.
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/**
 * Which side of the comparison the row is on right now.
 * 'above' | 'below' | null when either side is unknown.
 */
function sideNow(rule, stock) {
  const l = operand(rule?.left, stock);
  const r = operand(rule?.right, stock);
  if (l === null || r === null) return null;
  return l >= r ? 'above' : 'below';
}

/** Human-readable, for the alert itself — "price crossed above pmHigh (10.50)". */
function describe(rule, stock) {
  const r = operand(rule?.right, stock);
  const op = OPERATORS.find(o => o.value === rule?.operator);
  const right = typeof rule?.right === 'string' && FIELD_SET.has(rule.right)
    ? `${rule.right}${r === null ? '' : ` (${r})`}`
    : String(rule?.right ?? '');
  return `${rule?.left} ${op ? op.label : rule?.operator} ${right}`;
}

/** Does this rule apply to this tool and this ticker? */
function applies(rule, toolId, ticker) {
  const tools = rule?.scope?.tools || [];
  const tickers = rule?.scope?.tickers || [];
  // Empty means "no restriction". A rule scoped to nothing is a rule for
  // everything, which is what an empty filter means everywhere else here.
  if (tools.length && !tools.includes(toolId)) return false;
  if (tickers.length && !tickers.includes(String(ticker || '').toUpperCase())) return false;
  return true;
}

/**
 * Evaluate every rule against every row, once.
 *
 * `prev` is the remembered side per key from the previous pass; it is READ and
 * WRITTEN here, so the caller owns its lifetime (per day) and this stays a pure
 * function of its inputs.
 *
 * Returns the fires — only transitions, never states that were already true.
 */
function evaluate({ rules, rows, toolId, prev, now = Date.now(), date }) {
  const fires = [];
  const seen = new Set();

  for (const row of rows || []) {
    const ticker = String(row?.ticker || '').toUpperCase();
    if (!ticker) continue;
    const stock = row?.stock || {};

    for (const rule of rules || []) {
      if (rule?.enabled === false) continue;
      if (!applies(rule, toolId, ticker)) continue;

      const key = `${rule.id}|${ticker}`;
      seen.add(key);
      const side = sideNow(rule, stock);
      const before = prev[key];
      // Remember first, so a rule whose data is missing this pass does not
      // leave a stale side behind that fakes a crossing when it comes back.
      prev[key] = side;

      if (side === null) continue;
      // The FIRST time a stock is seen, there is no previous side and therefore
      // no crossing. Treating "no history" as a cross would fire on every name
      // the moment a scan starts, or the moment the process restarts.
      if (before === undefined) continue;
      if (before === side) continue;

      const kind = OP_KIND.get(rule.operator);
      const wanted = (rule.operator === 'crosses_above' || rule.operator === 'above')
        ? 'above' : 'below';
      if (side !== wanted) continue;
      // 'above'/'below' and 'crosses_above'/'crosses_below' behave identically
      // on a transition. They are kept apart because they read differently in
      // the list, and because a state operator is the natural place to hang a
      // "still true" digest later without changing what fires today.
      if (kind !== 'cross' && kind !== 'state') continue;

      fires.push({
        ruleId: rule.id,
        rule: rule.name || describe(rule, stock),
        ticker,
        toolId,
        date,
        at: now,
        detail: describe(rule, stock),
        price: num(stock.price),
      });
    }
  }

  // Forget rows that are no longer in the registry, so a stock that leaves and
  // comes back later is treated as newly seen rather than compared against a
  // side from hours ago.
  for (const key of Object.keys(prev)) if (!seen.has(key)) delete prev[key];

  return fires;
}

/** Reject a malformed rule at the door, with a reason. */
function validate(rule) {
  const errors = [];
  const name = String(rule?.name || '').trim();
  if (!name) errors.push('name is required');
  if (!FIELD_SET.has(String(rule?.left || ''))) {
    errors.push(`left must be one of: ${FIELDS.join(', ')}`);
  }
  if (!OP_KIND.has(String(rule?.operator || ''))) {
    errors.push(`operator must be one of: ${OPERATORS.map(o => o.value).join(', ')}`);
  }
  const right = rule?.right;
  const rightOk = (typeof right === 'number' && Number.isFinite(right))
    || (typeof right === 'string' && (FIELD_SET.has(right) || Number.isFinite(Number(right))));
  if (!rightOk) errors.push('right must be a number or a known field');
  for (const t of rule?.scope?.tickers || []) {
    if (!/^[A-Z0-9.\-]{1,10}$/i.test(String(t))) errors.push(`not a ticker: ${t}`);
  }
  return errors;
}

module.exports = { FIELDS, OPERATORS, evaluate, validate, applies, sideNow, describe, operand };
