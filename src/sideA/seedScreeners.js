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
//
// T1 is the only tool with history: a month of cards, the model trained on
// them, and the one edge measured out of them so far — the overlap between
// "Big Move" and "Pre-Mkt", which wins 54% against 13% for everything else.
// That overlap is read off r1, frozen at 09:36. Giving Pre-Mkt the window its
// filters suggest (it is built on premarket_volume, which stops moving at the
// bell) would stop it running in the 09:30–09:36 scans and strip the Pre-Mkt
// tag off every frozen row — deleting the measurement rather than improving it.
// So T1 keeps running all day and stays the control the other six are compared
// against. The windows below start with T2.
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
// Daily moving averages stacked, breaking the monthly high. The stack is a
// DAILY reading — it barely moves intraday — so what the screener is really
// timing is the break. A break is not a break on pre-market liquidity, and one
// that happens in the last hour leaves no session to work with: RTH minus the
// closing hour.
const T2_BASE = {
  key: 'ma-stack-breakout', name: 'MA Stack Breakout',
  runFrom: '09:30', runTo: '15:00',
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

// Built on premarket_change and premarket_volume, which STOP MOVING once the
// bell goes — after the open they are yesterday's numbers, so left running all
// day this screener re-reports the same names until the close and none of it is
// news. It gets the pre-market plus the first hour, which is where a gap either
// continues or fails.
const T3_BASE = {
  key: 'gap-and-volume', name: 'Gap + Volume',
  runFrom: '04:00', runTo: '10:30',
  sort: { sortBy: 'premarket_change', sortOrder: 'desc' },
  filters: [
    { left: 'premarket_change', operation: 'greater', right: 5 },
    { left: 'premarket_volume', operation: 'greater', right: 500000 },
    { left: 'relative_volume_10d_calc', operation: 'greater', right: 2 },
    { left: 'close', operation: 'egreater', right: 1 },
    { left: 'float_shares_outstanding', operation: 'less', right: 50000000 },
  ],
};

// Price pushing back through VWAP with volume behind it — the "move first, then
// reverse" tool, so it is deliberately the one that stays awake into the
// afternoon. It starts at 09:45 rather than the bell because VWAP computed off
// the first few prints of the day is not yet a level anything is reclaiming,
// and stops at 15:30 because a reclaim in the last half hour has no session
// left to resolve in.
const T4_BASE = {
  key: 'vwap-reclaim', name: 'VWAP Reclaim',
  runFrom: '09:45', runTo: '15:30',
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
// Large caps clearing the 52-week high. These break on institutional flow,
// which arrives at any hour and often late in the day, so this one gets the
// whole regular session. Pre-market is excluded on purpose: a 52-week high
// printed on a handful of thin pre-market shares is not a break.
const T5_BASE = {
  key: '52w-break', name: '52-Week Break',
  runFrom: '09:30', runTo: '16:00',
  sort: { sortBy: 'change', sortOrder: 'desc' },
  filters: [
    { left: 'close', operation: 'egreater', right: 'price_52_week_high' },
    { left: 'market_cap_basic', operation: 'greater', right: 1000000000 },
    { left: 'relative_volume_10d_calc', operation: 'greater', right: 1.5 },
    { left: 'average_volume_10d_calc', operation: 'greater', right: 1000000 },
  ],
};

// Stretched on RSI with volume. Its mirror is the oversold side, so the pair
// asks directly whether extremes continue or revert. Extension is something the
// session BUILDS: at 09:30 RSI still describes yesterday, so the screener holds
// off until the move has had half an hour to make itself, then stays up to the
// close — a stock can be stretched at any hour, and the fade is the trade.
const T6_BASE = {
  key: 'overextended', name: 'Overextended',
  runFrom: '10:00', runTo: '16:00',
  sort: { sortBy: 'change', sortOrder: 'desc' },
  filters: [
    { left: 'RSI', operation: 'greater', right: 70 },
    { left: 'close', operation: 'egreater', right: 'EMA20' },
    { left: 'relative_volume_10d_calc', operation: 'greater', right: 3 },
    { left: 'close', operation: 'egreater', right: 1 },
    { left: 'average_volume_10d_calc', operation: 'greater', right: 1000000 },
  ],
};

// Two screeners split by session. Each carries the session it was designed for:
// the first only runs before the open, the second only after it — running
// either outside its session would collect rows describing a setup it never
// meant to test.
const PREMARKET_GAP = {
  key: 'premarket-gap', name: 'Pre-Market Gap',
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

const AFTER_OPEN_VOLUME = {
  key: 'after-open-volume', name: 'After Open Volume',
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
const T7 = [PREMARKET_GAP, AFTER_OPEN_VOLUME];

const BY_TOOL = { T1, T2, T3, T4, T5, T6, T7 };

// Available to add to any tool from the builder.
const SESSION_SCREENERS = [PREMARKET_GAP, AFTER_OPEN_VOLUME];

// T7's two screeners shipped under vendor-flavoured names ("FV Pre-Market")
// that described where the filters came from rather than what they look for.
// Renaming the seed alone would not reach a tool that has already started, so
// the old keys are rewritten in place at boot. Nothing is merged: the rename is
// skipped if the new key already exists, so a trader who built their own
// "Pre-Market Gap" keeps it.
const LEGACY_RENAMES = [
  { from: 'fv-premarket', to: 'premarket-gap', name: 'Pre-Market Gap' },
  { from: 'fv-after-open', to: 'after-open-volume', name: 'After Open Volume' },
];

function renameLegacyScreeners() {
  let renamed = 0;
  for (const r of LEGACY_RENAMES) {
    const old = db.prepare('SELECT id FROM screeners WHERE key = ?').get(r.from);
    if (!old) continue;
    const clash = db.prepare('SELECT id FROM screeners WHERE key = ?').get(r.to);
    if (clash) continue;
    db.prepare('UPDATE screeners SET key = ?, name = ? WHERE id = ?').run(r.to, r.name, old.id);
    console.log(`[Screeners] renamed "${r.from}" → "${r.to}"`);
    renamed++;
  }
  return { renamed };
}

// Run windows arrived after several tools had already been seeded without
// them, and seeding only ever runs on an empty table — so the tools that most
// need a window would have been the ones that never got one. This fills in the
// window a seeded screener was designed for, and only that:
//
//   - only screeners whose key matches one this tool seeds
//   - only where no window is set at all
//
// A trader who cleared a window, or set their own, keeps it. That does mean
// clearing a window on a seeded screener comes back after a restart; there is
// no way to tell "deliberately all day" from "never had one" without recording
// the choice, and coming back is the recoverable direction.
function applyDefaultWindows() {
  const defs = BY_TOOL[config.toolId] || [];
  let applied = 0;
  for (const def of defs) {
    if (!def.runFrom || !def.runTo) continue;
    const key = store.slugify(def.key || def.name);
    const row = db.prepare(
      'SELECT id, run_from, run_to FROM screeners WHERE key = ?'
    ).get(key);
    if (!row || row.run_from || row.run_to) continue;
    db.prepare('UPDATE screeners SET run_from = ?, run_to = ?, updated_at = ? WHERE id = ?')
      .run(def.runFrom, def.runTo, Date.now(), row.id);
    console.log(`[Screeners] "${key}" now runs ${def.runFrom}–${def.runTo} ET`);
    applied++;
  }
  return { applied };
}

// The oversold twin was generated before mirroring understood bounded
// oscillators, so it stored "RSI above 70 AND price below the 20-EMA" — a
// contradiction that matches almost nothing. Seeding cannot fix a tool that is
// already running, and a screener quietly returning nothing for a month looks
// exactly like a screener whose setup is rare. Rewritten only where the stored
// filters still carry that exact contradiction.
function repairOversoldMirror() {
  const row = db.prepare('SELECT id, filters FROM screeners WHERE key = ?').get('overextended-mirror');
  if (!row) return { repaired: 0 };
  let filters;
  try { filters = JSON.parse(row.filters); } catch { return { repaired: 0 }; }
  const broken = filters.some(f => f.left === 'RSI' && f.operation === 'greater' && Number(f.right) >= 50)
    && filters.some(f => f.left === 'close' && f.operation === 'eless' && f.right === 'EMA20');
  if (!broken) return { repaired: 0 };

  const fixed = store.mirrorDefinition(T6_BASE).filters;
  db.prepare('UPDATE screeners SET filters = ?, updated_at = ? WHERE id = ?')
    .run(JSON.stringify(fixed), Date.now(), row.id);
  console.log('[Screeners] repaired "overextended-mirror" — it asked for overbought AND below the 20-EMA');
  return { repaired: 1 };
}

function seedScreeners() {
  const count = db.prepare('SELECT COUNT(*) AS n FROM screeners').get().n;
  if (count > 0) {
    renameLegacyScreeners();
    applyDefaultWindows();
    repairOversoldMirror();
    return { seeded: 0, reason: 'already has screeners' };
  }

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

module.exports = {
  seedScreeners, renameLegacyScreeners, applyDefaultWindows, repairOversoldMirror,
  PRESETS: BY_TOOL, SESSION_SCREENERS,
};
