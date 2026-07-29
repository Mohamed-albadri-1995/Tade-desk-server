const { computeRelations } = require('./relations');

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

module.exports = { computeDerivedFields, applyDerivedFields };
