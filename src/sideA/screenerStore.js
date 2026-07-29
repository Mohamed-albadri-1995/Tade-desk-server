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
  { value: 'RSI',                         label: 'RSI',                      kind: 'number' },
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
  return errors;
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
    INSERT INTO screeners (key, name, enabled, filters, sort, limit_n, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    key,
    String(def.name).trim(),
    def.enabled === false ? 0 : 1,
    JSON.stringify(def.filters),
    JSON.stringify(def.sort || { sortBy: 'change', sortOrder: 'desc' }),
    Number.isFinite(def.limit) ? def.limit : 50,
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
  };
  const errors = validateDefinition(merged);
  if (errors.length) throw new Error(errors.join('; '));

  db.prepare(`
    UPDATE screeners
       SET name = ?, enabled = ?, filters = ?, sort = ?, limit_n = ?, updated_at = ?
     WHERE id = ?
  `).run(
    String(merged.name).trim(),
    merged.enabled ? 1 : 0,
    JSON.stringify(merged.filters),
    JSON.stringify(merged.sort),
    Number.isFinite(merged.limit) ? merged.limit : 50,
    Date.now(),
    id
  );
  return get(id);
}

function remove(id) {
  return db.prepare('DELETE FROM screeners WHERE id = ?').run(id).changes > 0;
}

module.exports = {
  list, get, create, update, remove,
  validateDefinition, validateFilter, isKnownField,
  OPERATIONS, FIELDS,
};
