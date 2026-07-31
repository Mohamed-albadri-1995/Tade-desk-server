const axios = require('axios');
const { mapTVRow, COMMON_COLUMNS } = require('../sideA/tvScanner');
const { computeDerivedFields } = require('../sideB/calculations');
const { computeRelations } = require('../sideB/relations');
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
    results.push(...rawRows.map(mapTVRow).filter(r => r.ticker));
  }
  return results;
}

/**
 * Re-quote rows in r0 and recompute everything derived from price.
 *
 * `all` decides the target. Inside a scan only the stale rows need it — the
 * live ones were just written from fresh scanner data. Outside a scan there is
 * no such distinction: every card on screen is as old as the last scan, and
 * with the run windows a tool can go hours between scans while the trader is
 * still watching the cards. That is what `all` is for.
 */
async function refreshInR0({ all = false } = {}) {
  const today = require('../utils/time').toETDate(Date.now());
  const staleRows = r0.getAll().filter(r => (all || !r.liveNow) && r.date === today);

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
    // Update stock fields + recompute derived fields; preserve everything else.
    // A card stops appearing in scanner results once its screener's run window
    // closes, but it stays on screen and must keep tracking the market — so the
    // relational signals are recomputed here too. Without this the price would
    // move all day while the tags still described the morning.
    existing.stock = computeDerivedFields(freshRow.stock);
    existing.signals = computeRelations(existing.stock);
    existing.lastUpdated = Date.now();
    refreshed++;
  }

  console.log(`[SideG] Refreshed ${refreshed}/${staleRows.length} ${all ? '' : 'stale '}tickers (${noSymbol} skipped — no tvSymbol)`);
  return { staleCount: staleRows.length, noSymbol, refreshed };
}

const refreshStaleInR0 = () => refreshInR0({ all: false });
const refreshAllInR0 = () => refreshInR0({ all: true });

module.exports = { refreshInR0, refreshStaleInR0, refreshAllInR0 };
