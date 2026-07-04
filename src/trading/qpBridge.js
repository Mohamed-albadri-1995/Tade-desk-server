/**
 * qp bridge — thin HTTP client for the Python quant-platform's
 * /qp/eval endpoint. Lets Node compute indicators via qp math instead
 * of reimplementing them locally in checks.js / indicator engines.
 *
 * Started by `python quant-platform/tools/compare_server.py` on port
 * 8765 by default. Override with QP_URL env var.
 */

const QP_URL = process.env.QP_URL || 'http://127.0.0.1:8765';
const REQ_TIMEOUT_MS = 5000;

/**
 * Field-name → qp indicator spec. Mirrors the Python
 * qp.setups.chart_specs._FIELD_TO_SPEC map so the trade desk's
 * check-grammar field names route to the correct qp function.
 */
const FIELD_TO_QP = {
  vwap:         { ind: 'vwap' },
  ema9:         { ind: 'ema', length: 9 },
  ema13:        { ind: 'ema', length: 13 },
  ema20:        { ind: 'ema', length: 20 },
  ema50:        { ind: 'ema', length: 50 },
  sma5:         { ind: 'sma', length: 5 },
  sma9:         { ind: 'sma', length: 9 },
  sma13:        { ind: 'sma', length: 13 },
  sma20:        { ind: 'sma', length: 20 },
  vwap_2d:      { ind: 'vwap_2d' },
  weekly_vwap:  { ind: 'weekly_vwap' },
  monthly_vwap: { ind: 'monthly_vwap' },
  today_hh_vwap:{ ind: 'today_hh_vwap' },
  today_ll_vwap:{ ind: 'today_ll_vwap' },
  pivot_ll_vwap:{ ind: 'pivot_ll_vwap', length: 25 },
  pivot_hh_vwap:{ ind: 'pivot_hh_vwap', length: 25 },
  atr:          { ind: 'atr', length: 14 },
  dayHigh:      { ind: 'day_high' },
  dayLow:       { ind: 'day_low' },
  pmHigh:       { ind: 'pm_high' },
  pmLow:        { ind: 'pm_low' },
  prevDayHigh:  { ind: 'prev_day_high' },
  prevDayLow:   { ind: 'prev_day_low' },
};

const INTRINSIC_FIELDS = new Set(['close', 'open', 'high', 'low', 'volume',
                                  'prevClose', 'rvol']);

async function _post(path, body) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), REQ_TIMEOUT_MS);
  try {
    const res = await fetch(`${QP_URL}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctl.signal,
    });
    if (!res.ok) throw new Error(`${path} → ${res.status}`);
    return res.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * POST /qp/eval — returns per-key series aligned to bars.
 * bars       : [{t: <unix-seconds>, o, h, l, c, v}, …]
 * indicators : [{key, ind, length?, mult?}, …]
 */
async function evalIndicators(bars, indicators) {
  return _post('/qp/eval', { bars, indicators });
}

/**
 * Convenience for the check evaluator: given bars and a list of field
 * names, return {field: latest-bar value | null}. Fields the qp map
 * doesn't know (intrinsic OHLCV, etc.) are silently skipped so the
 * caller can fall back to its own logic.
 */
async function latestFieldValues(bars, fieldNames) {
  const specs = [];
  for (const name of fieldNames) {
    if (INTRINSIC_FIELDS.has(name)) continue;
    const s = FIELD_TO_QP[name];
    if (!s) continue;
    specs.push({ key: name, ...s });
  }
  if (specs.length === 0) return {};
  const { keys, values } = await evalIndicators(bars, specs);
  const out = {};
  for (const k of keys) {
    const arr = values[k] || [];
    const v = arr.length ? arr[arr.length - 1] : null;
    if (v !== null && Number.isFinite(v)) out[k] = v;
  }
  return out;
}

/**
 * Walk a check-library condition tree and collect every field / history
 * / slope name referenced. Mirrors the Python
 * qp.setups.chart_specs._walk so the two extractors stay in lock-step.
 */
function extractFields(node) {
  const out = new Set();
  const walk = n => {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) { for (const x of n) walk(x); return; }
    for (const k of ['field', 'history', 'slope', 'series']) {
      if (typeof n[k] === 'string') out.add(n[k]);
    }
    for (const v of Object.values(n)) {
      if (v && (typeof v === 'object')) walk(v);
    }
  };
  walk(node);
  return [...out];
}

/**
 * Pre-pass for the check evaluator: collect every field referenced by
 * `condition`, fetch their latest-bar values from qp, and merge them
 * into ctx.ind. Fields the bridge doesn't cover are left untouched
 * (caller keeps whatever it computed locally).
 *
 * Returns the fields it filled — mostly for logging.
 */
async function enrichContextWithQp(ctx, condition) {
  const bars = ctx?.bars || [];
  if (!bars.length) return [];
  const fields = extractFields(condition);
  const filled = await latestFieldValues(bars, fields);
  ctx.ind = { ...(ctx.ind || {}), ...filled };
  return Object.keys(filled);
}

async function ping() {
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 1500);
    const res = await fetch(`${QP_URL}/qp-setups`, { signal: ctl.signal });
    clearTimeout(timer);
    return res.ok;
  } catch {
    return false;
  }
}

module.exports = {
  evalIndicators, latestFieldValues,
  extractFields, enrichContextWithQp,
  ping, FIELD_TO_QP,
};
