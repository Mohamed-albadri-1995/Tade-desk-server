/*
 * symbol → sector and industry, accumulated as the tools scan.
 *
 * WHY THIS EXISTS, AND WHY IT FLOWS THIS DIRECTION.
 *
 * qp has prices for the whole US market — Polygon's grouped-daily endpoint,
 * every ticker, every session — and NO industry labels at all. The screener
 * tools have the opposite: an industry string on every card they render, from
 * the TradingView scanner, for a few hundred names a day.
 *
 * Group ranking needs both. So the labels flow up: every scan records what it
 * saw, into one shared file, and qp ranks groups against the full-universe RS
 * it already computes. Nothing extra is fetched; the tools were already being
 * told this on every row and were throwing it away.
 *
 * WHY IT ONLY GROWS. A stock's industry does not change with the market, and a
 * name that has not turned up in a scan for a month has not left its industry.
 * Dropping entries would shrink the ranking universe every quiet week and make
 * every group rank jump for reasons that have nothing to do with the groups.
 * Entries carry `seen` so a stale one is visible rather than silently equal to
 * a fresh one.
 *
 * SAME CONTRACT AS canslim-members.json: one file next to the databases, all
 * nine tools write it, and a failure to read or write is silence — never a
 * failed scan. A group rank that does not appear costs a line on a card; a
 * scan that dies costs the morning.
 */

const fs = require('fs');
const path = require('path');
const config = require('../config');

const FILE = process.env.INDUSTRY_MAP_FILE
  || path.join(path.dirname(config.dbPath), 'industry-map.json');

// Nine processes write this file. Each read-modify-write is small and they are
// not coordinated, so a lost update is possible — and it is the right trade:
// the loser's symbols are re-recorded on its next scan, minutes later, and the
// alternative is a lock nine tools contend for on every scan. The file only
// grows, so a lost update delays an entry rather than corrupting one.
function read() {
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return (raw && typeof raw === 'object' && raw.symbols) ? raw : { symbols: {} };
  } catch {
    return { symbols: {} };
  }
}

/**
 * Record what a scan saw. Rows are r0-shaped: { ticker, stock: { sector, industry } }.
 *
 * Returns how many entries were added or changed, so a caller can log
 * something meaningful rather than "wrote the file".
 */
function record(rows, now = Date.now()) {
  try {
    const state = read();
    const symbols = state.symbols || {};
    let changed = 0;
    for (const r of rows || []) {
      const t = String(r && (r.ticker || r.symbol) || '').toUpperCase();
      if (!t) continue;
      const s = (r.stock || r) || {};
      const industry = (s.industry || '').trim();
      const sector = (s.sector || '').trim();
      if (!industry && !sector) continue;
      const prev = symbols[t];
      // An industry that has actually changed is worth taking — a
      // reclassification is real — but re-writing the file because the same
      // label arrived again is not.
      if (!prev || prev.industry !== industry || prev.sector !== sector) {
        symbols[t] = { sector, industry, first: (prev && prev.first) || now, seen: now };
        changed++;
      } else if (now - (prev.seen || 0) > 24 * 3600 * 1000) {
        prev.seen = now;                 // freshness, at most once a day
        changed++;
      }
    }
    if (!changed) return 0;
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    // Atomic, because qp reads this file on its own schedule and half a JSON
    // document is worse than an old one.
    const tmp = `${FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ updatedAt: now, symbols }));
    fs.renameSync(tmp, FILE);
    return changed;
  } catch {
    return 0;                            // never the reason a scan fails
  }
}

function stats() {
  const state = read();
  const symbols = state.symbols || {};
  const industries = new Set();
  for (const v of Object.values(symbols)) if (v.industry) industries.add(v.industry);
  return {
    file: FILE,
    symbols: Object.keys(symbols).length,
    industries: industries.size,
    updatedAt: state.updatedAt || null,
  };
}

module.exports = { read, record, stats, FILE };
