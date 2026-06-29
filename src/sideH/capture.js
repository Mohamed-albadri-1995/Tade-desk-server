const db = require('../db');
const { toETDate } = require('../utils/time');
const { fetchIntradayBars, fetchDailyBars, computeATR14 } = require('../alpaca/client');

const ENTRY_TIME_A = '09:37';
const ENTRY_TIME_B = '09:40';

// Batch tickers into chunks to stay within Alpaca query-string limits
function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function captureR3(date) {
  const today = date || toETDate(Date.now());

  // Pre-flight: verify R1 ran today
  const r1Count = db.prepare('SELECT COUNT(*) as n FROM r1_frozen WHERE date = ?').get(today).n;
  if (r1Count === 0) {
    console.warn('[SideH] R1 not populated for', today, '— skipping R3 capture');
    return { skipped: true, reason: 'R1 not populated for today', tickers: 0 };
  }

  // Read tickers from R1
  const tickers = db.prepare('SELECT ticker FROM r1_frozen WHERE date = ?')
    .all(today)
    .map(r => r.ticker);

  if (tickers.length === 0) {
    return { skipped: true, reason: 'R1 is empty for today', tickers: 0 };
  }

  console.log('[SideH] Fetching R3 data for', tickers.length, 'tickers from R1');

  // Fetch intraday 1-min bars (chunks of 100 to stay safe on URL length)
  const intradayMap = {};
  for (const batch of chunk(tickers, 100)) {
    const data = await fetchIntradayBars(batch, today);
    Object.assign(intradayMap, data);
  }

  // Fetch daily bars excluding today (chunks of 100)
  const dailyMap = {};
  for (const batch of chunk(tickers, 100)) {
    const data = await fetchDailyBars(batch, today);
    Object.assign(dailyMap, data);
  }

  const capturedAt = Date.now();
  let r3aWritten = 0;
  let r3bWritten = 0;
  let noEntryA = 0;
  let noEntryB = 0;

  const insertR3A = db.prepare(`
    INSERT OR REPLACE INTO r3a (date, ticker, entry_price_a, hh_a, ll_a, atr14, up_r_a, down_r_a, captured_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertR3B = db.prepare(`
    INSERT OR REPLACE INTO r3b (date, ticker, entry_price_b, hh_b, ll_b, atr14, up_r_b, down_r_b, captured_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const writeAll = db.transaction((tickers) => {
    for (const ticker of tickers) {
      const bars = intradayMap[ticker] || [];
      const dailyBars = dailyMap[ticker] || [];
      const atr14 = computeATR14(dailyBars);

      // R3A — Target Entry at 09:37
      const barA = bars.find(b => b.etTime === ENTRY_TIME_A);
      if (barA) {
        const entryA = barA.o;
        const barsFromA = bars.filter(b => b.etTime >= ENTRY_TIME_A);
        const hhA = barsFromA.length ? Math.max(...barsFromA.map(b => b.h)) : null;
        const llA = barsFromA.length ? Math.min(...barsFromA.map(b => b.l)) : null;
        const upRA = (atr14 && hhA !== null) ? (hhA - entryA) / atr14 : null;
        const downRA = (atr14 && llA !== null) ? (entryA - llA) / atr14 : null;
        insertR3A.run(today, ticker, entryA, hhA, llA, atr14, upRA, downRA, capturedAt);
        r3aWritten++;
      } else {
        noEntryA++;
      }

      // R3B — Alternative Entry at 09:40
      const barB = bars.find(b => b.etTime === ENTRY_TIME_B);
      if (barB) {
        const entryB = barB.o;
        const barsFromB = bars.filter(b => b.etTime >= ENTRY_TIME_B);
        const hhB = barsFromB.length ? Math.max(...barsFromB.map(b => b.h)) : null;
        const llB = barsFromB.length ? Math.min(...barsFromB.map(b => b.l)) : null;
        const upRB = (atr14 && hhB !== null) ? (hhB - entryB) / atr14 : null;
        const downRB = (atr14 && llB !== null) ? (entryB - llB) / atr14 : null;
        insertR3B.run(today, ticker, entryB, hhB, llB, atr14, upRB, downRB, capturedAt);
        r3bWritten++;
      } else {
        noEntryB++;
      }
    }
  });

  writeAll(tickers);

  if (noEntryA > 0) console.warn('[SideH] R3A: missing 09:37 bar for', noEntryA, 'ticker(s)');
  if (noEntryB > 0) console.warn('[SideH] R3B: missing 09:40 bar for', noEntryB, 'ticker(s)');

  console.log('[SideH] R3 capture complete — R3A:', r3aWritten, 'R3B:', r3bWritten);
  return { skipped: false, tickers: tickers.length, r3aWritten, r3bWritten, noEntryA, noEntryB };
}

module.exports = { captureR3 };
