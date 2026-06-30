/**
 * 13 MA Bounce Indicator Engine
 *
 * Long conditions (all must be true on the signal bar):
 *   1. Price above pre-market high
 *   2. Previous candle touched / bounced off EMA13 (low <= EMA13 * 1.003)
 *   3. Current candle closes above previous candle's high (breaks HH)
 *   4. EMA13 > EMA20 (aligned)
 *   5. Close > VWAP
 *
 * SL  : EMA20 of signal bar
 * TP  : entry + 2 × (entry − SL)  →  2R
 */

// ── EMA ───────────────────────────────────────────────────────────────────────

function calcEMA(bars, period, closeKey = 'c') {
  if (bars.length < period) return null;
  const k = 2 / (period + 1);
  let ema = bars.slice(0, period).reduce((s, b) => s + b[closeKey], 0) / period;
  for (let i = period; i < bars.length; i++) {
    ema = bars[i][closeKey] * k + ema * (1 - k);
  }
  return ema;
}

// ── VWAP (reset at 9:30 ET each day) ─────────────────────────────────────────

function calcVWAP(bars) {
  let cumPV = 0, cumV = 0;
  for (const b of bars) {
    const tp = (b.h + b.l + b.c) / 3;
    cumPV += tp * b.v;
    cumV  += b.v;
  }
  return cumV > 0 ? cumPV / cumV : null;
}

// ── Main evaluate — called each time new bars arrive ─────────────────────────

/**
 * @param {object[]} bars   - 1-min bars from 9:30 ET, [{t,o,h,l,c,v}], latest last
 * @param {number}   pmHigh - pre-market high from r0 (stock.pmHigh)
 * @returns {object|null}   - signal object or null
 */
function evaluate(bars, pmHigh) {
  // Need at least 22 bars (for EMA20) + 1 previous + 1 current = 23 minimum
  if (!bars || bars.length < 23) return null;

  const prev = bars[bars.length - 2];
  const curr = bars[bars.length - 1];

  // EMAs on full history up to and including current bar
  const ema13 = calcEMA(bars, 13);
  const ema20 = calcEMA(bars, 20);

  // EMA13 on bars up to prev (for the "touched EMA on prev candle" check)
  const ema13AtPrev = calcEMA(bars.slice(0, bars.length - 1), 13);

  if (!ema13 || !ema20 || !ema13AtPrev) return null;

  const vwap = calcVWAP(bars);
  if (!vwap) return null;

  // ── Conditions ──────────────────────────────────────────────────────────────
  const abovePMHigh   = pmHigh != null ? curr.c > pmHigh : true; // skip if no PM data
  const prevTouchedEMA = prev.l <= ema13AtPrev * 1.003;          // low came within 0.3% of EMA13
  const crossedPrevHH  = curr.c > prev.h;                        // close breaks prev candle high
  const emasAligned    = ema13 > ema20;                           // 13 above 20
  const aboveVWAP      = curr.c > vwap;

  if (!abovePMHigh || !prevTouchedEMA || !crossedPrevHH || !emasAligned || !aboveVWAP) {
    return null;
  }

  // ── Signal ──────────────────────────────────────────────────────────────────
  const entry = curr.c;           // entry at close of signal bar (market order next bar)
  const sl    = ema20;            // SL below 20 MA
  const risk  = entry - sl;
  const tp    = risk > 0 ? entry + 2 * risk : null;  // 2R TP

  if (risk <= 0 || !tp) return null;  // price already below SL — skip

  return {
    direction: 'Long',
    entry:     parseFloat(entry.toFixed(4)),
    sl:        parseFloat(sl.toFixed(4)),
    tp:        parseFloat(tp.toFixed(4)),
    riskPerShare: parseFloat(risk.toFixed(4)),
    meta: {
      ema13:       parseFloat(ema13.toFixed(4)),
      ema20:       parseFloat(ema20.toFixed(4)),
      vwap:        parseFloat(vwap.toFixed(4)),
      pmHigh:      pmHigh,
      prevCandleH: prev.h,
      barTime:     curr.t,
    },
  };
}

/**
 * Returns per-condition pass/fail detail for debugging (does not fire a signal).
 */
function debug(bars, pmHigh) {
  if (!bars || bars.length < 23) {
    return { canRun: false, reason: `need 23+ bars, have ${bars?.length ?? 0}` };
  }
  const prev = bars[bars.length - 2];
  const curr = bars[bars.length - 1];
  const ema13 = calcEMA(bars, 13);
  const ema20 = calcEMA(bars, 20);
  const ema13AtPrev = calcEMA(bars.slice(0, bars.length - 1), 13);
  const vwap = calcVWAP(bars);

  return {
    canRun: true,
    conditions: [
      { name: 'Price > PM High',          pass: pmHigh != null ? curr.c > pmHigh : null,  note: pmHigh != null ? `close ${curr.c?.toFixed(2)} vs pmHigh ${pmHigh?.toFixed(2)}` : 'no PM data (skip)' },
      { name: 'Prev low ≤ EMA13×1.003',   pass: ema13AtPrev != null ? prev.l <= ema13AtPrev * 1.003 : null, note: ema13AtPrev != null ? `prev.l ${prev.l?.toFixed(2)} vs EMA13 ${ema13AtPrev?.toFixed(2)}` : 'no EMA13' },
      { name: 'Close > Prev High (HH)',    pass: prev.h != null ? curr.c > prev.h : null,  note: `close ${curr.c?.toFixed(2)} vs prevH ${prev.h?.toFixed(2)}` },
      { name: 'EMA13 > EMA20 (aligned)',   pass: ema13 != null && ema20 != null ? ema13 > ema20 : null, note: ema13 != null ? `EMA13 ${ema13?.toFixed(2)} vs EMA20 ${ema20?.toFixed(2)}` : 'no EMAs' },
      { name: 'Close > VWAP',             pass: vwap != null ? curr.c > vwap : null,   note: vwap != null ? `close ${curr.c?.toFixed(2)} vs VWAP ${vwap?.toFixed(2)}` : 'no VWAP' },
    ],
  };
}

module.exports = { evaluate, debug };
