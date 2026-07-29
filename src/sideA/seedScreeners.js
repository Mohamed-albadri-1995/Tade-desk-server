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

// Tools 2 and 3 each ship ONE screener plus its mirror — the same structural
// setup facing the other way. Pairing them is what makes a month of data
// answer "is this edge directional, or does this screener just find movers?".
// The mirror is generated rather than hand-written, so the pair cannot drift.
const T2_BASE = {
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
};

const T3_BASE = {
  key: 'gap-and-volume', name: 'Gap + Volume',
  sort: { sortBy: 'premarket_change', sortOrder: 'desc' },
  filters: [
    { left: 'premarket_change', operation: 'greater', right: 5 },
    { left: 'premarket_volume', operation: 'greater', right: 500000 },
    { left: 'relative_volume_10d_calc', operation: 'greater', right: 2 },
    { left: 'close', operation: 'egreater', right: 1 },
    { left: 'float_shares_outstanding', operation: 'less', right: 50000000 },
  ],
};

// Price pushing back through VWAP with volume behind it.
const T4_BASE = {
  key: 'vwap-reclaim', name: 'VWAP Reclaim',
  sort: { sortBy: 'relative_volume_10d_calc', sortOrder: 'desc' },
  filters: [
    { left: 'close', operation: 'crosses_above', right: 'VWAP' },
    { left: 'relative_volume_10d_calc', operation: 'greater', right: 2 },
    { left: 'close', operation: 'egreater', right: 1 },
    { left: 'average_volume_10d_calc', operation: 'greater', right: 1000000 },
  ],
};

// Deliberately the large-cap end of the market. Every other tool samples cheap
// small caps, which is what let share price dominate the factor model; this one
// gives that finding something to be tested against.
const T5_BASE = {
  key: '52w-break', name: '52-Week Break',
  sort: { sortBy: 'change', sortOrder: 'desc' },
  filters: [
    { left: 'close', operation: 'egreater', right: 'price_52_week_high' },
    { left: 'market_cap_basic', operation: 'greater', right: 1000000000 },
    { left: 'relative_volume_10d_calc', operation: 'greater', right: 1.5 },
    { left: 'average_volume_10d_calc', operation: 'greater', right: 1000000 },
  ],
};

// Stretched on RSI with volume. Its mirror is the oversold side, so the pair
// asks directly whether extremes continue or revert.
const T6_BASE = {
  key: 'overextended', name: 'Overextended',
  sort: { sortBy: 'change', sortOrder: 'desc' },
  filters: [
    { left: 'RSI', operation: 'greater', right: 70 },
    { left: 'close', operation: 'egreater', right: 'EMA20' },
    { left: 'relative_volume_10d_calc', operation: 'greater', right: 3 },
    { left: 'close', operation: 'egreater', right: 1 },
    { left: 'average_volume_10d_calc', operation: 'greater', right: 1000000 },
  ],
};

// The two Finviz screeners from the video, translated to TradingView fields.
// Each carries the session it was designed for: the first only runs before the
// open, the second only after it — running either outside its session would
// collect rows describing a setup it never meant to test.
const FINVIZ_PREMARKET = {
  key: 'fv-premarket', name: 'FV Pre-Market',
  runFrom: '04:00', runTo: '09:30',
  sort: { sortBy: 'premarket_change', sortOrder: 'desc' },
  filters: [
    // "gap up OR down 3%" — a single absolute-value rule is not expressible, so
    // it is stated as "outside -3%..+3%", which is the same set.
    { left: 'gap', operation: 'not_in_range', right: [-3, 3] },
    { left: 'ATR', operation: 'egreater', right: 1 },
    { left: 'average_volume_90d_calc', operation: 'egreater', right: 2000000 },
  ],
};

const FINVIZ_OPEN = {
  key: 'fv-after-open', name: 'FV After Open',
  runFrom: '09:30', runTo: '16:00',
  sort: { sortBy: 'relative_volume_10d_calc', sortOrder: 'desc' },
  filters: [
    { left: 'relative_volume_10d_calc', operation: 'greater', right: 3 },
    { left: 'volume', operation: 'greater', right: 10000000 },
    { left: 'close', operation: 'greater', right: 1 },
  ],
};

const pair = base => [base, store.mirrorDefinition(base)];

const T2 = pair(T2_BASE);
const T3 = pair(T3_BASE);
const T4 = pair(T4_BASE);
const T5 = pair(T5_BASE);
const T6 = pair(T6_BASE);

// T7 runs the two session-bound screeners. They are NOT mirrored: each is a
// complete setup for its own session, and the sessions do not overlap, so a
// stock lands in one or the other rather than both.
const T7 = [FINVIZ_PREMARKET, FINVIZ_OPEN];

const BY_TOOL = { T1, T2, T3, T4, T5, T6, T7 };

// Available to add to any tool from the builder.
const FINVIZ = [FINVIZ_PREMARKET, FINVIZ_OPEN];

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

module.exports = { seedScreeners, PRESETS: BY_TOOL, FINVIZ };
