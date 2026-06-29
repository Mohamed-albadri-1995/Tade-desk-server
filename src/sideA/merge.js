function mergeScannersIntoR0(scannerResults) {
  // Map<ticker, { stock, screenerKeys }>
  const map = new Map();

  const SCANNER_KEY_MAP = {
    trend: 'Trend',
    premarket: 'Pre-Mkt',
    bigmoves: 'Big Move',
  };

  for (const [scannerName, rows] of Object.entries(scannerResults)) {
    const key = SCANNER_KEY_MAP[scannerName] || scannerName;
    for (const row of rows) {
      const { ticker, stock } = row;
      if (!map.has(ticker)) {
        map.set(ticker, {
          ticker,
          stock: { ...stock },
          screenerKeys: [key],
        });
      } else {
        const existing = map.get(ticker);
        // Union screenerKeys
        if (!existing.screenerKeys.includes(key)) {
          existing.screenerKeys.push(key);
        }
        // Keep first non-null value for each stock field
        for (const [field, value] of Object.entries(stock)) {
          if (
            (existing.stock[field] === null ||
              existing.stock[field] === undefined) &&
            value !== null &&
            value !== undefined
          ) {
            existing.stock[field] = value;
          }
        }
      }
    }
  }

  return Array.from(map.values());
}

module.exports = { mergeScannersIntoR0 };
