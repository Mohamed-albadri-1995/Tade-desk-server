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

  // Every write to this tool's shortlist goes through here — the auto rule, a
  // manual toggle, an export — so this one line is what keeps the unified list
  // across all tools current without any of them opting in. Non-fatal: a tool
  // that cannot publish still has its own shortlist.
  try {
    require('./globalShortlist').publish(entry.date, entry.items);
  } catch (err) {
    console.warn('[Shortlist] could not publish to the unified list:', err.message);
  }
}

function runAutoRule({ force = false } = {}) {
  const today = toETDate(Date.now());

  // Scheduled cron: skip if an auto entry already exists today.
  // Manual trigger (force=true): always re-run, merging auto picks into any existing entry.
  if (!force) {
    const existing = getShortlistEntry(today);
    if (existing && existing.items.some(i => i.method === 'auto')) {
      console.log('[Shortlist] Auto rule: auto entry already exists for', today);
      return null;
    }
  }

  const minScore = getSetting('shortlistMinScore') ?? 70;
  const topN = getSetting('shortlistTopN') ?? 5;

  const eligible = r0.getTodayRows()
    .filter(row => row._score != null && row._score >= minScore)
    .sort((a, b) => b._score - a._score)
    .slice(0, topN);

  if (eligible.length === 0) {
    console.log('[Shortlist] Auto rule: no eligible stocks (minScore=' + minScore + ', rows=' + r0.getTodayRows().length + ')');
    return null;
  }

  const now = Date.now();
  // Load existing entry so manual picks are preserved
  const existing = getShortlistEntry(today);
  const manualItems = existing ? existing.items.filter(i => i.method !== 'auto') : [];

  const autoItems = eligible.map(row => ({
    ticker: row.ticker,
    tvSymbol: row.stock?.tvSymbol ?? null,
    addedAt: now,
    method: 'auto',
    score: row._score,
    price: row.stock?.price ?? null,
    change: row.stock?.change ?? null,
    sector: row.stock?.sector ?? null,
  }));

  const entry = {
    date: today,
    items: [...manualItems, ...autoItems],
    exported: existing?.exported || false,
    exportedAt: existing?.exportedAt || null,
  };
  saveShortlistEntry(entry);

  for (const item of autoItems) {
    r0.setInShortlist(item.ticker, true);
  }

  console.log('[Shortlist] Auto rule: saved', autoItems.length, 'auto picks for', today);
  return entry;
}

function toggleTicker(ticker, date) {
  const targetDate = date || toETDate(Date.now());
  let entry = getShortlistEntry(targetDate);
  if (!entry) {
    entry = { date: targetDate, items: [], exported: false, exportedAt: null };
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
      tvSymbol: row?.stock?.tvSymbol ?? null,
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

function syncShortlistToR0() {
  const today = toETDate(Date.now());
  const entry = getShortlistEntry(today);
  if (!entry) return;
  for (const item of entry.items) {
    r0.setInShortlist(item.ticker, true);
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
  // One symbol per line with exchange prefix for TradingView import
  const lines = entry.items.map(i => i.tvSymbol || i.ticker).join('\n');
  entry.exported = true;
  entry.exportedAt = Date.now();
  saveShortlistEntry(entry);
  return lines;
}

module.exports = { runAutoRule, toggleTicker, getTodayShortlist, getAllShortlists, exportShortlist, syncShortlistToR0 };
