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

// CANSLIM — O'Neil's growth-stock criteria, as far as a screener can express
// them. Deliberately slow: a few names that stay interesting for months, not a
// daily hunt. Each letter, and what it can honestly be:
//
//   C  Current quarterly earnings up sharply → EPS growth, latest quarter YoY
//   A  Annual earnings growing              → EPS growth, last full year YoY
//   N  New high                             → at or through the 52-week high
//   S  Supply and demand                    → volume surge against a supply cap
//   L  Leader, not laggard                  → 6-month performance as an RS proxy
//   I  Institutional sponsorship            → NOT AVAILABLE, left out
//   M  Market in an uptrend                 → NOT a filter, see below
//
// I has no dependable screener column, so it is omitted rather than faked with
// something that merely sounds similar. M is a statement about the whole market
// rather than about a stock: the regime engine already stamps it on every card,
// and filtering on it here would only hide candidates on weak days — exactly
// the days worth recording for the comparison later.
//
// The L proxy is the weak link and worth being explicit about. O'Neil's RS
// Rating is a percentile rank against every other stock, which a screener
// cannot compute. Six-month performance is a plain threshold, so a strong
// market lets more names through and a weak one fewer. It measures strength,
// not leadership.
const CANSLIM_BASE = {
  key: 'canslim', name: 'CANSLIM',
  runFrom: '09:30', runTo: '16:00',
  limit: 50,
  sort: { sortBy: 'Perf.6M', sortOrder: 'desc' },
  filters: [
    // C — the current quarter
    { left: 'earnings_per_share_diluted_yoy_growth_fq', operation: 'egreater', right: 25 },
    // A — and not a one-quarter accident
    { left: 'earnings_per_share_diluted_yoy_growth_fy', operation: 'egreater', right: 25 },
    // sales behind the earnings, so the growth is not only cost-cutting
    { left: 'total_revenue_yoy_growth_fq', operation: 'egreater', right: 15 },
    // N — at or through the 52-week high
    { left: 'close', operation: 'egreater', right: 'price_52_week_high' },
    // L — leading, by the only measure available
    { left: 'Perf.6M', operation: 'greater', right: 30 },
    // S — demand showing up today, against a cap on supply
    { left: 'relative_volume_10d_calc', operation: 'greater', right: 1.5 },
    { left: 'total_shares_outstanding_fundamental', operation: 'less', right: 1000000000 },
    // institutions cannot buy what does not trade
    { left: 'market_cap_basic', operation: 'greater', right: 300000000 },
  ],
};

// The same company, still growing, pulling back to its 50-day rather than
// breaking out. O'Neil buys breakouts; the pullback is where the same name is
// usually cheaper. Kept as a second screener rather than a mirror — the mirror
// of a growth screener would be a collapsing company, which is not a setup this
// tool is for.
const CANSLIM_PULLBACK = {
  key: 'canslim-pullback', name: 'CANSLIM Pullback',
  runFrom: '09:30', runTo: '16:00',
  limit: 50,
  sort: { sortBy: 'Perf.6M', sortOrder: 'desc' },
  filters: [
    { left: 'earnings_per_share_diluted_yoy_growth_fq', operation: 'egreater', right: 25 },
    { left: 'earnings_per_share_diluted_yoy_growth_fy', operation: 'egreater', right: 25 },
    { left: 'Perf.6M', operation: 'greater', right: 30 },
    // still in the uptrend...
    { left: 'close', operation: 'egreater', right: 'SMA50' },
    // ...but back near the line rather than extended away from it
    { left: 'close', operation: 'eless', right: 'EMA20' },
    { left: 'market_cap_basic', operation: 'greater', right: 300000000 },
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
  limit: 25,
  filters: [
    // "gap up OR down 3%" — a single absolute-value rule is not expressible, so
    // it is stated as "outside -3%..+3%", which is the same set.
    { left: 'gap', operation: 'not_in_range', right: [-3, 3] },
    { left: 'ATR', operation: 'egreater', right: 1 },
    { left: 'average_volume_90d_calc', operation: 'egreater', right: 2000000 },
    // A gap with no pre-market trade behind it is a quote, not a move — it can
    // vanish at the bell. Average volume says the stock is normally liquid; it
    // says nothing about today. Same reasoning already applied in T3, at the
    // larger size this tool is for.
    { left: 'premarket_volume', operation: 'greater', right: 1000000 },
    // The one price floor in the research with published evidence behind it:
    // the 2024 ORB study used opening price > $5 to exclude penny-stock noise.
    { left: 'close', operation: 'greater', right: 5 },
  ],
};

const AFTER_OPEN_VOLUME = {
  key: 'after-open-volume', name: 'After Open Volume',
  runFrom: '09:30', runTo: '16:00',
  limit: 25,
  sort: { sortBy: 'relative_volume_10d_calc', sortOrder: 'desc' },
  filters: [
    { left: 'relative_volume_10d_calc', operation: 'greater', right: 4 },
    { left: 'volume', operation: 'greater', right: 10000000 },
    // The move itself. Its pre-market twin has always required a 3% gap; this
    // one asked only for volume, so on any ordinary day a hundred perfectly
    // liquid stocks that were going nowhere qualified. Volume without movement
    // is a description of a large company, not a candidate.
    //
    // Direction-agnostic, exactly like the gap rule it mirrors: "outside
    // -3%..+3%" is how an absolute value is written here.
    { left: 'change', operation: 'not_in_range', right: [-3, 3] },
    // Was $1, which is the whole reason this tool filled up. Ten million shares
    // of a $1.50 stock is fifteen million dollars — a penny-stock frenzy, not a
    // liquid mover. At $5 the same share count is fifty million dollars, and
    // the floor is the one the ORB study used to exclude exactly this noise.
    { left: 'close', operation: 'greater', right: 5 },
  ],
};

// Why each seeded screener runs when it does, in the trader's terms rather
// than the code's. Served to the Screeners tab so the schedule explains itself
// on screen — the reasoning is worth nothing sitting in a comment nobody with
// the tool open can read. Keyed by screener key; a screener the trader builds
// has no entry, which is correct — they chose its window.
const WINDOW_NOTES = {
  trend: 'No window. T1 is the control the other tools are compared against, so it is left exactly as it always ran.',
  premarket: 'No window, deliberately. Its filters say pre-market only, but the Big Move + Pre-Mkt overlap is read off the cards frozen at 09:36 — a window would stop it running in the 09:30–09:36 scans and delete that measurement.',
  bigmoves: 'No window. Relative volume means something at any hour, and T1 stays the control.',

  'ma-stack-breakout': 'Regular session only. The daily MA stack barely moves intraday, so what is really being timed is the break — and a break on pre-market liquidity is not a break. Stops at 15:00 because one in the last hour leaves no session to work with.',
  'gap-and-volume': 'Pre-market and the first hour. Built on premarket_change and premarket_volume, which stop moving at the bell — left running all day it would re-report the same names until the close and none of it would be new.',
  'vwap-reclaim': 'The one that stays awake into the afternoon, because a reclaim is a reversal and those come late. Starts at 09:45 rather than the bell: VWAP off the first few prints is not yet a level anything is reclaiming. Stops at 15:30, when a reclaim has no session left to resolve in.',
  '52w-break': 'The whole regular session. These break on institutional flow, which arrives at any hour and often late in the day. Pre-market is excluded on purpose — a 52-week high printed on a handful of thin shares is not a break.',
  overextended: 'Waits until 10:00. At the open RSI still describes yesterday; extension is something the session builds. Then runs to the close, because a stock can be stretched at any hour and the fade is the trade.',

  canslim: 'Regular session only. This is a months-long list rather than a daily hunt: the fundamental filters barely move intraday, and the new-high and volume conditions only mean something while the market is open.',
  'canslim-pullback': 'Regular session only, same reason as the breakout screener it accompanies.',

  'stocks-in-play': 'Regular session only, and the whole day of it. This is the benchmark every other screener is measured against, so it has to see the same market they do — narrowing its window would flatter or punish it for reasons that have nothing to do with the comparison.',

  'premarket-gap': 'Pre-market only, by definition — it is looking for the gap before the market opens on it.',
  'after-open-volume': 'Regular session only. It wants volume that has actually traded today, which does not exist before the bell.',
};

// A mirror runs in its base's window, so it inherits the reason too. Its key is
// whatever slugifying the mirror's NAME produces — "Gap + Volume (mirror)"
// becomes "gap-volume-mirror", not "gap-and-volume-mirror" — so the key comes
// from the definition rather than from appending a suffix by hand.
const pair = base => {
  const mirror = store.mirrorDefinition(base);
  const baseKey = store.slugify(base.key || base.name);
  const note = WINDOW_NOTES[baseKey];
  if (note) WINDOW_NOTES[store.slugify(mirror.key || mirror.name)] = note;
  return [base, mirror];
};

const T2 = pair(T2_BASE);
const T3 = pair(T3_BASE);
const T4 = pair(T4_BASE);
const T5 = pair(T5_BASE);
const T6 = pair(T6_BASE);

// T7 runs the two session-bound screeners. They are NOT mirrored: each is a
// complete setup for its own session, and the sessions do not overlap, so a
// stock lands in one or the other rather than both.
const T7 = [PREMARKET_GAP, AFTER_OPEN_VOLUME];

// T8 is the CANSLIM tool. Its matches are also written to a shared member list
// that every other tool reads, so a CANSLIM name turning up in an unrelated
// screener is tagged there — see canslim.js.
const T8 = [CANSLIM_BASE, CANSLIM_PULLBACK];

// T9 is the benchmark, and it is deliberately the dumbest screener here: liquid
// stocks over $5, ranked by how unusually active they are, top 20. No pattern,
// no direction, no structure — just "what is busy today".
//
// It exists to be beaten. Every other tool claims that some structure — a
// stacked moving average, a VWAP reclaim, a 52-week break — finds better movers
// than simply taking today's most active liquid names. Until now there was
// nothing plain to test that claim against, because every tool was clever.
//
// The one strong published day-trading result behind this: the edge came almost
// entirely from the relative-volume screen. Dropping it took the same strategy
// from a Sharpe of 2.81 to 0.48. So the plain list is not a straw man — it is a
// genuinely hard benchmark, which is exactly what makes it useful.
//
// The price floor is the study's own ($5, to exclude penny-stock noise);
// everything else it required — average volume and ATR minimums — the
// tradability floor already supplies to every screener.
const STOCKS_IN_PLAY = {
  key: 'stocks-in-play', name: 'Stocks in Play',
  runFrom: '09:30', runTo: '16:00',
  limit: 20,
  sort: { sortBy: 'relative_volume_10d_calc', sortOrder: 'desc' },
  filters: [
    { left: 'close', operation: 'greater', right: 5 },
  ],
};

// No mirror: there is no direction to flip. The screener does not say up or
// down, only "unusually active", so its opposite would be "quiet stocks" —
// which is not the other side of this setup, it is the absence of it.
const T9 = [STOCKS_IN_PLAY];

const BY_TOOL = { T1, T2, T3, T4, T5, T6, T7, T8, T9 };

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

// The after-open screener shipped asking only for volume, with no condition on
// the stock actually moving — its pre-market twin has always required a 3% gap.
// On an ordinary day that let through a hundred large, liquid, motionless
// names. Seeding cannot reach a tool that is already running, so the movement
// rule is added in place, and only to a screener still carrying the exact
// original filter set.
function tightenAfterOpenVolume() {
  const row = db.prepare('SELECT id, filters FROM screeners WHERE key = ?').get('after-open-volume');
  if (!row) return { tightened: 0 };
  let filters;
  try { filters = JSON.parse(row.filters); } catch { return { tightened: 0 }; }

  const hasMove = filters.some(f => /^(change|change_from_open|gap)$/.test(f.left));
  const isOriginal = filters.length === 3
    && filters.some(f => f.left === 'relative_volume_10d_calc' && Number(f.right) === 3)
    && filters.some(f => f.left === 'volume' && Number(f.right) === 10000000);
  if (hasMove || !isOriginal) return { tightened: 0 };

  db.prepare('UPDATE screeners SET filters = ?, updated_at = ? WHERE id = ?')
    .run(JSON.stringify(AFTER_OPEN_VOLUME.filters), Date.now(), row.id);
  console.log('[Screeners] "after-open-volume" now requires a 3% move, not just volume');
  return { tightened: 1 };
}

// T7 was returning 75 names for a tool called Liquid Movers, and the reason was
// a price floor of $1. Ten million shares of a $1.50 stock is fifteen million
// dollars — a penny-stock frenzy, not a liquid mover; at $5 the same share
// count is fifty million. $5 is also the one price floor in the research with
// published evidence behind it. Two more leaks alongside it: a gap screener
// with no requirement that anything traded in the pre-market, and a limit of
// fifty per screener when the evidence-backed recipe takes the top twenty.
//
// Rules are ADDED rather than the filter set replaced, so a screener the trader
// has tuned keeps its own numbers and only gains the floor it was missing.
const T7_TIGHTENING = {
  'premarket-gap': [
    { left: 'premarket_volume', operation: 'greater', right: 1000000 },
    { left: 'close', operation: 'greater', right: 5 },
  ],
  'after-open-volume': [
    { left: 'close', operation: 'greater', right: 5 },
  ],
};

function tightenLiquidMovers() {
  if (config.toolId !== 'T7') return { changed: 0 };
  let changed = 0;
  for (const [key, additions] of Object.entries(T7_TIGHTENING)) {
    const row = db.prepare('SELECT id, filters, limit_n FROM screeners WHERE key = ?').get(key);
    if (!row) continue;
    let filters;
    try { filters = JSON.parse(row.filters); } catch { continue; }

    let touched = false;
    for (const add of additions) {
      const existing = filters.find(f => f.left === add.left);
      if (!existing) {
        filters.push(add);
        touched = true;
        continue;
      }
      // A rule is already there. Raise it only when it is EXACTLY the value
      // this tool shipped with — that is the leak, not a decision anyone made.
      // Any other number is the trader's and is left alone, even if it is
      // lower than the new floor.
      const isShippedDefault = add.left === 'close'
        && existing.operation === 'greater' && Number(existing.right) === 1;
      if (isShippedDefault) {
        existing.right = add.right;
        touched = true;
      }
    }
    const limit = row.limit_n > 25 ? 25 : row.limit_n;
    if (!touched && limit === row.limit_n) continue;

    db.prepare('UPDATE screeners SET filters = ?, limit_n = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify(filters), limit, Date.now(), row.id);
    console.log(`[Screeners] tightened "${key}" — ${filters.length} rules, top ${limit}`);
    changed++;
  }
  return { changed };
}

// Mirrors created before the link was recorded carry it only in their name.
// Recover what can be recovered — a "X (mirror)" sitting alongside an "X" — so
// existing pairs report correctly without anyone re-creating them. One that has
// already been renamed cannot be recovered this way; it is re-linked from the
// builder.
function backfillMirrorLinks() {
  let linked = 0;
  const rows = db.prepare('SELECT id, name, mirror_of FROM screeners').all();
  const byName = new Map(rows.map(r => [r.name, r]));
  for (const r of rows) {
    if (r.mirror_of) continue;
    const m = /^(.*) \(mirror\)$/i.exec(r.name);
    if (!m || !byName.has(m[1])) continue;
    db.prepare('UPDATE screeners SET mirror_of = ? WHERE id = ?').run(m[1], r.id);
    console.log(`[Screeners] "${r.name}" recorded as the mirror of "${m[1]}"`);
    linked++;
  }
  return { linked };
}

function seedScreeners() {
  const count = db.prepare('SELECT COUNT(*) AS n FROM screeners').get().n;
  if (count > 0) {
    renameLegacyScreeners();
    applyDefaultWindows();
    repairOversoldMirror();
    tightenAfterOpenVolume();
    backfillMirrorLinks();
    tightenLiquidMovers();
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
  tightenAfterOpenVolume, backfillMirrorLinks, tightenLiquidMovers,
  WINDOW_NOTES,
  PRESETS: BY_TOOL, SESSION_SCREENERS,
};
