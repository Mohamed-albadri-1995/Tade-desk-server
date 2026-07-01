/**
 * VWAP Bounce (L3 Pullback + Bounce Entry)
 *
 * Direct port of the L3 signal from the "Healthy Pullback L3 + BB Zone MA
 * Touch" Pine script. Line references below cite the original .pine.
 *
 * Fires LONG when — on the current (signal) bar — all of the following
 * are simultaneously true:
 *
 *   1. Long bias on the previous bar and on this bar
 *      Non-strict: close > daily_vwap AND close > BB EMA
 *      Strict:     also close > 2-day VWAP AND close > LL AVWAP
 *      Config: bias_strict (default false; strict needs a multi-day bar
 *      stream that our poller doesn't feed yet, so we soften the default).
 *
 *   2. Previous bar was a pullback candle (Pine: l3_c1)
 *        - closed red (close[1] < open[1])
 *        - lower-wick % of range >= min_wick (default 15)
 *        - low[1] touched one of the VWAPs within vwap_touch %
 *          (default 0.2). Any of: daily_vwap, 2-day, LL AVWAP.
 *        - was not extended: high[1] < BB upper[1]
 *
 *   3. Current bar confirms the bounce (Pine: l3_c2)
 *        - green: close > open
 *        - close broke previous bar's high: close > high[1]
 *        - if req_vol enabled, volume > volume[1]
 *
 *   4. Slope filter (if use_slope, default true)
 *        - VWAP slope_score >= slope_min_long (default 2)
 *
 *   5. Zone-duration filter (if use_zone_dur, default false)
 *        - previous bar's zone_count >= zone_dur_bars (default 3)
 *
 * Entry: close of the signal bar.
 * SL:    entry − (t2_sl_ticks × tick), default entry − $0.90 for a $0.01 tick.
 * TP:    entry + (t2_tp_ticks × tick), default entry + $3.00 (≈ 3.33R).
 *
 * The Pine T2 "runner" values are the primary bracket; T1 (240/90) and the
 * breakeven trigger aren't representable in a single bracket order and would
 * need position-management scaffolding to model — flagged as a TODO.
 */

// ── Config defaults (match Pine input defaults) ─────────────────────────────
const CFG = {
  bb_length:      21,
  bb_mult:        2.0,
  zone_pct:       25,      // % of BB range that forms top/bot zones
  min_wick:       15,      // % of range (previous candle lower wick)
  vwap_touch:     0.20,    // % tolerance around VWAP
  req_vol:        false,
  bias_strict:    false,   // strict needs 2-day VWAP; keep off until multi-day plumbed
  use_slope:      true,
  slope_periods:  3,
  slope_min_long: 2,
  slope_reset_x:  true,
  use_zone_dur:   false,
  zone_dur_bars:  3,
  zone_dur_type:  'close', // 'close' | 'body' | 'low/high'
  t2_sl_ticks:    90,      // Pine T2 runner
  t2_tp_ticks:    300,     // Pine T2 runner
  tick_size:      0.01,    // US stocks
};

// ── Primitives ───────────────────────────────────────────────────────────────

function calcEMA(vals, period) {
  if (vals.length < period) return null;
  const k = 2 / (period + 1);
  let ema = vals.slice(0, period).reduce((s, v) => s + v, 0) / period;
  for (let i = period; i < vals.length; i++) ema = vals[i] * k + ema * (1 - k);
  return ema;
}

function calcStdev(vals, period) {
  if (vals.length < period) return null;
  const slice = vals.slice(vals.length - period);
  const mean = slice.reduce((s, v) => s + v, 0) / period;
  const variance = slice.reduce((s, v) => s + (v - mean) ** 2, 0) / period; // ddof=0, Pine population stdev
  return Math.sqrt(variance);
}

// Session VWAP anchored at bars[0]. Assumes buffer starts at session open,
// which matches the barPoller (it feeds today's 1-min bars from 9:30 ET).
function sessionVwap(bars) {
  let pv = 0, v = 0;
  for (const b of bars) {
    const hlc3 = (b.h + b.l + b.c) / 3;
    pv += hlc3 * b.v;
    v  += b.v;
  }
  return v > 0 ? pv / v : null;
}

// Anchored VWAP from the session's lowest low up to and including now.
// Pine's ll_avwap re-anchors every time low sets a new session low; the
// result at 'now' equals the VWAP from THAT bar forward.
function llAnchoredVwap(bars) {
  if (!bars.length) return null;
  let anchor = 0;
  let lowest = bars[0].l;
  for (let i = 1; i < bars.length; i++) {
    if (bars[i].l < lowest) { lowest = bars[i].l; anchor = i; }
  }
  let pv = 0, v = 0;
  for (let i = anchor; i < bars.length; i++) {
    const hlc3 = (bars[i].h + bars[i].l + bars[i].c) / 3;
    pv += hlc3 * bars[i].v;
    v  += bars[i].v;
  }
  return v > 0 ? pv / v : null;
}

// Slope score, evaluated bar-by-bar per Pine (bar_index % slope_periods === 0
// tick, +1 if daily_vwap rose since ref, -1 if fell, reset on VWAP cross when
// slope_reset_x). Recomputed from scratch each call — deterministic given
// the buffer.
function slopeScore(bars) {
  if (bars.length < 2) return 0;
  let score = 0;
  let ref = null;
  let wasAbove = null;
  for (let i = 0; i < bars.length; i++) {
    const slice = bars.slice(0, i + 1);
    const vwapNow = sessionVwap(slice);
    if (vwapNow == null) continue;
    const above = bars[i].c > vwapNow;
    if (ref == null) { ref = vwapNow; wasAbove = above; continue; }
    if (CFG.slope_reset_x && wasAbove != null && above !== wasAbove) {
      score = 0; ref = vwapNow;
    }
    wasAbove = above;
    if (i % CFG.slope_periods === 0) {
      if (vwapNow > ref) score += 1;
      else if (vwapNow < ref) score -= 1;
      ref = vwapNow;
    }
  }
  return score;
}

// Zone-duration counter: how many CONSECUTIVE bars up to prev have been in
// the setup zone (BB EMA .. top-zone-bot, with a 5% BB-range buffer).
function zoneCountAtPrev(closes, bars, bbEmaSeries, topZoneBotSeries, bbRangeSeries, type) {
  if (bars.length < 2) return 0;
  let count = 0;
  for (let i = 0; i < bars.length - 1; i++) {
    if (bbEmaSeries[i] == null) { count = 0; continue; }
    const buffer = bbRangeSeries[i] * 0.05;
    const emaLo = bbEmaSeries[i] - buffer;
    const emaHi = topZoneBotSeries[i] + buffer;
    let inZone;
    if (type === 'close') inZone = bars[i].c >= emaLo && bars[i].c <= emaHi;
    else if (type === 'low/high') inZone = bars[i].l >= emaLo && bars[i].h <= emaHi;
    else {
      const bt = Math.max(bars[i].o, bars[i].c);
      const bb = Math.min(bars[i].o, bars[i].c);
      inZone = bb >= emaLo && bt <= emaHi;
    }
    count = inZone ? count + 1 : 0;
  }
  return count;
}

// Compute per-bar BB series so the zone counter can look back through them.
function bbSeries(closes) {
  const emas = [], stds = [], uppers = [], lowers = [], ranges = [], topZones = [];
  for (let i = 0; i < closes.length; i++) {
    const slice = closes.slice(0, i + 1);
    const ema = calcEMA(slice, CFG.bb_length);
    const std = calcStdev(slice, CFG.bb_length);
    if (ema == null || std == null) {
      emas.push(null); stds.push(null); uppers.push(null); lowers.push(null); ranges.push(null); topZones.push(null);
      continue;
    }
    const upper = ema + CFG.bb_mult * std;
    const lower = ema - CFG.bb_mult * std;
    const range = upper - lower;
    emas.push(ema); stds.push(std);
    uppers.push(upper); lowers.push(lower); ranges.push(range);
    topZones.push(upper - range * (CFG.zone_pct / 100));
  }
  return { emas, stds, uppers, lowers, ranges, topZones };
}

// ── Signal ──────────────────────────────────────────────────────────────────

function evaluate(bars, pmHigh, ctx = {}) {
  // Need at least bb_length + 1 for a valid EMA/std on prev bar.
  const need = CFG.bb_length + 2;
  if (!bars || bars.length < need) return null;

  const closes = bars.map(b => b.c);
  const prev = bars[bars.length - 2];
  const curr = bars[bars.length - 1];

  const daily_vwap  = sessionVwap(bars);
  const ll_avwap    = llAnchoredVwap(bars);
  const vwap_2day   = daily_vwap; // TODO: swap for real 2-day series once multi-day bars are plumbed
  const bb = bbSeries(closes);
  const iNow = bars.length - 1;
  const iPrev = bars.length - 2;
  const bb_ema      = bb.emas[iNow];
  const bb_upper    = bb.uppers[iNow];
  const bb_ema_p    = bb.emas[iPrev];
  const bb_upper_p  = bb.uppers[iPrev];

  if (bb_ema == null || bb_ema_p == null) return null;

  // Bias — current bar and previous bar. Pine: long_bias / long_bias_c1.
  const biasBase   = curr.c > daily_vwap && curr.c > bb_ema;
  const biasFull   = biasBase && curr.c > vwap_2day && curr.c > ll_avwap;
  const bias       = CFG.bias_strict ? biasFull : biasBase;
  // For prev, we need PREV's session VWAP + LL AVWAP + BB EMA (already have BB).
  const prevSliceExcl = bars.slice(0, bars.length - 1);
  const daily_vwap_p = sessionVwap(prevSliceExcl);
  const ll_avwap_p   = llAnchoredVwap(prevSliceExcl);
  const vwap_2day_p  = daily_vwap_p;
  const biasBaseP  = prev.c > daily_vwap_p && prev.c > bb_ema_p;
  const biasFullP  = biasBaseP && prev.c > vwap_2day_p && prev.c > ll_avwap_p;
  const bias_c1    = CFG.bias_strict ? biasFullP : biasBaseP;

  // Pullback candle (Pine: l3_c1) — previous bar was red with a bounce wick
  // that tagged one of the VWAPs.
  const prevRed        = prev.c < prev.o;
  const prevRange      = prev.h - prev.l;
  const prevBodyBot    = Math.min(prev.o, prev.c);
  const prevLowerWick  = prevBodyBot - prev.l;
  const prevLwickPct   = prevRange > 0 ? (prevLowerWick / prevRange) * 100 : 0;
  const wickOk         = prevLwickPct >= CFG.min_wick;
  const tol            = CFG.vwap_touch / 100;
  const touchOf        = (ref) => ref != null && prev.l <= ref * (1 + tol) && prev.l >= ref * (1 - tol);
  const touchedDv      = touchOf(daily_vwap_p);
  const touchedV2      = touchOf(vwap_2day_p);
  const touchedAv      = touchOf(ll_avwap_p);
  const anyVwapTouch   = touchedDv || touchedV2 || touchedAv;
  const notExtended    = bb_upper_p != null && prev.h < bb_upper_p;
  const l3_c1          = prevRed && wickOk && anyVwapTouch && notExtended;

  // Bounce confirmation (Pine: l3_c2).
  const currGreen      = curr.c > curr.o;
  const brokePrevHigh  = curr.c > prev.h;
  const volOk          = CFG.req_vol ? curr.v > prev.v : true;
  const l3_c2          = currGreen && brokePrevHigh && volOk;

  // Slope filter.
  const score          = CFG.use_slope ? slopeScore(bars) : Infinity;
  const slopeOk        = !CFG.use_slope || score >= CFG.slope_min_long;

  // Zone duration filter (default off).
  const zoneOk = CFG.use_zone_dur
    ? zoneCountAtPrev(closes, bars, bb.emas, bb.topZones, bb.ranges, CFG.zone_dur_type) >= CFG.zone_dur_bars
    : true;

  if (!(bias_c1 && bias && l3_c1 && l3_c2 && slopeOk && zoneOk)) return null;

  // Bracket — Pine T2 runner values.
  const tick  = CFG.tick_size;
  const entry = curr.c;
  const sl    = entry - CFG.t2_sl_ticks * tick;
  const tp    = entry + CFG.t2_tp_ticks * tick;
  const risk  = entry - sl;
  if (risk <= 0 || tp <= entry) return null;

  return {
    direction: 'Long',
    entry:  parseFloat(entry.toFixed(4)),
    sl:     parseFloat(sl.toFixed(4)),
    tp:     parseFloat(tp.toFixed(4)),
    riskPerShare: parseFloat(risk.toFixed(4)),
    meta: {
      daily_vwap:  daily_vwap,
      vwap_2day:   vwap_2day,
      ll_avwap:    ll_avwap,
      bb_ema:      bb_ema,
      bb_upper:    bb_upper,
      slope_score: score,
      prevLwickPct,
      touchedDv, touchedV2, touchedAv,
      biasStrict:  CFG.bias_strict,
      barTime:     curr.t,
    },
  };
}

// ── Debug conditions (the MANDATORY tier the UI displays) ────────────────────
// These are the EXACT conditions checked in evaluate(). If any is false the
// signal doesn't fire — matching Pine 1:1 (line 201 of the source).

function debug(bars, pmHigh, ctx = {}) {
  const need = CFG.bb_length + 2;
  if (!bars || bars.length < need) {
    return { canRun: false, reason: `need ${need}+ bars, have ${bars?.length ?? 0}` };
  }

  const closes = bars.map(b => b.c);
  const prev = bars[bars.length - 2];
  const curr = bars[bars.length - 1];
  const daily_vwap = sessionVwap(bars);
  const ll_avwap   = llAnchoredVwap(bars);
  const vwap_2day  = daily_vwap;
  const bb = bbSeries(closes);
  const iNow = bars.length - 1, iPrev = bars.length - 2;
  const bb_ema     = bb.emas[iNow];
  const bb_upper_p = bb.uppers[iPrev];

  const prevSliceExcl = bars.slice(0, bars.length - 1);
  const daily_vwap_p = sessionVwap(prevSliceExcl);
  const ll_avwap_p   = llAnchoredVwap(prevSliceExcl);
  const bb_ema_p     = bb.emas[iPrev];

  const biasBase   = curr.c > daily_vwap && curr.c > bb_ema;
  const biasBaseP  = prev.c > daily_vwap_p && prev.c > bb_ema_p;
  const bias       = CFG.bias_strict ? (biasBase && curr.c > vwap_2day && curr.c > ll_avwap) : biasBase;
  const bias_c1    = CFG.bias_strict ? (biasBaseP && prev.c > daily_vwap_p && prev.c > ll_avwap_p) : biasBaseP;

  const prevRed        = prev.c < prev.o;
  const prevRange      = prev.h - prev.l;
  const prevBodyBot    = Math.min(prev.o, prev.c);
  const prevLwickPct   = prevRange > 0 ? ((prevBodyBot - prev.l) / prevRange) * 100 : 0;
  const wickOk         = prevLwickPct >= CFG.min_wick;
  const tol            = CFG.vwap_touch / 100;
  const touchOf        = (ref) => ref != null && prev.l <= ref * (1 + tol) && prev.l >= ref * (1 - tol);
  const anyVwapTouch   = touchOf(daily_vwap_p) || touchOf(vwap_2day_p /* = daily proxy */) || touchOf(ll_avwap_p);
  const notExtended    = bb_upper_p != null && prev.h < bb_upper_p;

  const currGreen      = curr.c > curr.o;
  const brokePrevHigh  = curr.c > prev.h;
  const volOk          = CFG.req_vol ? curr.v > prev.v : true;

  const score          = CFG.use_slope ? slopeScore(bars) : null;

  return {
    canRun: true,
    conditions: [
      { name: 'Long bias (prev bar)',       pass: bias_c1,       note: `close ${prev.c?.toFixed(2)} vs daily_vwap ${daily_vwap_p?.toFixed(2)} / bb_ema ${bb_ema_p?.toFixed(2)}` },
      { name: 'Long bias (this bar)',       pass: bias,          note: `close ${curr.c?.toFixed(2)} vs daily_vwap ${daily_vwap?.toFixed(2)}` },
      { name: 'Prev candle red',            pass: prevRed,       note: `prev close ${prev.c?.toFixed(2)} vs open ${prev.o?.toFixed(2)}` },
      { name: `Lower wick ≥ ${CFG.min_wick}%`,  pass: wickOk,     note: `${prevLwickPct.toFixed(1)}%` },
      { name: 'Prev low touched a VWAP',    pass: anyVwapTouch,  note: `prev.l ${prev.l?.toFixed(2)} vs VWAPs ±${(tol*100).toFixed(2)}%` },
      { name: 'Not extended (prev.h < BB upper)', pass: notExtended, note: `prev.h ${prev.h?.toFixed(2)} vs BB up ${bb_upper_p?.toFixed(2)}` },
      { name: 'This bar green',             pass: currGreen,     note: `close ${curr.c?.toFixed(2)} vs open ${curr.o?.toFixed(2)}` },
      { name: 'Close > prev high',          pass: brokePrevHigh, note: `close ${curr.c?.toFixed(2)} vs prev.h ${prev.h?.toFixed(2)}` },
      { name: 'Volume confirmation',        pass: volOk,         note: CFG.req_vol ? `vol ${curr.v} vs prev ${prev.v}` : 'skipped' },
      { name: `Slope score ≥ ${CFG.slope_min_long}`, pass: CFG.use_slope ? score >= CFG.slope_min_long : null, note: CFG.use_slope ? `score ${score}` : 'disabled' },
    ],
  };
}

module.exports = { evaluate, debug };
