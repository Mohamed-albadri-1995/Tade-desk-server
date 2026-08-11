const { computeRelations } = require('./relations');

/**
 * Where price sits inside a high/low pair, 0 = on the low, 100 = on the high.
 *
 * Returns null rather than a number when the range cannot be read — a missing
 * end, or a high that is not above the low. The month version used to return 0
 * for a flat range, which reads as "sitting on its low" and is a claim the data
 * does not support; the card now draws no bar at all instead. Kept for
 * monthRangePos too, except that one still answers 0, because it is a stored
 * register field the model trains on and changing what it means mid-run would
 * silently split the training set in two.
 */
function rangePos(price, low, high) {
  if (price == null || low == null || high == null) return null;
  if (!(high > low)) return null;
  return ((price - low) / (high - low)) * 100;
}

function computeDerivedFields(stock) {
  const { price, change, open, pmHigh, pmLow, atr, monthHigh, monthLow } = stock;

  const prevClose = price / (1 + change / 100);
  const gapPct = ((open - prevClose) / prevClose) * 100;
  const pmRange = pmHigh - pmLow;
  const adrPct = (atr / price) * 100;
  const monthRangePos =
    monthHigh !== monthLow
      ? ((price - monthLow) / (monthHigh - monthLow)) * 100
      : 0;
  const pmAdrRatio = atr !== 0 ? pmRange / atr : 0;

  return {
    ...stock,
    prevClose,
    gapPct,
    pmRange,
    adrPct,
    monthRangePos,
    // The other ranges are display-only, so they are free to say "unknown".
    weekRangePos: rangePos(price, stock.weekLow, stock.weekHigh),
    quarterRangePos: rangePos(price, stock.quarterLow, stock.quarterHigh),
    yearRangePos: rangePos(price, stock.yearLow, stock.yearHigh),
    pmAdrRatio,
  };
}

// Relations read prevClose / monthRangePos / pmAdrRatio, so they must run
// after computeDerivedFields has produced them.
function applyDerivedFields(rows) {
  return rows.map(row => {
    const stock = computeDerivedFields(row.stock);
    return { ...row, stock, signals: computeRelations(stock) };
  });
}

module.exports = { computeDerivedFields, applyDerivedFields, rangePos };
