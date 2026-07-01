/**
 * Test Indicator — simple workflow validation
 *
 * Fires a Long signal when:
 *   1. Current close > previous close (price moved up)
 *   2. Current volume > 0
 *
 * SL = previous candle low
 * TP = entry + 2 × (entry − SL)
 *
 * This is intentionally easy to trigger so you can verify
 * the full signal → alert → order flow without waiting for
 * real setup conditions.
 */

function evaluate(bars, pmHigh, ctx = {}) {
  if (!bars || bars.length < 2) return null;

  const prev = bars[bars.length - 2];
  const curr = bars[bars.length - 1];

  const priceUp   = curr.c > prev.c;
  const hasVolume = (curr.v || 0) > 0;

  if (!priceUp || !hasVolume) return null;

  const entry = curr.c;
  const sl    = prev.l;
  const risk  = entry - sl;
  if (risk <= 0) return null;
  const tp = entry + 2 * risk;

  return {
    direction: 'Long',
    entry:  parseFloat(entry.toFixed(4)),
    sl:     parseFloat(sl.toFixed(4)),
    tp:     parseFloat(tp.toFixed(4)),
    riskPerShare: parseFloat(risk.toFixed(4)),
    meta: { prevClose: prev.c, currClose: curr.c, prevLow: prev.l, barTime: curr.t },
  };
}

function debug(bars, pmHigh, ctx = {}) {
  if (!bars || bars.length < 2) {
    return { canRun: false, reason: `need 2+ bars, have ${bars?.length ?? 0}` };
  }
  const prev = bars[bars.length - 2];
  const curr = bars[bars.length - 1];
  return {
    canRun: true,
    conditions: [
      { name: 'Close > Prev Close', pass: curr.c > prev.c, note: `curr ${curr.c?.toFixed(2)} vs prev ${prev.c?.toFixed(2)}` },
      { name: 'Volume > 0',         pass: (curr.v || 0) > 0, note: `vol ${curr.v}` },
    ],
  };
}

module.exports = { evaluate, debug };
