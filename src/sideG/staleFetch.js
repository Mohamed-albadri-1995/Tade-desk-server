const axios = require('axios');
const { mapTVRow, COMMON_COLUMNS } = require('../sideA/tvScanner');
const { computeDerivedFields } = require('../sideB/calculations');
const r0 = require('../r0/registry');

const TV_URL = 'https://scanner.tradingview.com/america/scan?label-product=screener-stock';
const TV_HEADERS = {
  'Content-Type': 'application/json',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Origin': 'https://www.tradingview.com',
  'Referer': 'https://www.tradingview.com/',
  'Accept': 'application/json',
  'Accept-Language': 'en-US,en;q=0.9',
};

const BATCH_SIZE = 200;

async function fetchStaleQuotes(tvSymbols) {
  const results = [];
  for (let i = 0; i < tvSymbols.length; i += BATCH_SIZE) {
    const batch = tvSymbols.slice(i, i + BATCH_SIZE);
    const body = {
      columns: COMMON_COLUMNS,
      symbols: { tickers: batch },
      range: [0, BATCH_SIZE],
      markets: ['america'],
      options: { lang: 'en' },
      ignore_unknown_fields: true,
    };
    const resp = await axios.post(TV_URL, body, { headers: TV_HEADERS, timeout: 15000 });
    const rawRows = resp.data.data || [];
    results.push(...rawRows.map(row => {
      try { return mapTVRow(row); } catch (e) { return { ticker: null }; }
    }).filter(r => r.ticker));
  }
  return results;
}

async function refreshStaleInR0() {
  const today = require('../utils/time').toETDate(Date.now());
  const staleRows = r0.getAll().filter(r => !r.liveNow && r.date === today);

  if (staleRows.length === 0) return { staleCount: 0, noSymbol: 0, refreshed: 0 };

  // tvSymbol is set by Side A (mapTVRow uses rawTV.s). Any stale row without it
  // came from a scan where Side A didn't populate the symbol — logged separately.
  const withSymbol = staleRows.filter(r => r.stock?.tvSymbol);
  const noSymbol = staleRows.length - withSymbol.length;

  if (noSymbol > 0) {
    const missing = staleRows.filter(r => !r.stock?.tvSymbol).map(r => r.ticker);
    console.warn(`[SideG] ${noSymbol} stale row(s) missing tvSymbol — cannot refresh: ${missing.join(', ')}`);
  }

  if (withSymbol.length === 0) return { staleCount: staleRows.length, noSymbol, refreshed: 0 };

  const tvSymbols = withSymbol.map(r => r.stock.tvSymbol);
  const fresh = await fetchStaleQuotes(tvSymbols);

  let refreshed = 0;
  for (const freshRow of fresh) {
    const existing = r0.getRow(freshRow.ticker);
    if (!existing) continue;
    // Update stock fields + recompute derived fields; preserve everything else
    existing.stock = computeDerivedFields(freshRow.stock);
    existing.lastUpdated = Date.now();
    refreshed++;
  }

  console.log(`[SideG] Refreshed ${refreshed}/${staleRows.length} stale tickers (${noSymbol} skipped — no tvSymbol)`);
  return { staleCount: staleRows.length, noSymbol, refreshed };
}

module.exports = { refreshStaleInR0 };
