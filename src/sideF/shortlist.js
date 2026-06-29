const db = require('../db');
const r0 = require('../r0/registry');
const { toETDate } = require('../utils/time');

function getSetting(key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? parseFloat(row.value) : null;
}

function getShortlistEntry(date) {
  const row = db.prepare('SELECT * FROM shortlist WHERE date = ?').get(date);
  if (!row) return null;
  return {
    date: row.date,
    items: JSON.parse(row.items),
    exported: row.exported === 1,
    exportedAt: row.exported_at,
  };
}

function saveShortlistEntry(entry) {
  db.prepare(`
    INSERT OR REPLACE INTO shortlist (date, items, exported, exported_at)
    VALUES (?, ?, ?, ?)
  `).run(
    entry.date,
    JSON.stringify(entry.items),
    entry.exported ? 1 : 0,
    entry.exportedAt || null
  );
}

function runAutoRule() {
  const today = toETDate(Date.now());

  const existing = getShortlistEntry(today);
  if (existing) {
    console.log('[Shortlist] Auto rule: entry already exists for', today);
    return null;
  }

  const minScore = getSetting('shortlistMinScore') ?? 70;
  const topN = getSetting('shortlistTopN') ?? 5;

  const eligible = r0.getTodayRows()
    .filter(row => row._score != null && row._score >= minScore)
    .sort((a, b) => b._score - a._score)
    .slice(0, topN);

  if (eligible.length === 0) {
    console.log('[Shortlist] Auto rule: no eligible stocks today');
    return null;
  }

  const now = Date.now();
  const items = eligible.map(row => ({
    ticker: row.ticker,
    addedAt: now,
    method: 'auto',
    score: row._score,
    price: row.stock?.price ?? null,
    change: row.stock?.change ?? null,
    sector: row.stock?.sector ?? null,
  }));

  const entry = { date: today, items, exported: false, exportedAt: null };
  saveShortlistEntry(entry);

  for (const item of items) {
    r0.setInShortlist(item.ticker, true);
  }

  console.log('[Shortlist] Auto rule: created entry for', today, 'with', items.length, 'tickers');
  return entry;
}

function toggleTicker(ticker) {
  const today = toETDate(Date.now());
  let entry = getShortlistEntry(today);
  if (!entry) {
    entry = { date: today, items: [], exported: false, exportedAt: null };
  }

  const idx = entry.items.findIndex(i => i.ticker === ticker);
  if (idx !== -1) {
    entry.items.splice(idx, 1);
    r0.setInShortlist(ticker, false);
    saveShortlistEntry(entry);
    return { action: 'removed', ticker, entry };
  } else {
    const row = r0.getRow(ticker);
    const now = Date.now();
    entry.items.push({
      ticker,
      addedAt: now,
      method: 'manual',
      score: row?._score ?? null,
      price: row?.stock?.price ?? null,
      change: row?.stock?.change ?? null,
      sector: row?.stock?.sector ?? null,
    });
    r0.setInShortlist(ticker, true);
    saveShortlistEntry(entry);
    return { action: 'added', ticker, entry };
  }
}

function getTodayShortlist() {
  return getShortlistEntry(toETDate(Date.now()));
}

function getAllShortlists() {
  const rows = db.prepare('SELECT * FROM shortlist ORDER BY date DESC').all();
  return rows.map(row => ({
    date: row.date,
    items: JSON.parse(row.items),
    exported: row.exported === 1,
    exportedAt: row.exported_at,
  }));
}

function exportShortlist(date) {
  const entry = getShortlistEntry(date);
  if (!entry) return null;
  const tickers = entry.items.map(i => i.ticker).join(',');
  // Mark exported
  entry.exported = true;
  entry.exportedAt = Date.now();
  saveShortlistEntry(entry);
  return tickers;
}

module.exports = { runAutoRule, toggleTicker, getTodayShortlist, getAllShortlists, exportShortlist };
