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

/**
 * Record when each screener first matched this ticker.
 *
 * `firstSeen` alone says when the stock entered the tool, which is not the same
 * question. A stock can arrive at 08:00 from a pre-market screener and only
 * match the after-open one at 15:00 — and a trader who stops opening momentum
 * positions at 10:00 needs to see that the second sighting is an afternoon
 * candidate, not something that was on the list all morning. Times are stamped
 * once per screener and never moved, so the card can state the truth about when
 * each match actually became available.
 */
function stampSeen(seenAt, keys, now) {
  const next = { ...(seenAt || {}) };
  for (const key of keys || []) {
    if (!next[key]) next[key] = now;
  }
  return next;
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
        seenAt: stampSeen(existing.seenAt, row.screenerKeys || existing.screenerKeys, now),
        lastUpdated: now,
        liveNow: true,
        date: toETDate(now),
        inShortlist: existing.inShortlist || false,
      });
    } else {
      store.set(row.ticker, {
        id: uuidv4(),
        firstSeen: now,
        seenAt: stampSeen(null, row.screenerKeys, now),
        lastUpdated: now,
        liveNow: true,
        date: toETDate(now),
        inShortlist: false,
        bias: 'auto',
        news: null,
        catalyst: null,
        signals: {},
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
    // Catalyst is the strongest auto-bias input, so resolve it here where
    // both catalyst and context are known. Stored as the pure-auto answer
    // (manual bias forced aside) so the AUTO button label stays correct even
    // if the trader toggles manual bias on and off between news refreshes.
    const { resolveAutoBias } = require('../sideC/bias');
    row.autoBias = resolveAutoBias({ ...row, bias: 'auto' });
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

function updateBias(ticker, bias) {
  const row = store.get(ticker);
  if (!row) return false;
  row.bias = bias;
  row.lastUpdated = Date.now();
  return true;
}

function clearAll() {
  store.clear();
}

function serialize() {
  return Array.from(store.values());
}

function restore(rows) {
  store.clear();
  for (const row of rows) {
    store.set(row.ticker, row);
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
  clearAll,
  serialize,
  restore,
  updateNews,
  updateScore,
  updateContext,
  updateBias,
  getTodayRows,
};
