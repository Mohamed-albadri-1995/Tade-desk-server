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

function applyDerivedFields(rows) {
  return rows.map(row => ({
    ...row,
    stock: computeDerivedFields(row.stock),
  }));
}

module.exports = { computeDerivedFields, applyDerivedFields };
