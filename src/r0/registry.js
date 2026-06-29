const { v4: uuidv4 } = require('uuid');
const { toETDate } = require('../utils/time');

// In-memory r0 store: Map<ticker, row>
const store = new Map();

function getAll() {
  return Array.from(store.values());
}

function getRow(ticker) {
  return store.get(ticker) || null;
}

function upsertRows(rows) {
  const now = Date.now();
  for (const row of rows) {
    const existing = store.get(row.ticker);
    if (existing) {
      store.set(row.ticker, {
        ...existing,
        ...row,
        id: existing.id,
        firstSeen: existing.firstSeen,
        lastUpdated: now,
        liveNow: true,
        date: toETDate(now),
        inShortlist: existing.inShortlist || false,
      });
    } else {
      store.set(row.ticker, {
        id: uuidv4(),
        firstSeen: now,
        lastUpdated: now,
        liveNow: true,
        date: toETDate(now),
        inShortlist: false,
        news: null,
        catalyst: null,
        score_at_entry: null,
        score_model_ts: null,
        _score: null,
        context: {},
        ...row,
      });
    }
  }
}

function setInShortlist(ticker, value) {
  const row = store.get(ticker);
  if (row) {
    row.inShortlist = value;
  }
}

function markAllStale() {
  for (const row of store.values()) {
    row.liveNow = false;
  }
}

function updateNews(ticker, news, catalyst) {
  const row = store.get(ticker);
  if (row) {
    row.news = news;
    row.catalyst = catalyst;
    row.lastUpdated = Date.now();
  }
}

function updateScore(ticker, score) {
  const row = store.get(ticker);
  if (row) {
    row._score = score;
    row.lastUpdated = Date.now();
  }
}

function updateContext(ticker, context) {
  const row = store.get(ticker);
  if (row) {
    row.context = { ...row.context, ...context };
    row.lastUpdated = Date.now();
  }
}

function getTodayRows() {
  const today = toETDate(Date.now());
  return getAll().filter(r => r.date === today);
}

module.exports = {
  getAll,
  getRow,
  upsertRows,
  setInShortlist,
  markAllStale,
  updateNews,
  updateScore,
  updateContext,
  getTodayRows,
};
