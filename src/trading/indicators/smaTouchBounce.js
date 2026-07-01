/**
 * SMA Touch Bounce (BBZ MA Touch Entry)
 *
 * Direct port of the BBZ signal from the "Healthy Pullback L3 + BB Zone MA
 * Touch" Pine script. Line references cite the original .pine.
 *
 * Fires LONG (Pine: bz_long_sig, line 308) when ALL are true:
 *
 *   1. Session window OK (Pine: bz_sessionOK)
 *      The session gate is provided by the setup's window_start /
 *      window_end config in our system, so we don't recompute here —
 *      barPoller skips outside-window bars entirely.
 *
 *   2. VWAP σ-band gate (Pine: bz_l_vwapOK)
 *        close > daily_vwap + bz_l_sdvMult × vwap_stdev
 *
 *   3. Zone quality (Pine: bz_l_zoneOK)
 *      Over the last bz_l_lookback bars, the sum of body % that sat
 *      INSIDE the BB red-zone (bottom bz_s_zonePct %) must be < bz_l_outsideThresh %.
 *
 *   4. SMA touch (Pine: bz_l_maTouch)
 *      One of SMA 9/13/20:
 *        - previous bar's range straddled it: low[1] ≤ sma[1] ≤ high[1]
 *        - current bar closes above the SMA
 *      AND a bullish body: close > open,
 *          body > bz_l_body_atr × ATR14,
 *          upper_wick < bz_l_wick_ratio × body.
 *
 * Fires SHORT (Pine: bz_short_sig, line 309) as the mirror.
 *
 * Entry: close of the signal bar.
 * SL:    SMA20 of the signal bar (Pine: bz_long_sl / bz_short_sl = bz_sma20).
 * TP:    entry + 2 × (entry − SL) for long, mirror for short — 2R.
 *        The Pine script doesn't define a TP; 2R is the same convention
 *        we use in ma13bounce and matches typical BBZ setups.
 */

const CFG = {
  bb_len:        20,
  bb_mult:       2.0,
  // Short side
  s_lookback:      3,
  s_zonePct:       25.0,
  s_outsideThresh: 7.0,
  s_sdvMult:       0.8,
  s_body_atr:      0.2,
  s_wick_ratio:    0.5,
  // Long side
  l_lookback:      4,
  l_zonePct:       25.0,
  l_outsideThresh: 7.0,
  l_sdvMult:       0.8,
  l_body_atr:      0.2,
  l_wick_ratio:    0.5,
  atr_length:     14,
  tp_r_multiple:   2,
};

// ── Primitives ──────────────────────────────────────────────────────────────

function calcSMA(vals, period) {
  if (vals.length < period) return null;
  const slice = vals.slice(vals.length - period);
  return slice.reduce((s, v) => s + v, 0) / period;
}

function calcSMASeries(vals, period) {
  const out = [];
  for (let i = 0; i < vals.length; i++) {
    if (i + 1 < period) { out.push(null); continue; }
    let sum = 0;
    for (let j = i + 1 - period; j <= i; j++) sum += vals[j];
    out.push(sum / period);
  }
  return out;
}

function calcStdev(vals, period) {
  if (vals.length < period) return null;
  const slice = vals.slice(vals.length - period);
  const mean = slice.reduce((s, v) => s + v, 0) / period;
  const variance = slice.reduce((s, v) => s + (v - mean) ** 2, 0) / period;
  return Math.sqrt(variance);
}

// ATR (Pine ta.atr uses Wilder / RMA smoothing).
function calcATR(bars, period) {
  if (bars.length < period + 1) return null;
  const trs = [];
  for (let i = 1; i < bars.length; i++) {
    const cur = bars[i], prev = bars[i - 1];
    trs.push(Math.max(cur.h - cur.l, Math.abs(cur.h - prev.c), Math.abs(cur.l - prev.c)));
  }
  // RMA / Wilder: seed with SMA of first `period` TRs, then EWMA with alpha=1/period.
  let rma = trs.slice(0, period).reduce((s, v) => s + v, 0) / period;
  for (let i = period; i < trs.length; i++) rma = (rma * (period - 1) + trs[i]) / period;
  return rma;
}

// Session VWAP + population stdev of hlc3 vs vwap, same accumulator as
// the Pine script's shared block (lines 68-84).
function sessionVwapWithStdev(bars) {
  let pv = 0, pv2 = 0, vol = 0;
  for (const b of bars) {
    const hlc3 = (b.h + b.l + b.c) / 3;
    pv  += hlc3 * b.v;
    pv2 += hlc3 * hlc3 * b.v;
    vol += b.v;
  }
  if (vol <= 0) return { vwap: null, stdev: null };
  const vwap = pv / vol;
  const variance = Math.max(0, pv2 / vol - vwap * vwap);
  return { vwap, stdev: Math.sqrt(variance) };
}

// Sum of body % that sat inside a zone, over the last `lookback` bars.
// Pine: bz_l_totalBody / bz_l_badBody loop (lines 264-271, 273-280).
function badBodyPct(bars, lookback, side, zoneCutoff) {
  if (bars.length < lookback) return { pct: 0, total: 0, bad: 0 };
  let totalBody = 0, badBody = 0;
  const startIdx = bars.length - lookback;
  for (let i = startIdx; i < bars.length; i++) {
    const b = bars[i];
    const bt = Math.max(b.o, b.c);
    const bb = Math.min(b.o, b.c);
    totalBody += bt - bb;
    if (side === 'long') {
      // How much of the body sat below zoneCutoff (red-zone top).
      badBody += Math.max(0, Math.min(bt, zoneCutoff) - bb);
    } else {
      // How much of the body sat above zoneCutoff (green-zone bottom).
      badBody += Math.max(0, bt - Math.max(bb, zoneCutoff));
    }
  }
  const pct = totalBody > 0 ? (badBody / totalBody) * 100 : 0;
  return { pct, total: totalBody, bad: badBody };
}

// ── Signal ──────────────────────────────────────────────────────────────────

function evaluate(bars, pmHigh, ctx = {}) {
  // BB (20) + ATR (14) + SMA20 all need history; ATR wants period+1.
  const need = Math.max(CFG.bb_len, CFG.atr_length + 1, 21);
  if (!bars || bars.length < need) return null;

  const closes = bars.map(b => b.c);
  const prev = bars[bars.length - 2];
  const curr = bars[bars.length - 1];

  const { vwap: daily_vwap, stdev: vwap_stdev } = sessionVwapWithStdev(bars);
  if (daily_vwap == null) return null;

  const bbMid   = calcSMA(closes, CFG.bb_len);
  const bbStd   = calcStdev(closes, CFG.bb_len);
  if (bbMid == null || bbStd == null) return null;
  const bb_up   = bbMid + CFG.bb_mult * bbStd;
  const bb_lo   = bbMid - CFG.bb_mult * bbStd;
  const bb_range = bb_up - bb_lo;
  const red_top    = bb_lo + (CFG.s_zonePct / 100) * bb_range;   // top of red zone (long uses this as cutoff)
  const green_bot  = bb_up - (CFG.l_zonePct / 100) * bb_range;   // bottom of green zone (short uses this)

  const sma9s   = calcSMASeries(closes, 9);
  const sma13s  = calcSMASeries(closes, 13);
  const sma20s  = calcSMASeries(closes, 20);
  const sma9    = sma9s[sma9s.length - 1];
  const sma13   = sma13s[sma13s.length - 1];
  const sma20   = sma20s[sma20s.length - 1];
  const sma9_p  = sma9s[sma9s.length - 2];
  const sma13_p = sma13s[sma13s.length - 2];
  const sma20_p = sma20s[sma20s.length - 2];
  if (sma20 == null || sma20_p == null) return null;

  const atr14 = calcATR(bars, CFG.atr_length);
  if (atr14 == null || atr14 <= 0) return null;

  const barBody   = Math.abs(curr.c - curr.o);
  const upperWick = curr.h - Math.max(curr.c, curr.o);
  const lowerWick = Math.min(curr.c, curr.o) - curr.l;

  // ── LONG ─────────────────────────────────────────────────────────────
  const l_vwapOK = curr.c > daily_vwap + CFG.l_sdvMult * vwap_stdev;
  const l_zone   = badBodyPct(bars, CFG.l_lookback, 'long', red_top);
  const l_zoneOK = l_zone.pct < CFG.l_outsideThresh;
  const l_bounceBull = curr.c > curr.o;
  const l_bounceBody = barBody > atr14 * CFG.l_body_atr;
  const l_bounceWick = upperWick < barBody * CFG.l_wick_ratio;
  const l_bounceOK   = l_bounceBull && l_bounceBody && l_bounceWick;
  const l_touch = (smaP, smaN) =>
    smaP != null && smaN != null &&
    prev.l <= smaP && prev.h >= smaP &&
    curr.c > smaN && l_bounceOK;
  const l_touch9  = l_touch(sma9_p, sma9);
  const l_touch13 = l_touch(sma13_p, sma13);
  const l_touch20 = l_touch(sma20_p, sma20);
  const l_maTouch = l_touch9 || l_touch13 || l_touch20;
  const longSig   = l_vwapOK && l_zoneOK && l_maTouch;

  // ── SHORT ────────────────────────────────────────────────────────────
  const s_vwapOK = curr.c < daily_vwap - CFG.s_sdvMult * vwap_stdev;
  const s_zone   = badBodyPct(bars, CFG.s_lookback, 'short', green_bot);
  const s_zoneOK = s_zone.pct < CFG.s_outsideThresh;
  const s_rejectBear = curr.c < curr.o;
  const s_rejectBody = barBody > atr14 * CFG.s_body_atr;
  const s_rejectWick = lowerWick < barBody * CFG.s_wick_ratio;
  const s_rejectOK   = s_rejectBear && s_rejectBody && s_rejectWick;
  const s_touch = (smaP, smaN) =>
    smaP != null && smaN != null &&
    prev.l <= smaP && prev.h >= smaP &&
    curr.c < smaN && s_rejectOK;
  const s_touch9  = s_touch(sma9_p, sma9);
  const s_touch13 = s_touch(sma13_p, sma13);
  const s_touch20 = s_touch(sma20_p, sma20);
  const s_maTouch = s_touch9 || s_touch13 || s_touch20;
  const shortSig  = s_vwapOK && s_zoneOK && s_maTouch;

  if (!longSig && !shortSig) return null;

  const direction = longSig ? 'Long' : 'Short';
  const entry = curr.c;
  const sl    = sma20; // Pine: bz_long_sl / bz_short_sl = bz_sma20
  const risk  = direction === 'Long' ? entry - sl : sl - entry;
  if (risk <= 0) return null;   // SL on wrong side; skip
  const tp    = direction === 'Long' ? entry + CFG.tp_r_multiple * risk : entry - CFG.tp_r_multiple * risk;
  const maHit = direction === 'Long'
    ? (l_touch9 ? 'SMA9' : l_touch13 ? 'SMA13' : 'SMA20')
    : (s_touch9 ? 'SMA9' : s_touch13 ? 'SMA13' : 'SMA20');

  return {
    direction,
    entry:  parseFloat(entry.toFixed(4)),
    sl:     parseFloat(sl.toFixed(4)),
    tp:     parseFloat(tp.toFixed(4)),
    riskPerShare: parseFloat(risk.toFixed(4)),
    meta: {
      daily_vwap, vwap_stdev,
      bb_mid: bbMid, bb_up, bb_lo,
      sma9, sma13, sma20,
      atr14,
      maHit,
      barTime: curr.t,
      zonePct: direction === 'Long' ? l_zone.pct : s_zone.pct,
    },
  };
}

// ── Debug conditions (MANDATORY tier) ────────────────────────────────────────

function debug(bars, pmHigh, ctx = {}) {
  const need = Math.max(CFG.bb_len, CFG.atr_length + 1, 21);
  if (!bars || bars.length < need) {
    return { canRun: false, reason: `need ${need}+ bars, have ${bars?.length ?? 0}` };
  }

  const closes = bars.map(b => b.c);
  const prev = bars[bars.length - 2];
  const curr = bars[bars.length - 1];

  const { vwap: daily_vwap, stdev: vwap_stdev } = sessionVwapWithStdev(bars);
  const bbMid  = calcSMA(closes, CFG.bb_len);
  const bbStd  = calcStdev(closes, CFG.bb_len);
  const bb_up  = bbMid + CFG.bb_mult * bbStd;
  const bb_lo  = bbMid - CFG.bb_mult * bbStd;
  const range  = bb_up - bb_lo;
  const red_top   = bb_lo + (CFG.s_zonePct / 100) * range;
  const green_bot = bb_up - (CFG.l_zonePct / 100) * range;
  const sma9s   = calcSMASeries(closes, 9);
  const sma13s  = calcSMASeries(closes, 13);
  const sma20s  = calcSMASeries(closes, 20);
  const sma9    = sma9s.at(-1), sma13 = sma13s.at(-1), sma20 = sma20s.at(-1);
  const sma9_p  = sma9s.at(-2), sma13_p = sma13s.at(-2), sma20_p = sma20s.at(-2);
  const atr14   = calcATR(bars, CFG.atr_length);

  const barBody   = Math.abs(curr.c - curr.o);
  const upperWick = curr.h - Math.max(curr.c, curr.o);
  const lowerWick = Math.min(curr.c, curr.o) - curr.l;

  const l_vwapOK   = curr.c > daily_vwap + CFG.l_sdvMult * vwap_stdev;
  const l_zone     = badBodyPct(bars, CFG.l_lookback, 'long', red_top);
  const l_zoneOK   = l_zone.pct < CFG.l_outsideThresh;
  const l_bounceOK = curr.c > curr.o && barBody > atr14 * CFG.l_body_atr && upperWick < barBody * CFG.l_wick_ratio;
  const l_touchAny = ((sma9_p != null && prev.l <= sma9_p && prev.h >= sma9_p && curr.c > sma9)
                   || (sma13_p != null && prev.l <= sma13_p && prev.h >= sma13_p && curr.c > sma13)
                   || (sma20_p != null && prev.l <= sma20_p && prev.h >= sma20_p && curr.c > sma20)) && l_bounceOK;

  const s_vwapOK   = curr.c < daily_vwap - CFG.s_sdvMult * vwap_stdev;
  const s_zone     = badBodyPct(bars, CFG.s_lookback, 'short', green_bot);
  const s_zoneOK   = s_zone.pct < CFG.s_outsideThresh;
  const s_rejectOK = curr.c < curr.o && barBody > atr14 * CFG.s_body_atr && lowerWick < barBody * CFG.s_wick_ratio;
  const s_touchAny = ((sma9_p != null && prev.l <= sma9_p && prev.h >= sma9_p && curr.c < sma9)
                   || (sma13_p != null && prev.l <= sma13_p && prev.h >= sma13_p && curr.c < sma13)
                   || (sma20_p != null && prev.l <= sma20_p && prev.h >= sma20_p && curr.c < sma20)) && s_rejectOK;

  // The signal fires on EITHER long OR short, so list all conditions grouped.
  return {
    canRun: true,
    conditions: [
      { name: 'LONG · close > VWAP + σ',           pass: l_vwapOK,   note: `close ${curr.c?.toFixed(2)} vs band ${(daily_vwap + CFG.l_sdvMult*vwap_stdev)?.toFixed(2)}` },
      { name: `LONG · zone body % < ${CFG.l_outsideThresh}`, pass: l_zoneOK, note: `${l_zone.pct.toFixed(1)}% inside red zone` },
      { name: 'LONG · SMA touch + bullish bounce', pass: l_touchAny, note: `body ${barBody.toFixed(3)} vs ATR×${CFG.l_body_atr} ${(atr14*CFG.l_body_atr).toFixed(3)}` },
      { name: 'SHORT · close < VWAP − σ',          pass: s_vwapOK,   note: `close ${curr.c?.toFixed(2)} vs band ${(daily_vwap - CFG.s_sdvMult*vwap_stdev)?.toFixed(2)}` },
      { name: `SHORT · zone body % < ${CFG.s_outsideThresh}`, pass: s_zoneOK, note: `${s_zone.pct.toFixed(1)}% inside green zone` },
      { name: 'SHORT · SMA touch + bearish reject', pass: s_touchAny, note: `body ${barBody.toFixed(3)} vs ATR×${CFG.s_body_atr} ${(atr14*CFG.s_body_atr).toFixed(3)}` },
    ],
  };
}

module.exports = { evaluate, debug };
