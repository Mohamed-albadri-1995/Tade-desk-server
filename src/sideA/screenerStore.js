/*
 * Screener definitions as data.
 *
 * The three original scanners were hardcoded in tvScanner.js, so changing what
 * a tool looks for meant editing and redeploying. They now live in the database
 * as TradingView filter objects — { left, operation, right } — which is exactly
 * the shape TradingView's own screener sends, so a filter built in their UI can
 * be reproduced here field for field.
 *
 * `right` is either a literal (number/string) or the name of another column
 * ('SMA5', 'VWAP', 'EMA50|1'), which is what makes rules like "close above the
 * 20-day average" or "5MA above 9MA" expressible without special-casing.
 *
 * Each tool has its own database, so its screeners are its own.
 */

const db = require('../db');
const { toETTime } = require('../utils/time');

// TradingView's operators. Kept as an explicit list so the builder UI can offer
// them and the API can reject anything else rather than forwarding junk.
const OPERATIONS = [
  { value: 'greater', label: 'is above' },
  { value: 'egreater', label: 'is above or equal' },
  { value: 'less', label: 'is below' },
  { value: 'eless', label: 'is below or equal' },
  { value: 'equal', label: 'equals' },
  { value: 'nequal', label: 'does not equal' },
  { value: 'in_range', label: 'is between' },
  { value: 'not_in_range', label: 'is not between' },
  { value: 'crosses', label: 'crosses' },
  { value: 'crosses_above', label: 'crosses above' },
  { value: 'crosses_below', label: 'crosses below' },
  { value: 'above%', label: 'is above by %' },
  { value: 'below%', label: 'is below by %' },
  { value: 'has', label: 'has' },
  { value: 'has_none_of', label: 'has none of' },
];
const OPS = new Set(OPERATIONS.map(o => o.value));

// Columns offered in the builder. `kind` drives the value input: a numeric
// field gets a number box, a field that can be compared to another series also
// offers the column picker.
const FIELDS = [
  { value: 'close',                       label: 'Price (close)',            kind: 'series' },
  { value: 'open',                        label: 'Open',                     kind: 'series' },
  { value: 'high',                        label: 'Day high',                 kind: 'series' },
  { value: 'low',                         label: 'Day low',                  kind: 'series' },
  { value: 'change',                      label: 'Change %',                 kind: 'number' },
  { value: 'change_from_open',            label: 'Change from open %',       kind: 'number' },
  { value: 'gap',                         label: 'Gap %',                    kind: 'number' },
  { value: 'VWAP',                        label: 'VWAP',                     kind: 'series' },
  { value: 'SMA5',                        label: 'SMA 5',                    kind: 'series' },
  { value: 'SMA20',                       label: 'SMA 20',                   kind: 'series' },
  { value: 'SMA50',                       label: 'SMA 50',                   kind: 'series' },
  { value: 'SMA200',                      label: 'SMA 200',                  kind: 'series' },
  { value: 'EMA9',                        label: 'EMA 9',                    kind: 'series' },
  { value: 'EMA13',                       label: 'EMA 13',                   kind: 'series' },
  { value: 'EMA20',                       label: 'EMA 20',                   kind: 'series' },
  { value: 'EMA50',                       label: 'EMA 50',                   kind: 'series' },
  { value: 'EMA120',                      label: 'EMA 120',                  kind: 'series' },
  { value: 'EMA200',                      label: 'EMA 200',                  kind: 'series' },
  { value: 'High.1M',                     label: '1-month high',             kind: 'series' },
  { value: 'Low.1M',                      label: '1-month low',              kind: 'series' },
  { value: 'High.3M',                     label: '3-month high',             kind: 'series' },
  { value: 'Low.3M',                      label: '3-month low',              kind: 'series' },
  { value: 'High.All',                    label: 'All-time high',            kind: 'series' },
  { value: 'price_52_week_high',          label: '52-week high',             kind: 'series' },
  { value: 'price_52_week_low',           label: '52-week low',              kind: 'series' },
  { value: 'relative_volume_10d_calc',    label: 'Relative volume (10d)',    kind: 'number' },
  { value: 'relative_volume_intraday|5',  label: 'Relative volume (5m)',     kind: 'number' },
  { value: 'volume',                      label: 'Volume',                   kind: 'number' },
  { value: 'average_volume_10d_calc',     label: 'Avg volume (10d)',         kind: 'number' },
  { value: 'average_volume_90d_calc',     label: 'Avg volume (90d)',         kind: 'number' },
  { value: 'premarket_volume',            label: 'Pre-market volume',        kind: 'number' },
  { value: 'premarket_change',            label: 'Pre-market change %',      kind: 'number' },
  { value: 'premarket_gap',               label: 'Pre-market gap %',         kind: 'number' },
  { value: 'market_cap_basic',            label: 'Market cap',               kind: 'number' },
  { value: 'float_shares_outstanding',    label: 'Float shares',             kind: 'number' },
  { value: 'short_percentage_of_float',   label: 'Short % of float',         kind: 'number' },
  { value: 'ATR',                         label: 'ATR',                      kind: 'number' },
  { value: 'Perf.W',                      label: 'Performance week %',       kind: 'number' },
  { value: 'Perf.1M',                     label: 'Performance month %',      kind: 'number' },
  { value: 'Perf.3M',                     label: 'Performance 3-month %',    kind: 'number' },
  { value: 'Perf.6M',                     label: 'Performance 6-month %',    kind: 'number' },
  { value: 'Perf.Y',                      label: 'Performance 1-year %',     kind: 'number' },
  { value: 'RSI',                         label: 'RSI',                      kind: 'number' },
  // Fundamentals — added for CANSLIM. TradingView ignores filters on column
  // names it does not recognise (ignore_unknown_fields), so a typo here would
  // not error, it would silently widen the screener. Verify with
  // `node scripts/verify-tv-fields.js` on a machine that can reach TradingView.
  { value: 'earnings_per_share_diluted_yoy_growth_fq',  label: 'EPS growth, latest quarter YoY %', kind: 'number' },
  { value: 'earnings_per_share_diluted_yoy_growth_fy',  label: 'EPS growth, last year YoY %',      kind: 'number' },
  { value: 'earnings_per_share_diluted_yoy_growth_ttm', label: 'EPS growth, trailing 12m YoY %',   kind: 'number' },
  { value: 'total_revenue_yoy_growth_fq',               label: 'Revenue growth, latest quarter YoY %', kind: 'number' },
  { value: 'total_revenue_yoy_growth_ttm',              label: 'Revenue growth, trailing 12m YoY %',   kind: 'number' },
  { value: 'return_on_equity',                          label: 'Return on equity %',               kind: 'number' },
  { value: 'total_shares_outstanding_fundamental',      label: 'Shares outstanding',               kind: 'number' },
  { value: 'sector',                      label: 'Sector',                   kind: 'string' },
  { value: 'exchange',                    label: 'Exchange',                 kind: 'string' },
];
const FIELD_VALUES = new Set(FIELDS.map(f => f.value));

// A timeframe suffix ('|1' daily, '|1W' weekly, '|5' 5-minute …) may be
// appended to any column, so validation strips it before checking the name.
function baseField(name) {
  return String(name).split('|')[0];
}

function isKnownField(name) {
  return FIELD_VALUES.has(String(name)) || FIELD_VALUES.has(baseField(name));
}

/**
 * Validate one filter row. Returns an error string, or null when valid.
 * Kept strict: a malformed rule sent to TradingView returns an empty result
 * set, which is indistinguishable from "nothing matched today".
 */
function validateFilter(f, index) {
  const at = `filter ${index + 1}`;
  if (!f || typeof f !== 'object') return `${at}: not an object`;
  if (!f.left || typeof f.left !== 'string') return `${at}: missing field`;
  if (!isKnownField(f.left)) return `${at}: unknown field "${f.left}"`;
  if (!OPS.has(f.operation)) return `${at}: unknown operation "${f.operation}"`;
  if (f.right === undefined || f.right === null || f.right === '') {
    return `${at}: missing value`;
  }
  if (['in_range', 'not_in_range'].includes(f.operation)) {
    if (!Array.isArray(f.right) || f.right.length !== 2) {
      return `${at}: "${f.operation}" needs two values`;
    }
  }
  return null;
}

// A window is "HH:MM" in Eastern. Both ends must be set, or neither.
const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

function validateWindow(def) {
  const from = def.runFrom, to = def.runTo;
  const hasFrom = from !== undefined && from !== null && from !== '';
  const hasTo = to !== undefined && to !== null && to !== '';
  if (!hasFrom && !hasTo) return null;                 // always on
  if (hasFrom !== hasTo) return 'a run window needs both a start and an end time';
  if (!HHMM.test(from)) return `invalid start time "${from}" (use HH:MM)`;
  if (!HHMM.test(to)) return `invalid end time "${to}" (use HH:MM)`;
  if (from >= to) return 'the run window must start before it ends';
  return null;
}

/**
 * Is this screener due to run at the given moment?
 *
 * A screener with no window runs on every scan. One with a window runs only
 * inside it — so a pre-market screener does not keep firing at 11am and fill
 * its own dataset with rows that do not belong to the setup it is testing.
 * Times are compared as "HH:MM" strings in Eastern, which sorts correctly and
 * sidesteps timezone arithmetic; no trading window crosses midnight.
 */
function isActiveAt(screener, ts = Date.now()) {
  if (!screener.runFrom || !screener.runTo) return true;
  const now = toETTime(ts);
  return now >= screener.runFrom && now < screener.runTo;
}

/**
 * Is it worth OPENING this screener right now?
 *
 * Different question from isActiveAt, and the difference is the whole reason
 * this exists. The pre-market gap screener is active from 04:00 and has nothing
 * to show until the pre-market has volume in it; the overextended screener is
 * active from 10:00 but is still describing yesterday's RSI for the first
 * fifteen minutes. Showing the scan window as though it were an invitation is
 * how you end up opening a tool at 04:30 and finding an empty screen.
 *
 * A screener with no check window falls back to its run window, and one with
 * neither is always worth a look — which is right for T1, whose screeners run
 * all day by design.
 */
function isWorthCheckingAt(screener, ts = Date.now()) {
  const from = screener.checkFrom || screener.runFrom;
  const to = screener.checkTo || screener.runTo;
  if (!from || !to) return true;
  const now = toETTime(ts);
  return now >= from && now < to;
}

/**
 * The tool's overall check window: earliest start, latest end, across its
 * enabled screeners. A tool is worth opening if ANY of its screeners is.
 */
function checkWindow(screeners) {
  const on = (screeners || []).filter(s => s.enabled !== false);
  if (!on.length) return null;
  const froms = on.map(s => s.checkFrom || s.runFrom).filter(Boolean);
  const tos = on.map(s => s.checkTo || s.runTo).filter(Boolean);
  // A screener with no window at all runs — and is worth checking — all day,
  // so it widens the tool's window to the whole session rather than narrowing it.
  if (froms.length < on.length || tos.length < on.length) return { from: '04:00', to: '16:00' };
  return { from: froms.sort()[0], to: tos.sort().slice(-1)[0] };
}

function validateDefinition(def) {
  const errors = [];
  if (!def.name || !String(def.name).trim()) errors.push('name is required');
  if (!Array.isArray(def.filters) || def.filters.length === 0) {
    errors.push('at least one filter is required');
  } else {
    def.filters.forEach((f, i) => {
      const e = validateFilter(f, i);
      if (e) errors.push(e);
    });
  }
  if (def.sort && def.sort.sortBy && !isKnownField(def.sort.sortBy)) {
    errors.push(`unknown sort field "${def.sort.sortBy}"`);
  }
  const w = validateWindow(def);
  if (w) errors.push(w);
  return errors;
}

// ── mirroring ──────────────────────────────────────────────────────────────

// Flipping a screener is not simply inverting every operator. A rule is either
// DIRECTIONAL — it says which way the stock is going, and its mirror is the
// opposite — or a QUALITY GUARD ("price above $1", "volume above 2M"), which
// exists to exclude junk and must survive the flip untouched. Inverting a guard
// would produce the mirror of the filter rather than the mirror of the setup:
// "volume below 2M" is illiquid noise, not the bearish counterpart.
const OPPOSITE_OP = {
  greater: 'less', less: 'greater',
  egreater: 'eless', eless: 'egreater',
  crosses_above: 'crosses_below', crosses_below: 'crosses_above',
  'above%': 'below%', 'below%': 'above%',
};

// Fields whose sign carries direction. A numeric threshold on one of these
// flips sign as well as operator: "change above 5" mirrors to "change below -5".
const DIRECTIONAL_FIELDS = new Set([
  'change', 'change_from_open', 'gap', 'premarket_change', 'premarket_gap',
  'Perf.W', 'Perf.1M', 'Perf.3M', 'Perf.Y',
]);

// Some fields come as a high/low pair, and their mirror is the counterpart —
// not the same field with the operator flipped. "close above the 1-month high"
// is a breakout; inverting only the operator gives "close below the 1-month
// high", which is true of nearly every stock and screens for nothing. The
// bearish twin is "close below the 1-month LOW".
const FIELD_MIRROR = {
  'High.1M': 'Low.1M', 'Low.1M': 'High.1M',
  'High.3M': 'Low.3M', 'Low.3M': 'High.3M',
  'price_52_week_high': 'price_52_week_low',
  'price_52_week_low': 'price_52_week_high',
  'high': 'low', 'low': 'high',
};

// Bounded oscillators mirror by reflection, not by sign. RSI runs 0–100 with 50
// in the middle, so the twin of "RSI above 70" is "RSI below 30" — not "RSI
// below 70" (true of most of the market) and not "RSI above -70" (impossible).
// Treating RSI as a plain quality guard left the oversold screener asking for
// stocks that are overbought AND under their 20-EMA, which is close to nothing.
const REFLECTED_FIELDS = { RSI: 100 };

// Keep any timeframe suffix when swapping to the counterpart field.
function mirrorFieldName(name) {
  const [base, ...rest] = String(name).split('|');
  const flipped = FIELD_MIRROR[base];
  if (!flipped) return name;
  return rest.length ? `${flipped}|${rest.join('|')}` : flipped;
}

function mirrorFilter(f) {
  const opposite = OPPOSITE_OP[f.operation];
  if (!opposite) return { ...f };            // equality, has, in_range … leave alone

  const rightIsField = typeof f.right === 'string' && isNaN(f.right);
  if (rightIsField) {
    // Comparing two series: flip the operator, and swap either side to its
    // counterpart when it has one.
    return {
      ...f,
      left: mirrorFieldName(f.left),
      operation: opposite,
      right: mirrorFieldName(f.right),
    };
  }

  const base = baseField(f.left);
  if (DIRECTIONAL_FIELDS.has(base)) {
    const n = Number(f.right);
    return { ...f, operation: opposite, right: Number.isFinite(n) ? -n : f.right };
  }

  if (REFLECTED_FIELDS[base] !== undefined) {
    const span = REFLECTED_FIELDS[base];
    if (Array.isArray(f.right)) {
      const [lo, hi] = f.right.map(Number);
      return { ...f, operation: opposite, right: [span - hi, span - lo] };
    }
    const n = Number(f.right);
    return { ...f, operation: opposite, right: Number.isFinite(n) ? span - n : f.right };
  }

  // A numeric threshold on a non-directional field is a quality guard.
  return { ...f };
}

/**
 * Build the mirror of a screener definition — the same structural setup facing
 * the other way — leaving its quality guards in place.
 */
function mirrorDefinition(def) {
  const filters = (def.filters || []).map(mirrorFilter);
  const sort = { ...(def.sort || { sortBy: 'change', sortOrder: 'desc' }) };
  // Sorting on a directional field should also flip, so the mirror's strongest
  // candidates sit at the top of its list rather than the bottom.
  if (DIRECTIONAL_FIELDS.has(baseField(sort.sortBy))) {
    sort.sortOrder = sort.sortOrder === 'desc' ? 'asc' : 'desc';
  }
  return {
    name: `${def.name} (mirror)`,
    filters,
    sort,
    limit: def.limit,
    enabled: def.enabled !== false,
    // the twin must run in the same window, or the pair is not comparable
    runFrom: def.runFrom || null,
    runTo: def.runTo || null,
    // …and it is worth reading at the same hours, for the same reason: the
    // mirror is the other side of one experiment, not a screener of its own.
    checkFrom: def.checkFrom || null,
    checkTo: def.checkTo || null,
  };
}

// ── storage ────────────────────────────────────────────────────────────────

function rowToScreener(row) {
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    enabled: !!row.enabled,
    filters: JSON.parse(row.filters),
    sort: row.sort ? JSON.parse(row.sort) : { sortBy: 'change', sortOrder: 'desc' },
    limit: row.limit_n,
    runFrom: row.run_from || null,
    runTo: row.run_to || null,
    // When to LOOK. A screener can be scanning for hours before it has
    // anything worth opening the tool for — the pre-market gap screener runs
    // from 04:00 and has nothing to show until the pre-market has volume in it.
    checkFrom: row.check_from || null,
    checkTo: row.check_to || null,
    // The screener this one mirrors, by name. Survives renaming either side,
    // which a "(mirror)" suffix does not.
    mirrorOf: row.mirror_of || null,
    // A screener that maintains a LIST rather than proposing trades. Its
    // matches never reach r0, and the tradability floor does not apply — see
    // canslim-universe, where "is this a growth company" has nothing to do
    // with whether you could day-trade it today.
    labelOnly: !!row.label_only,
    updatedAt: row.updated_at,
  };
}

function list({ enabledOnly = false } = {}) {
  const sql = enabledOnly
    ? 'SELECT * FROM screeners WHERE enabled = 1 ORDER BY name'
    : 'SELECT * FROM screeners ORDER BY name';
  return db.prepare(sql).all().map(rowToScreener);
}

function get(id) {
  const row = db.prepare('SELECT * FROM screeners WHERE id = ?').get(id);
  return row ? rowToScreener(row) : null;
}

function slugify(name) {
  return String(name).trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
    || 'screener';
}

function create(def) {
  const errors = validateDefinition(def);
  if (errors.length) throw new Error(errors.join('; '));

  // `key` is what lands in screenerKeys on the card, so it must be stable and
  // unique within the tool.
  let key = def.key ? slugify(def.key) : slugify(def.name);
  const taken = new Set(db.prepare('SELECT key FROM screeners').all().map(r => r.key));
  if (taken.has(key)) {
    let n = 2;
    while (taken.has(`${key}-${n}`)) n++;
    key = `${key}-${n}`;
  }

  const info = db.prepare(`
    INSERT INTO screeners (key, name, enabled, filters, sort, limit_n, run_from, run_to, check_from, check_to, mirror_of, label_only, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    key,
    String(def.name).trim(),
    def.enabled === false ? 0 : 1,
    JSON.stringify(def.filters),
    JSON.stringify(def.sort || { sortBy: 'change', sortOrder: 'desc' }),
    Number.isFinite(def.limit) ? def.limit : 50,
    def.runFrom || null,
    def.runTo || null,
    def.checkFrom || null,
    def.checkTo || null,
    def.mirrorOf || null,
    def.labelOnly ? 1 : 0,
    Date.now()
  );
  return get(info.lastInsertRowid);
}

function update(id, def) {
  const existing = get(id);
  if (!existing) throw new Error(`Screener ${id} not found`);

  const merged = {
    name: def.name !== undefined ? def.name : existing.name,
    filters: def.filters !== undefined ? def.filters : existing.filters,
    sort: def.sort !== undefined ? def.sort : existing.sort,
    enabled: def.enabled !== undefined ? def.enabled : existing.enabled,
    limit: def.limit !== undefined ? def.limit : existing.limit,
    runFrom: def.runFrom !== undefined ? def.runFrom : existing.runFrom,
    runTo: def.runTo !== undefined ? def.runTo : existing.runTo,
    checkFrom: def.checkFrom !== undefined ? def.checkFrom : existing.checkFrom,
    checkTo: def.checkTo !== undefined ? def.checkTo : existing.checkTo,
    mirrorOf: def.mirrorOf !== undefined ? def.mirrorOf : existing.mirrorOf,
    labelOnly: def.labelOnly !== undefined ? def.labelOnly : existing.labelOnly,
  };
  const errors = validateDefinition(merged);
  if (errors.length) throw new Error(errors.join('; '));

  db.prepare(`
    UPDATE screeners
       SET name = ?, enabled = ?, filters = ?, sort = ?, limit_n = ?,
           run_from = ?, run_to = ?, check_from = ?, check_to = ?,
           mirror_of = ?, label_only = ?, updated_at = ?
     WHERE id = ?
  `).run(
    String(merged.name).trim(),
    merged.enabled ? 1 : 0,
    JSON.stringify(merged.filters),
    JSON.stringify(merged.sort),
    Number.isFinite(merged.limit) ? merged.limit : 50,
    merged.runFrom || null,
    merged.runTo || null,
    merged.checkFrom || null,
    merged.checkTo || null,
    merged.mirrorOf || null,
    merged.labelOnly ? 1 : 0,
    Date.now(),
    id
  );
  return get(id);
}

function remove(id) {
  return db.prepare('DELETE FROM screeners WHERE id = ?').run(id).changes > 0;
}

/** Create and store the mirror of an existing screener. */
function createMirror(id) {
  const src = get(id);
  if (!src) throw new Error(`Screener ${id} not found`);
  // Record what it mirrors, so the pair survives either one being renamed.
  return create({ ...mirrorDefinition(src), mirrorOf: src.name });
}

module.exports = {
  list, get, create, update, remove, createMirror, mirrorDefinition, isActiveAt,
  isWorthCheckingAt, checkWindow,
  validateDefinition, validateFilter, isKnownField, slugify,
  OPERATIONS, FIELDS,
};
