/**
 * Check Library + Condition Evaluator
 *
 * Three flavours of checks fill a trade card:
 *
 *   1. MANDATORY   — extracted from the indicator script's debug() output.
 *                    Cannot be edited; changes require updating the script.
 *                    Always aligned on a fire (that's what "fire" means).
 *
 *   2. DEFAULT     — user-managed library. Every setup auto-inherits ALL
 *                    default checks. Editing a default in the library
 *                    propagates to every setup (they aren't stored per
 *                    setup, they're computed at fire time from the library).
 *
 *   3. ADDITIONAL  — user-managed library. Per-setup, the user picks
 *                    which additional checks to attach. Stored as
 *                    (setup_id, check_id) rows.
 *
 * Condition grammar (JSON):
 *   Value nodes:
 *     { "field":   "ema9"        }   ← indicator context
 *     { "ctx":     "secBias"     }   ← scanner context field (from r0)
 *     { "literal": 100           }
 *     { "slope":   "ema9", "bars": 5 } ← slope of series over last N bars
 *
 *   Operators:
 *     { "op": "gt|ge|lt|le|eq|ne", "left": …, "right": … }
 *     { "op": "and|or",            "operands": [ …, … ] }
 *     { "op": "not",               "operand": … }
 *     { "op": "in",                "left": …, "list": [ …, … ] }
 *
 * Available field names (indicators): close, open, high, low, volume,
 *   vwap, ema9, ema13, ema20, ema50, sma5, sma20, pmHigh, pmLow,
 *   prevClose, rvol, atr, dayHigh, dayLow.
 *
 * Available ctx names (scanner): regime, regimeLabel, longTerm, midTerm,
 *   shortTerm, secBias, secScore, secHot, sector, industry, themes,
 *   broadResolved, _score, screenerKeys, inShortlist.
 */

const { v4: uuidv4 } = require('uuid');
const db = require('../db');

// ─── Schema ──────────────────────────────────────────────────────────────────

db.exec(`
  CREATE TABLE IF NOT EXISTS check_library (
    id TEXT PRIMARY KEY,
    check_key TEXT NOT NULL UNIQUE,
    label TEXT NOT NULL,
    category TEXT NOT NULL CHECK (category IN ('default', 'additional')),
    section TEXT,
    description TEXT,
    condition TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS setup_check_assignments (
    setup_id TEXT NOT NULL,
    check_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (setup_id, check_id)
  );

  CREATE INDEX IF NOT EXISTS check_library_category_idx ON check_library(category, enabled);
`);

// ─── Seeds ───────────────────────────────────────────────────────────────────
// A small handful of common conditions so the library isn't empty on
// first run. These are TYPICAL defaults for the ma13bounce style setup;
// the user can edit / delete / recategorise them freely.

const SEED_CHECKS = [
  {
    check_key: 'ema9_above_vwap',
    label:     '9 EMA above VWAP',
    category:  'default',
    section:   'trend',
    description: 'Short-term trend confirms with VWAP.',
    condition: { op: 'gt', left: { field: 'ema9' }, right: { field: 'vwap' } },
  },
  {
    check_key: 'ema_stack_bullish',
    label:     'EMA stack bullish (9 > 20)',
    category:  'default',
    section:   'trend',
    description: 'Fast EMAs stacked in the intended direction.',
    condition: { op: 'gt', left: { field: 'ema9' }, right: { field: 'ema20' } },
  },
  {
    check_key: 'rvol_above_2',
    label:     'RVOL > 2×',
    category:  'default',
    section:   'volume',
    description: 'Current-minute volume is at least 2× the 10-day baseline for this minute.',
    condition: { op: 'gt', left: { field: 'rvol' }, right: { literal: 2 } },
  },
  {
    check_key: 'ema13_sloping_up',
    label:     '13 EMA sloping up',
    category:  'additional',
    section:   'momentum',
    description: 'EMA13 has a positive slope over the last 5 bars.',
    condition: { op: 'gt', left: { slope: 'ema13', bars: 5 }, right: { literal: 0 } },
  },
  {
    check_key: 'vwap_sloping_up',
    label:     'VWAP sloping up',
    category:  'additional',
    section:   'momentum',
    description: 'VWAP has a positive slope over the last 5 bars.',
    condition: { op: 'gt', left: { slope: 'vwap', bars: 5 }, right: { literal: 0 } },
  },
  {
    check_key: 'sector_bullish',
    label:     'Sector bias BULLISH',
    category:  'additional',
    section:   'context',
    description: 'Scanner-side sector bias is BULLISH at signal time.',
    condition: { op: 'eq', left: { ctx: 'secBias' }, right: { literal: 'BULLISH' } },
  },
  {
    check_key: 'sec_hot',
    label:     'Sector hot',
    category:  'additional',
    section:   'context',
    description: 'Scanner marks the sector as hot right now.',
    condition: { op: 'eq', left: { ctx: 'secHot' }, right: { literal: true } },
  },
  {
    check_key: 'score_at_entry_70',
    label:     'Scanner score ≥ 70 at entry',
    category:  'additional',
    section:   'context',
    description: 'Scanner _score at the moment of signal fire is ≥ 70.',
    condition: { op: 'ge', left: { ctx: '_score' }, right: { literal: 70 } },
  },
];

function seedDefaults() {
  const existing = db.prepare('SELECT COUNT(*) AS n FROM check_library').get().n;
  if (existing > 0) return;
  const now = Date.now();
  const stmt = db.prepare(`
    INSERT INTO check_library
      (id, check_key, label, category, section, description, condition, enabled, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
  `);
  const txn = db.transaction(() => {
    for (const c of SEED_CHECKS) {
      stmt.run(uuidv4(), c.check_key, c.label, c.category, c.section, c.description, JSON.stringify(c.condition), now, now);
    }
  });
  txn();
}
seedDefaults();

// ─── Library CRUD ────────────────────────────────────────────────────────────

function _row(r) {
  if (!r) return null;
  return {
    id:          r.id,
    key:         r.check_key,
    label:       r.label,
    category:    r.category,
    section:     r.section,
    description: r.description,
    condition:   safeParse(r.condition, {}),
    enabled:     r.enabled === 1,
    createdAt:   r.created_at,
    updatedAt:   r.updated_at,
  };
}

function safeParse(s, fallback) {
  try { return JSON.parse(s); } catch { return fallback; }
}

function listChecks(opts = {}) {
  const params = [];
  let where = '1=1';
  if (opts.category)   { where += ' AND category = ?'; params.push(opts.category); }
  if (opts.enabledOnly){ where += ' AND enabled = 1'; }
  return db.prepare(`SELECT * FROM check_library WHERE ${where} ORDER BY section, label`).all(...params).map(_row);
}

function getCheck(id) {
  return _row(db.prepare('SELECT * FROM check_library WHERE id = ?').get(id));
}

function createCheck({ check_key, label, category, section = null, description = null, condition, enabled = true }) {
  if (!check_key) throw new Error('check_key required');
  if (!label)     throw new Error('label required');
  if (!['default', 'additional'].includes(category)) throw new Error("category must be 'default' or 'additional'");
  if (!condition || typeof condition !== 'object') throw new Error('condition (JSON object) required');
  const validation = validateCondition(condition);
  if (!validation.ok) throw new Error(`condition invalid: ${validation.error}`);
  const id = uuidv4();
  const now = Date.now();
  db.prepare(`
    INSERT INTO check_library
      (id, check_key, label, category, section, description, condition, enabled, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, check_key, label, category, section, description, JSON.stringify(condition), enabled ? 1 : 0, now, now);
  return getCheck(id);
}

function updateCheck(id, patch) {
  const cur = db.prepare('SELECT * FROM check_library WHERE id = ?').get(id);
  if (!cur) return null;
  const next = {
    check_key:   patch.check_key   ?? cur.check_key,
    label:       patch.label       ?? cur.label,
    category:    patch.category    ?? cur.category,
    section:     patch.section     !== undefined ? patch.section : cur.section,
    description: patch.description !== undefined ? patch.description : cur.description,
    condition:   patch.condition   != null ? JSON.stringify(patch.condition) : cur.condition,
    enabled:     patch.enabled     != null ? (patch.enabled ? 1 : 0) : cur.enabled,
  };
  if (!['default', 'additional'].includes(next.category)) throw new Error("category must be 'default' or 'additional'");
  if (patch.condition != null) {
    const v = validateCondition(patch.condition);
    if (!v.ok) throw new Error(`condition invalid: ${v.error}`);
  }
  db.prepare(`
    UPDATE check_library
       SET check_key=?, label=?, category=?, section=?, description=?, condition=?, enabled=?, updated_at=?
     WHERE id=?
  `).run(next.check_key, next.label, next.category, next.section, next.description, next.condition, next.enabled, Date.now(), id);
  return getCheck(id);
}

function removeCheck(id) {
  // Cascade: also drop any per-setup assignments of this check.
  const txn = db.transaction(() => {
    db.prepare('DELETE FROM setup_check_assignments WHERE check_id = ?').run(id);
    db.prepare('DELETE FROM check_library WHERE id = ?').run(id);
  });
  txn();
}

// ─── Setup ↔ additional-check assignments ────────────────────────────────────

function assignmentsForSetup(setupId) {
  return db.prepare(`
    SELECT cl.*
      FROM setup_check_assignments a
      JOIN check_library cl ON cl.id = a.check_id
     WHERE a.setup_id = ?
     ORDER BY cl.section, cl.label
  `).all(setupId).map(_row);
}

function setAssignmentsForSetup(setupId, checkIds) {
  const now = Date.now();
  const txn = db.transaction(() => {
    db.prepare('DELETE FROM setup_check_assignments WHERE setup_id = ?').run(setupId);
    const ins = db.prepare('INSERT INTO setup_check_assignments (setup_id, check_id, created_at) VALUES (?, ?, ?)');
    for (const cid of checkIds) ins.run(setupId, cid, now);
  });
  txn();
  return assignmentsForSetup(setupId);
}

// ─── Condition validation + evaluation ───────────────────────────────────────

const COMPARISON_OPS = new Set(['gt', 'ge', 'lt', 'le', 'eq', 'ne', 'in']);
const COMBINATOR_OPS = new Set(['and', 'or', 'not']);
const VALUE_KINDS    = new Set(['field', 'ctx', 'literal', 'slope']);

function validateCondition(node, path = '$') {
  if (!node || typeof node !== 'object') return { ok: false, error: `${path}: expected object` };
  if (node.op) {
    if (COMBINATOR_OPS.has(node.op)) {
      if (node.op === 'not') {
        if (!node.operand) return { ok: false, error: `${path}.not.operand missing` };
        return validateCondition(node.operand, `${path}.operand`);
      }
      if (!Array.isArray(node.operands) || node.operands.length < 1) {
        return { ok: false, error: `${path}.${node.op}.operands must be a non-empty array` };
      }
      for (let i = 0; i < node.operands.length; i++) {
        const v = validateCondition(node.operands[i], `${path}.operands[${i}]`);
        if (!v.ok) return v;
      }
      return { ok: true };
    }
    if (COMPARISON_OPS.has(node.op)) {
      if (!node.left) return { ok: false, error: `${path}.left required` };
      const l = validateValue(node.left, `${path}.left`);
      if (!l.ok) return l;
      if (node.op === 'in') {
        if (!Array.isArray(node.list)) return { ok: false, error: `${path}.list must be an array for 'in'` };
      } else {
        if (!node.right) return { ok: false, error: `${path}.right required` };
        const r = validateValue(node.right, `${path}.right`);
        if (!r.ok) return r;
      }
      return { ok: true };
    }
    return { ok: false, error: `${path}.op '${node.op}' not recognised` };
  }
  // Legacy shorthand: a bare value node counts as truthy-check
  return validateValue(node, path);
}

function validateValue(node, path) {
  if (!node || typeof node !== 'object') return { ok: false, error: `${path}: expected object` };
  const kinds = Object.keys(node).filter(k => VALUE_KINDS.has(k));
  if (kinds.length === 0) return { ok: false, error: `${path}: must have one of ${[...VALUE_KINDS].join('/')}` };
  if (node.slope && node.bars == null) return { ok: false, error: `${path}.slope requires 'bars' (int ≥ 2)` };
  return { ok: true };
}

// ── Runtime helpers ──

/**
 * Build an indicator snapshot for the CURRENT (latest) bar in the buffer.
 * Called by the router at fire time.
 */
function buildIndicatorContext(bars, extras = {}) {
  const last = bars?.[bars.length - 1] || {};
  const ind = {
    close:  last.c,
    open:   last.o,
    high:   last.h,
    low:    last.l,
    volume: last.v,
  };
  // Optional inputs the caller can enrich with values already computed by
  // the indicator engine (so we don't recompute EMAs here).
  if (extras && typeof extras === 'object') {
    Object.assign(ind, extras);
  }
  return { bars, ind };
}

function fieldValue(ctx, name) {
  return ctx.ind?.[name] ?? null;
}

function ctxValue(ctx, name) {
  return ctx.scanner?.[name] ?? null;
}

function slopeValue(ctx, seriesName, barCount) {
  // Slope = (last value - value N-1 bars ago) / (bar count - 1).
  // For an EMA-style series we don't keep history per bar, so we
  // approximate slope by resampling: use a rolling window of the last
  // barCount bar closes IF the series name is a raw price field, and use
  // a stored history array if the indicator engine provided one.
  const series = ctx.history?.[seriesName];
  if (Array.isArray(series) && series.length >= barCount) {
    const a = series[series.length - barCount];
    const b = series[series.length - 1];
    if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
    return (b - a) / (barCount - 1);
  }
  // Fallback for raw bar fields (close, open, high, low, volume, vwap)
  const bars = ctx.bars || [];
  if (bars.length < barCount) return null;
  const at = i => {
    const bar = bars[bars.length - barCount + i];
    if (!bar) return null;
    if (seriesName === 'close')  return bar.c;
    if (seriesName === 'open')   return bar.o;
    if (seriesName === 'high')   return bar.h;
    if (seriesName === 'low')    return bar.l;
    if (seriesName === 'volume') return bar.v;
    return null;
  };
  const first = at(0);
  const lastV = at(barCount - 1);
  if (first == null || lastV == null) return null;
  return (lastV - first) / (barCount - 1);
}

function resolveValue(node, ctx) {
  if ('field'   in node) return fieldValue(ctx, node.field);
  if ('ctx'     in node) return ctxValue(ctx, node.ctx);
  if ('literal' in node) return node.literal;
  if ('slope'   in node) return slopeValue(ctx, node.slope, Math.max(2, node.bars | 0));
  return null;
}

function formatVal(v) {
  if (v == null) return '—';
  if (typeof v === 'number') return Math.abs(v) < 1000 ? v.toFixed(2) : String(Math.round(v));
  if (Array.isArray(v)) return v.join('|');
  return String(v);
}

function compareOnce(op, l, r) {
  if (l == null || r == null) return null;
  const nl = typeof l === 'number' ? l : Number(l);
  const nr = typeof r === 'number' ? r : Number(r);
  const bothNumeric = Number.isFinite(nl) && Number.isFinite(nr);
  switch (op) {
    case 'gt': return bothNumeric ? nl >  nr : null;
    case 'ge': return bothNumeric ? nl >= nr : null;
    case 'lt': return bothNumeric ? nl <  nr : null;
    case 'le': return bothNumeric ? nl <= nr : null;
    case 'eq': return bothNumeric ? nl === nr : String(l) === String(r);
    case 'ne': return bothNumeric ? nl !== nr : String(l) !== String(r);
    default:   return null;
  }
}

function evaluateCondition(node, ctx) {
  if (!node || typeof node !== 'object') return { aligned: null, value: null };
  if (COMBINATOR_OPS.has(node.op)) {
    if (node.op === 'not') {
      const inner = evaluateCondition(node.operand, ctx);
      return { aligned: inner.aligned == null ? null : !inner.aligned, value: inner.value };
    }
    const results = node.operands.map(o => evaluateCondition(o, ctx));
    const align = node.op === 'and'
      ? results.every(r => r.aligned === true)
      : results.some(r => r.aligned === true);
    const anyNull = results.some(r => r.aligned == null);
    return {
      aligned: anyNull && !align ? null : align,
      value: results.map(r => r.value).filter(Boolean).join(' · '),
    };
  }
  if (COMPARISON_OPS.has(node.op)) {
    const left = resolveValue(node.left, ctx);
    if (node.op === 'in') {
      const list = node.list || [];
      const aligned = list.map(String).includes(String(left));
      return { aligned, value: `${formatVal(left)} ∈ {${list.map(formatVal).join(', ')}}` };
    }
    const right = resolveValue(node.right, ctx);
    const aligned = compareOnce(node.op, left, right);
    return { aligned, value: `${formatVal(left)} ${node.op} ${formatVal(right)}` };
  }
  return { aligned: null, value: null };
}

// ─── Fire-time collection ────────────────────────────────────────────────────

/**
 * Evaluate every check that applies to this fire and return the arrays
 * the Router will hand to the Grading engine.
 *
 *   mandatoryChecks   ← from the indicator's debug() output
 *   defaultChecks     ← every enabled library entry with category='default'
 *   additionalChecks  ← library entries assigned to this setup
 *
 * All three arrays share the same shape:
 *   { key, label, section?, value, aligned }
 */
function collectChecksForFire({ indicatorEngine, bars, pmHigh, setupId, indicatorExtras = {}, scannerContext = {}, historySeries = {} }) {
  const ctx = buildIndicatorContext(bars, indicatorExtras);
  ctx.scanner = scannerContext;
  ctx.history = historySeries;

  // Mandatory — reuse the engine's debug() so the fired conditions are
  // recorded on the card without re-implementing them.
  const mandatoryChecks = [];
  if (indicatorEngine && typeof indicatorEngine.debug === 'function') {
    let dbg = null;
    try { dbg = indicatorEngine.debug(bars, pmHigh); } catch { /* ignore */ }
    if (dbg && Array.isArray(dbg.conditions)) {
      for (const c of dbg.conditions) {
        mandatoryChecks.push({
          key:      c.name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, ''),
          label:    c.name,
          section:  'mandatory',
          value:    c.note ?? null,
          aligned:  c.pass == null ? null : Boolean(c.pass),
        });
      }
    }
  }

  const evaluate = (row) => {
    const r = evaluateCondition(row.condition, ctx);
    return {
      libraryId: row.id,
      key:       row.key,
      label:     row.label,
      section:   row.section || null,
      value:     r.value,
      aligned:   r.aligned,
    };
  };

  const defaultChecks    = listChecks({ category: 'default',    enabledOnly: true }).map(evaluate);
  const additionalChecks = setupId ? assignmentsForSetup(setupId).filter(r => r.enabled).map(evaluate) : [];

  return { mandatoryChecks, defaultChecks, additionalChecks };
}

module.exports = {
  // Library
  listChecks,
  getCheck,
  createCheck,
  updateCheck,
  removeCheck,
  // Assignments
  assignmentsForSetup,
  setAssignmentsForSetup,
  // Evaluator
  validateCondition,
  evaluateCondition,
  buildIndicatorContext,
  collectChecksForFire,
};
