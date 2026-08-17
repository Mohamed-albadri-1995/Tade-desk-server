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
    // No RUN window — T1 is the control and scans all day. Check windows are
    // display only, and they are still worth stating: "all day" is true of the
    // collection, not of when a human gets anything out of looking.
    checkFrom: '09:35', checkTo: '16:00',
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
    checkFrom: '08:00', checkTo: '09:45',
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
    checkFrom: '09:35', checkTo: '16:00',
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
  runFrom: '09:00', runTo: '10:00', checkFrom: '09:15', checkTo: '10:30',
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
  checkFrom: '08:00', checkTo: '10:30',
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
  checkFrom: '10:00', checkTo: '15:30',
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
/*
 * KEPT, SWITCHED OFF. The 52-week break as it was, so the definition behind
 * every frozen register day it produced is still readable and it can be turned
 * back on from the Screeners page. A break through a 52-week high on a
 * billion-dollar name is a rare event — one frozen day in the whole archive —
 * and a screener that fires once a month cannot be measured against anything.
 */
const T5_ARCHIVED = {
  key: '52w-break', name: '52-Week Break (archived)',
  enabled: false,
  checkFrom: '09:45', checkTo: '16:00',
  runFrom: '09:30', runTo: '16:00',
  sort: { sortBy: 'change', sortOrder: 'desc' },
  filters: [
    { left: 'close', operation: 'egreater', right: 'price_52_week_high' },
    { left: 'market_cap_basic', operation: 'greater', right: 1000000000 },
    { left: 'relative_volume_10d_calc', operation: 'greater', right: 1.5 },
    { left: 'average_volume_10d_calc', operation: 'greater', right: 1000000 },
  ],
};

/*
 * THE 20-DAY BREAK. The same idea at a horizon that actually produces trades.
 *
 * `High.1M` is TradingView's one-month high — about 20 trading days — and it is
 * already what T2 breaks. A month of range is a level people can see and have
 * traded against; a 52-week high is a level almost nothing reaches on a given
 * morning, which is why the archived screener above has one day of data.
 *
 * The mirror is the SUPPORT break, not "below the 20-day high": FIELD_MIRROR
 * swaps High.1M for Low.1M, so the pair is "broke the month's high" against
 * "broke the month's low" and asks whether a break in either direction is
 * worth taking.
 *
 * THE NEWS PART IS NOT HERE, and cannot be. TradingView returns a universe;
 * the catalyst is fetched per ticker afterwards by this tool's own news pass
 * and lands on the card. So "with supporting news" is a card-field filter on
 * the setup — `catalyst is not empty` — applied before qp sees the list. See
 * src/setups/universe.js. Putting a fake news column in the screener would
 * return nothing at all.
 *
 * The billion-dollar market-cap floor is gone with the 52-week horizon: it was
 * there to keep 52-week highs meaningful on established names, and at a
 * 20-day horizon it excludes most of what this desk trades. The tradability
 * floor still applies.
 */
const T5_BASE = {
  key: '20d-break', name: '20-Day Break',
  checkFrom: '09:45', checkTo: '16:00',
  runFrom: '09:30', runTo: '16:00',
  sort: { sortBy: 'relative_volume_10d_calc', sortOrder: 'desc' },
  filters: [
    { left: 'close', operation: 'egreater', right: 'High.1M' },
    { left: 'relative_volume_10d_calc', operation: 'greater', right: 1.5 },
    { left: 'close', operation: 'egreater', right: 1 },
    { left: 'average_volume_10d_calc', operation: 'greater', right: 500000 },
  ],
};

// Stretched on RSI with volume. Its mirror is the oversold side, so the pair
// asks directly whether extremes continue or revert. Extension is something the
// session BUILDS: at 09:30 RSI still describes yesterday, so the screener holds
// off until the move has had half an hour to make itself, then stays up to the
// close — a stock can be stretched at any hour, and the fade is the trade.
/*
 * KEPT, SWITCHED OFF. The overextended screener as it was, so its nine frozen
 * days stay attributable to the definition that produced them and it can be
 * turned back on from the Screeners page without retyping it.
 */
const T6_ARCHIVED = {
  key: 'overextended', name: 'Overextended (archived)',
  enabled: false,
  checkFrom: '10:15', checkTo: '16:00',
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

/*
 * THE UNEXPLAINED MOVE — a big quick move with no reason, expected to come back.
 *
 * A stock goes 15% in two hours and there is no news, no filing, no catalyst
 * anywhere. Nothing changed about the company, so the price has no reason to
 * stay where it is: the trade is the correction back toward where it was. This
 * is the only mean-reversion setup on the desk; every other tool here is
 * looking for a move to continue.
 *
 * THE MOVE IS THE TRIGGER, NOT THE EXCLUSION. (Written the other way round
 * first — as a consolidation screener — which is the opposite setup.)
 *
 * WHY THE SIX-MONTH TREND IS HERE, and it is not a momentum filter: it is a
 * safety layer, and it faces the OPPOSITE way to the move.
 *
 *   A stock that has fallen for six months and falls again today has not done
 *   anything unexplained. It is doing what it has been doing, and there is no
 *   reason for it to bounce. Buying that dip is catching a knife.
 *
 * So each side refuses a spike that agrees with the six-month trend:
 *
 *   base    spiked UP 15%   + six months NOT rising   -> short it back down
 *   mirror  dropped 15%     + six months NOT falling  -> buy it back up
 *
 * Both come out of one definition: `change|120` and `Perf.6M` are both
 * directional, so the mirror flips the sign of each and produces exactly the
 * other half. That only works because Perf.6M was added to DIRECTIONAL_FIELDS
 * — without it the twin asked for the same six-month condition as the base and
 * the pair had no safety layer on one side at all.
 *
 * THE "NO NEWS" HALF IS NOT HERE, AND CANNOT BE. TradingView has no news
 * column; the catalyst is fetched per ticker by this tool's own news pass
 * afterwards and lands on the card. It is a card filter on the setup —
 * `catalyst is empty` — and it is not optional garnish: without it this
 * screener returns every 15% mover, which is mostly news, which is the exact
 * opposite of the setup. See src/setups/universe.js, and note that the filter
 * needed a new operator to express absence at all.
 *
 * `change|120` is the two-hour change and does not exist before there have
 * been two hours, so this cannot run before 11:30 and mean anything.
 */
const T6_BASE = {
  key: 'unexplained-move', name: 'Unexplained Move',
  checkFrom: '11:30', checkTo: '16:00',
  runFrom: '11:30', runTo: '16:00',
  sort: { sortBy: 'change|120', sortOrder: 'desc' },
  filters: [
    { left: 'change|120', operation: 'greater', right: 15 },
    { left: 'Perf.6M', operation: 'less', right: 0 },
    { left: 'close', operation: 'egreater', right: 1 },
    { left: 'average_volume_10d_calc', operation: 'greater', right: 500000 },
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
/*
 * WHO is a growth stock, as opposed to which of them did something today.
 *
 * The two were one screener, and that was wrong in a way worth stating plainly:
 * a company does not stop being a growth company overnight. Its quarterly
 * earnings change four times a year. But the screener also demanded a new
 * 52-week high on above-average volume, so a name joined the list on the days
 * it broke out and vanished on the days it did not — and the CANSLIM tag every
 * other tool reads was really a breakout tag wearing a growth label.
 *
 * So this screener holds the slow half only: earnings, sales, size, and
 * six-month strength. Nothing here can be true today and false tomorrow.
 * Membership then lasts ninety days from the last confirmation (canslim.js),
 * which is the horizon O'Neil's criteria are meant for.
 *
 * Two things follow from it being a list rather than a trade idea:
 *
 *   labelOnly means its matches never become cards and never enter r0. The
 *   tool's candidates still come from the breakout and pullback screeners
 *   below, so nothing about what gets collected or trained on changes shape.
 *
 *   The tradability floor does not apply, for the same reason. A $600 name with
 *   1.5% of daily range is a growth company that is not a day trade; letting
 *   the floor decide membership would put today's volatility back in charge of
 *   an answer that is supposed to be about the business.
 *
 * It runs in one narrow window because fundamentals do not move intraday.
 */
const CANSLIM_UNIVERSE = {
  key: 'canslim-universe', name: 'CANSLIM Universe',
  labelOnly: true,
  checkFrom: '09:45', checkTo: '16:00',
  runFrom: '09:30', runTo: '09:45',
  limit: 200,
  sort: { sortBy: 'Perf.6M', sortOrder: 'desc' },
  filters: [
    // C — the current quarter
    { left: 'earnings_per_share_diluted_yoy_growth_fq', operation: 'egreater', right: 25 },
    // A — and not a one-quarter accident
    { left: 'earnings_per_share_diluted_yoy_growth_fy', operation: 'egreater', right: 25 },
    // sales behind the earnings, so the growth is not only cost-cutting
    { left: 'total_revenue_yoy_growth_fq', operation: 'egreater', right: 15 },
    // L — leading, by the only measure available
    { left: 'Perf.6M', operation: 'greater', right: 30 },
    // S — a cap on supply
    { left: 'total_shares_outstanding_fundamental', operation: 'less', right: 1000000000 },
    // institutions cannot buy what does not trade
    { left: 'market_cap_basic', operation: 'greater', right: 300000000 },
  ],
};

const CANSLIM_BASE = {
  key: 'canslim', name: 'CANSLIM',
  checkFrom: '09:45', checkTo: '16:00',
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
  checkFrom: '09:45', checkTo: '16:00',
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
  // Runs from 04:00 but is not worth READING until the gap has stopped moving.
  // Opening it at 06:00 shows a list that will be different by the bell, so the
  // check window starts ten minutes out and covers the first half hour, which
  // is the whole life of a gap trade.
  checkFrom: '09:20', checkTo: '10:00',
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

// Rebuilt around ONE observation: `volume` is cumulative shares traded so far
// today. It is zero at 09:30 and largest at 16:00, so "volume > 10M" is not one
// condition — it is an impossible one in the morning and a trivial one by the
// close. A screener built on it does not find heavy traders, it slowly fills up
// as the session runs, which is exactly what was seen: 75 names by the end of
// the day.
//
// `relative_volume_10d_calc` has the same flaw for the same reason: it divides
// volume SO FAR TODAY by a full-day average, so it climbs all session too.
//
// The two fields that do not drift are the ones this screener now uses.
// `average_volume_10d_calc` is a ten-day average and is fixed all day — it says
// "this is a big liquid name". `relative_volume_intraday|5` compares the
// current five-minute bar against what that bar usually does, so it is
// time-matched and says "volume is arriving RIGHT NOW" at 09:40 exactly as it
// does at 15:40.
const AFTER_OPEN_VOLUME = {
  key: 'after-open-volume', name: 'After Open Volume',
  checkFrom: '09:45', checkTo: '16:00',
  runFrom: '09:30', runTo: '16:00',
  limit: 25,
  sort: { sortBy: 'relative_volume_intraday|5', sortOrder: 'desc' },
  filters: [
    // A big liquid name. Fixed all day, so it means the same at 09:40 and 15:40.
    { left: 'average_volume_10d_calc', operation: 'greater', right: 5000000 },
    // Volume arriving now, measured against what this time of day usually does.
    { left: 'relative_volume_intraday|5', operation: 'greater', right: 3 },
    // The source recipe's condition, kept: ten million shares ACTUALLY traded
    // today. On its own it was the problem — it is a cumulative counter, so it
    // meant nothing in the morning and everything by the close, and the list
    // could only grow. Alongside the rules above it is no longer doing that
    // work alone: a name still has to be big, moving 3%, and taking unusual
    // volume in the current five minutes.
    //
    // It does make this screener naturally quiet early on — at 10:00 very few
    // stocks have traded ten million shares. That is correct rather than a
    // fault: the condition asks what HAS traded, and at 10:00 the honest answer
    // is "not much yet".
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
  '20d-break': 'The whole regular session. A month\u2019s range breaks on flow that arrives at any hour, often late. Pre-market is excluded on purpose \u2014 a 20-day high printed on a handful of thin shares is not a break. The NEWS half of this setup is a card filter (catalyst is not empty), not a screener column: TradingView returns the universe and the catalyst is fetched per ticker afterwards.',
  'unexplained-move': 'From 11:30, because the two-hour change it depends on does not exist before then, and on to the close \u2014 an unexplained move can happen at any hour and the correction follows it. The NO-NEWS half is a card filter (catalyst is empty), not a screener column, and it is the setup rather than a refinement: without it this returns every 15% mover, which is mostly news.',
  '52w-break': 'The whole regular session. These break on institutional flow, which arrives at any hour and often late in the day. Pre-market is excluded on purpose — a 52-week high printed on a handful of thin shares is not a break.',
  overextended: 'Waits until 10:00. At the open RSI still describes yesterday; extension is something the session builds. Then runs to the close, because a stock can be stretched at any hour and the fade is the trade.',

  'canslim-universe': 'A list, not a hunt. Nothing in it can be true today and false tomorrow — quarterly earnings change four times a year — so it runs once, in the first fifteen minutes, and membership then holds for ninety days. It is the only screener exempt from the tradability floor: a $600 growth name with 1.5% of daily range is still a growth company, it is just not a day trade.',
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
// The archived definition rides along, switched off, so it is never lost.
const T5 = [...pair(T5_BASE), T5_ARCHIVED];
const T6 = [...pair(T6_BASE), T6_ARCHIVED];

// T7 runs the two session-bound screeners. They are NOT mirrored: each is a
// complete setup for its own session, and the sessions do not overlap, so a
// stock lands in one or the other rather than both.
const T7 = [PREMARKET_GAP, AFTER_OPEN_VOLUME];

// T8 is the CANSLIM tool. Its matches are also written to a shared member list
// that every other tool reads, so a CANSLIM name turning up in an unrelated
// screener is tagged there — see canslim.js.
const T8 = [CANSLIM_UNIVERSE, CANSLIM_BASE, CANSLIM_PULLBACK];

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
  checkFrom: '09:45', checkTo: '16:00',
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

  // T6_ARCHIVED, not T6_BASE. This repairs the OVEREXTENDED mirror, and T6_BASE
  // is now the quiet base — pointing it at whatever T6 currently ships would
  // have rewritten a screener called "Overextended (mirror)" with the filters
  // of an entirely different setup, silently, on any box still carrying the
  // contradiction. A repair names the thing it repairs.
  const fixed = store.mirrorDefinition(T6_ARCHIVED).filters;
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
    { left: 'average_volume_10d_calc', operation: 'greater', right: 5000000 },
    { left: 'relative_volume_intraday|5', operation: 'greater', right: 3 },
    { left: 'volume', operation: 'greater', right: 10000000 },
  ],
};

// relative_volume_10d_calc divides day-to-date volume by a FULL-day average, so
// it climbs all session and cannot be made to mean one thing. Removed rather
// than retuned.
//
// `volume` is cumulative too, but it is the source recipe's own condition and
// it is kept — see the screener above. The difference is that it no longer
// carries the screener alone.
const T7_TIME_DEPENDENT = ['relative_volume_10d_calc'];

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
    if (key === 'after-open-volume') {
      const before = filters.length;
      filters = filters.filter(f => !T7_TIME_DEPENDENT.includes(f.left));
      if (filters.length !== before) touched = true;
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

/**
 * Link a mirror to its parent by what it FILTERS, not what it is called.
 *
 * backfillMirrorLinks reads the name — "X (mirror)" — which works right up
 * until someone renames one. "MA Stack Breakout (mirror)" became "MA Stack
 * Pullback", a better name and an invisible one: the link was lost, and a pair
 * that is not linked simply does not appear in the month-end comparison. The
 * screener kept collecting; the comparison it was built for quietly had one
 * fewer row.
 *
 * Filters cannot be renamed. Every mirror is generated by mirrorDefinition, so
 * an unlinked screener whose filters are exactly the mirrored form of another
 * screener's IS that screener's mirror, whatever either is called now.
 */
function linkMirrorsByFilters() {
  const rows = db.prepare('SELECT id, name, filters, mirror_of FROM screeners ORDER BY id').all();
  const norm = f => JSON.stringify((f || []).map(x => [x.left, x.operation, x.right]));

  const claimed = new Set(rows.map(r => r.mirror_of).filter(Boolean));
  const expected = new Map();   // mirrored-filter signature → the parent row
  for (const r of rows) {
    if (claimed.has(r.name)) continue;
    try {
      const own = norm(JSON.parse(r.filters));
      const sig = norm(store.mirrorDefinition({ name: r.name, filters: JSON.parse(r.filters) }).filters);
      // A screener with nothing directional to flip mirrors to itself, so its
      // signature matches every copy of itself and would pair unrelated rules.
      if (sig === own) continue;
      expected.set(sig, r);
    } catch { /* unparseable row — leave it alone */ }
  }

  let linked = 0;
  for (const r of rows) {
    if (r.mirror_of) continue;
    let parent;
    try { parent = expected.get(norm(JSON.parse(r.filters))); } catch { continue; }
    if (!parent || parent.name === r.name) continue;
    // Mirroring is symmetric — the parent's filters are equally the mirror of
    // the mirror's — so matching alone would link the pair in both directions
    // and neither would be the parent. The mirror is generated FROM the base
    // and therefore stored after it, so the lower id is the original.
    if (parent.id > r.id) continue;
    db.prepare('UPDATE screeners SET mirror_of = ? WHERE id = ?').run(parent.name, r.id);
    console.log(`[Screeners] "${r.name}" is the mirror of "${parent.name}" — linked by its filters`);
    linked++;
  }
  return { linked };
}

/**
 * When it is worth OPENING the tool, which is not when the screener scans.
 *
 * The pre-market gap screener starts scanning at 04:00 and has nothing worth
 * looking at until the pre-market has volume in it; the overextended screener
 * cannot say anything before 10:00 because at the bell RSI still describes
 * yesterday. Both were displaying their scan window, which reads as an
 * invitation to open the tool at 04:30 and find an empty screen.
 *
 * Filled in only where it is missing, so a check window set by hand stays.
 */
function applyCheckWindows() {
  const defs = BY_TOOL[config.toolId] || [];
  let applied = 0;
  for (const def of defs) {
    if (!def.checkFrom && !def.checkTo) continue;
    const key = store.slugify(def.key || def.name);
    const row = db.prepare('SELECT id, check_from, check_to FROM screeners WHERE key = ?').get(key);
    if (!row || row.check_from || row.check_to) continue;
    db.prepare('UPDATE screeners SET check_from = ?, check_to = ?, updated_at = ? WHERE id = ?')
      .run(def.checkFrom || null, def.checkTo || null, Date.now(), row.id);
    applied++;
  }
  if (applied) console.log(`[Screeners] check window set on ${applied} screener(s)`);
  return { applied };
}

/**
 * T2's breakout window, retimed on the trader's instruction.
 *
 * It ran 09:30–15:00 and was later edited to 09:30–12:00. Both are wrong for
 * how the tool is actually used: momentum positions here are closed by 10:30,
 * so anything the screener finds after 10:00 is a candidate that cannot be
 * traded — it arrives, fills the list, and trains the model on setups nobody
 * took. And it started at the bell, which meant the list did not exist while
 * there was still time to read it before the open.
 *
 * 09:00–10:00. One-time, flagged in settings, so a later edit in the builder
 * is not undone on every restart.
 */
function retimeT2Breakout() {
  if (config.toolId !== 'T2') return { applied: 0 };
  const done = db.prepare("SELECT value FROM settings WHERE key = 't2BreakoutRetimed'").get();
  if (done && done.value) return { applied: 0 };
  const row = db.prepare("SELECT id FROM screeners WHERE key = 'ma-stack-breakout'").get();
  if (row) {
    db.prepare('UPDATE screeners SET run_from = ?, run_to = ?, updated_at = ? WHERE id = ?')
      .run('09:00', '10:00', Date.now(), row.id);
    console.log('[Screeners] "MA Stack Breakout" retimed to 09:00–10:00 ET');
  }
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('t2BreakoutRetimed', '1')").run();
  return { applied: row ? 1 : 0 };
}

function seedScreeners() {
  const count = db.prepare('SELECT COUNT(*) AS n FROM screeners').get().n;
  if (count > 0) {
    renameLegacyScreeners();
    applyDefaultWindows();
    repairOversoldMirror();
    tightenAfterOpenVolume();
    backfillMirrorLinks();
    linkMirrorsByFilters();   // catches the renamed ones the name rule misses
    applyCheckWindows();
    retimeT2Breakout();
    tightenLiquidMovers();
    addCanslimUniverse();
    installNewScanners();
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

/*
 * T8 databases created before the split have two screeners that both mix "is
 * this a growth company" with "did it break out today", and a member list built
 * from whichever names did both. Add the universe screener so membership starts
 * coming from the slow half.
 *
 * The existing screeners are left exactly as they are. They are still the two
 * setups the tool trades, and rewriting a screener's filters underneath a month
 * of collected cards would make the history describe rules that were never run.
 */
/*
 * REPLACING A TOOL'S SCANNER ON A BOX THAT IS ALREADY RUNNING.
 *
 * seedScreeners() returns early the moment the table has anything in it — it
 * seeds a fresh box and never touches a live one — so a new definition reaches
 * nobody without a migration. This is that migration, in the same shape as the
 * repairs above: keyed, idempotent, and it never removes anything.
 *
 * The old screener is DISABLED and RENAMED rather than deleted. Its frozen
 * register days are already stored under its key, and deleting the row would
 * leave a month of archived candidates with no definition to say what produced
 * them. Switched off it stops scanning, keeps its history readable, and can be
 * turned back on from the Screeners page in one click.
 *
 * Nothing is created twice: a screener the user has since deleted stays
 * deleted, because the guard is "does this key exist", not "should it".
 */
function replaceScanner(toolId, oldKey, archivedName, newDefs) {
  if (config.toolId !== toolId) return { changed: 0 };
  let changed = 0;
  const old = db.prepare('SELECT id, name, enabled FROM screeners WHERE key = ?').get(oldKey);
  if (old && old.enabled) {
    db.prepare('UPDATE screeners SET enabled = 0, name = ?, updated_at = ? WHERE id = ?')
      .run(archivedName, Date.now(), old.id);
    console.log(`[Screeners] "${old.name}" switched off and kept as "${archivedName}" `
      + '— its frozen days stay readable and it can be re-enabled from the page');
    changed++;
    // Its mirror goes quiet with it, or the pair is half live.
    const mir = db.prepare('SELECT id, name FROM screeners WHERE mirror_of = ?').get(old.name);
    if (mir) {
      db.prepare('UPDATE screeners SET enabled = 0, mirror_of = ?, updated_at = ? WHERE id = ?')
        .run(archivedName, Date.now(), mir.id);
      changed++;
    }
  }
  for (const def of newDefs) {
    if (def.enabled === false) continue;             // the archived copy itself
    const key = store.slugify(def.key || def.name);
    if (db.prepare('SELECT id FROM screeners WHERE key = ?').get(key)) continue;
    try {
      store.create(def);
      console.log(`[Screeners] added "${def.name}"`);
      changed++;
    } catch (err) {
      console.warn(`[Screeners] could not add "${def.name}": ${err.message}`);
    }
  }
  return { changed };
}

// T5: a 52-week break is a once-a-month event, and a screener that fires once a
// month cannot be measured against anything — one frozen day in the archive.
// The same idea at 20 days produces trades. T6: overbought-with-volume is what
// four other tools already find; the quiet base is the setup nothing else here
// looks for.
function installNewScanners() {
  replaceScanner('T5', '52w-break', '52-Week Break (archived)', T5);
  replaceScanner('T6', 'overextended', 'Overextended (archived)', T6);
}

function addCanslimUniverse() {
  if (config.toolId !== 'T8') return;
  const exists = db.prepare('SELECT id FROM screeners WHERE key = ?').get('canslim-universe');
  if (exists) return;
  try {
    store.create(CANSLIM_UNIVERSE);
    console.log('[Screeners] added "CANSLIM Universe" — membership now comes from the fundamentals '
      + 'alone, so a name no longer joins the list only on days it breaks out');
  } catch (err) {
    console.warn(`[Screeners] could not add CANSLIM Universe: ${err.message}`);
  }
}

module.exports = {
  seedScreeners, renameLegacyScreeners, applyDefaultWindows, repairOversoldMirror,
  tightenAfterOpenVolume, backfillMirrorLinks, linkMirrorsByFilters, tightenLiquidMovers,
  applyCheckWindows, retimeT2Breakout, addCanslimUniverse,
  WINDOW_NOTES,
  PRESETS: BY_TOOL, SESSION_SCREENERS,
};
