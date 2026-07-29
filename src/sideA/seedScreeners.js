/*
 * Seed a tool's screeners on first start.
 *
 * Runs only when the table is empty, so it never overwrites screeners the
 * trader has edited. Which set is seeded depends on TOOL_ID, so a new tool
 * comes up with a sensible starting point rather than a blank screen — every
 * one of them is editable in the builder afterwards.
 *
 * T1's three are copied verbatim from the original hardcoded SCANNERS, so the
 * existing tool behaves exactly as before after the move to database-backed
 * definitions.
 */

const db = require('../db');
const config = require('../config');
const store = require('./screenerStore');

// The original hardcoded scanners — unchanged, so T1's results do not move.
const T1 = [
  {
    key: 'trend', name: 'Trend',
    sort: { sortBy: 'change', sortOrder: 'desc' },
    filters: [
      { left: 'close', operation: 'egreater', right: 20 },
      { left: 'close', operation: 'egreater', right: 'SMA5' },
      { left: 'close', operation: 'egreater', right: 'VWAP' },
      { left: 'close|1W', operation: 'greater', right: 'VWAP|1W' },
      { left: 'close|1M', operation: 'greater', right: 'VWAP|1M' },
      { left: 'EMA50|1', operation: 'greater', right: 'EMA120|1' },
      { left: 'close|1', operation: 'egreater', right: 'EMA50|1' },
      { left: 'average_volume_90d_calc', operation: 'greater', right: 1000000 },
      { left: 'VWAP', operation: 'egreater', right: 'SMA75|5' },
      { left: 'relative_volume_intraday|5', operation: 'greater', right: 3 },
      { left: 'relative_volume_10d_calc', operation: 'greater', right: 1.5 },
      { left: 'close', operation: 'egreater', right: 1 },
    ],
  },
  {
    key: 'premarket', name: 'Pre-Mkt',
    sort: { sortBy: 'premarket_volume', sortOrder: 'desc' },
    filters: [
      { left: 'close', operation: 'egreater', right: 0.5 },
      { left: 'close', operation: 'egreater', right: 1 },
      { left: 'average_volume_10d_calc', operation: 'greater', right: 2000000 },
      { left: 'relative_volume_10d_calc', operation: 'greater', right: 3 },
      { left: 'premarket_volume', operation: 'greater', right: 1500000 },
    ],
  },
  {
    key: 'bigmoves', name: 'Big Move',
    sort: { sortBy: 'relative_volume_10d_calc', sortOrder: 'desc' },
    filters: [
      { left: 'relative_volume_10d_calc', operation: 'greater', right: 10 },
      { left: 'close', operation: 'egreater', right: 2 },
      { left: 'average_volume_10d_calc', operation: 'greater', right: 2000000 },
    ],
  },
];

// Daily moving averages stacked fast-over-slow, with price breaking the
// 1-month high — the trend-continuation screener described for tool 2.
const T2 = [
  {
    key: 'ma-stack-breakout', name: 'MA Stack Breakout',
    sort: { sortBy: 'relative_volume_10d_calc', sortOrder: 'desc' },
    filters: [
      { left: 'SMA5|1', operation: 'greater', right: 'EMA9|1' },
      { left: 'EMA9|1', operation: 'greater', right: 'EMA13|1' },
      { left: 'EMA13|1', operation: 'greater', right: 'EMA20|1' },
      { left: 'close', operation: 'egreater', right: 'High.1M' },
      { left: 'close', operation: 'egreater', right: 1 },
      { left: 'average_volume_10d_calc', operation: 'greater', right: 500000 },
    ],
  },
  {
    key: 'ma-stack-pullback', name: 'MA Stack Pullback',
    sort: { sortBy: 'change', sortOrder: 'desc' },
    filters: [
      { left: 'SMA5|1', operation: 'greater', right: 'EMA9|1' },
      { left: 'EMA9|1', operation: 'greater', right: 'EMA13|1' },
      { left: 'EMA13|1', operation: 'greater', right: 'EMA20|1' },
      { left: 'close', operation: 'less', right: 'High.1M' },
      { left: 'close', operation: 'egreater', right: 'EMA9|1' },
      { left: 'relative_volume_10d_calc', operation: 'greater', right: 1.5 },
      { left: 'close', operation: 'egreater', right: 1 },
    ],
  },
];

// A starting point for tool 3 — deliberately different from the other two so
// its model learns a separate population. Edit freely in the builder.
const T3 = [
  {
    key: 'gap-and-volume', name: 'Gap + Volume',
    sort: { sortBy: 'premarket_change', sortOrder: 'desc' },
    filters: [
      { left: 'premarket_change', operation: 'greater', right: 5 },
      { left: 'premarket_volume', operation: 'greater', right: 500000 },
      { left: 'relative_volume_10d_calc', operation: 'greater', right: 2 },
      { left: 'close', operation: 'egreater', right: 1 },
      { left: 'float_shares_outstanding', operation: 'less', right: 50000000 },
    ],
  },
];

const BY_TOOL = { T1, T2, T3 };

function seedScreeners() {
  const count = db.prepare('SELECT COUNT(*) AS n FROM screeners').get().n;
  if (count > 0) return { seeded: 0, reason: 'already has screeners' };

  const defs = BY_TOOL[config.toolId] || T1;
  let seeded = 0;
  for (const def of defs) {
    try {
      store.create(def);
      seeded++;
    } catch (err) {
      console.warn(`[Screeners] could not seed "${def.name}": ${err.message}`);
    }
  }
  console.log(`[Screeners] seeded ${seeded} screener(s) for ${config.toolId}`);
  return { seeded };
}

module.exports = { seedScreeners, PRESETS: BY_TOOL };
