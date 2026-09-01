/*
 * Attach the CANSLIM reading to each r0 row, so it can be COLLECTED.
 *
 * WHY THIS DID NOT EXIST BEFORE. Every CANSLIM number reaches the card from a
 * different place, and all of them arrive in the BROWSER: the market model and
 * the group ranks are files the page fetches, the 13F counts are another, the
 * EDGAR tables and the weekly base are a third. That is the right design for
 * display — one fetch for a whole screen, no network call in a card render —
 * but it means none of it was ever on the row, so none of it was ever frozen
 * into a register. The card knew seven letters and the dataset knew none.
 *
 * This runs server-side, once per scan, and puts the same numbers on the row
 * the registers are built from. It reads the SAME shared files the page reads,
 * so the card and the register cannot disagree about what a stock scored.
 *
 * FLAT, NOT NESTED. Registers are CSV columns in the end, and `canslim.c.eps`
 * does not survive that trip. Each value gets its own key with a `cs` prefix
 * so it is obvious in a training set which family a column belongs to.
 *
 * SOFT, ALWAYS. A stock with no filings, a group that is not ranked, a market
 * model that has not been built — each of those is a null in one column, never
 * a failed scan and never a missing row.
 */

const num = v => (v == null || v === '' || Number.isNaN(Number(v))
  ? null : Number(v));

/**
 * PURE. Takes one ticker and the already-loaded shared models, returns the
 * flat column set. Every input is optional; every output is null when its
 * source has nothing to say.
 */
function rowFor(ticker, { market, stocks, groups, f13, ratings, fundamentals, bases } = {}) {
  const t = String(ticker || '').toUpperCase();
  const sd = (stocks || {})[t] || {};
  const g = ((groups || {}).stocks || {})[t] || {};
  const i = ((f13 || {}).stocks || {})[t] || {};
  const x = (ratings || {})[t] || {};
  const f = (fundamentals || {})[t] || {};
  const b = (bases || {})[t] || {};
  const c0 = (f.c && f.c.rows && f.c.rows[0]) || {};
  const a = f.a || {};

  return {
    // C — the most recent filed quarter, EPS and SALES together. Never one
    // without the other: a buyback lifts EPS with the business standing still.
    csEpsChg: num(c0.eps_chg),
    csSalesChg: num(c0.sales_chg),
    csQuarter: c0.quarter || null,
    csAccelerating: f.c ? (f.c.accelerating ? 1 : 0) : null,
    csBeats: num(f.c && f.c.beat_25),

    // A — the annual run.
    csGrowth3yr: num(a.growth_3yr_pct),
    csStability: num(a.stability),          // LOW is good — see the card note
    csRoe: num(a.roe_pct),

    // N — the base, on WEEKLY bars.
    csBaseWeeks: num(b.weeks),
    csBaseDepth: num(b.depth_pct),
    csPivot: num(b.pivot),
    csPctToPivot: num(b.pct_to_pivot),
    csBaseScore: num(b.score),
    csHandle: b.handle ? (b.handle.valid ? 1 : 0) : null,

    // S — who is accumulating.
    csUdRatio: num(x.ud && x.ud.ratio),
    csAdLetter: (x.ad && x.ad.letter) || null,
    csRsLineTell: x.rs_line ? (x.rs_line.tell ? 1 : 0) : null,

    // L — the group, ranked over the whole market.
    csGroup: g.group || null,
    // WHICH LEVEL THE RANK WAS TAKEN AT. An industry too thin to rank is
    // merged into its SIC major group, and "rank 12 of 180" over a rolled-up
    // bucket is a coarser fact than the same numbers over a named industry.
    // Without this column a training set cannot tell them apart.
    csGroupLevel: g.group_level || null,
    csGroupRank: num(g.group_rank),
    csGroupOf: num(g.group_of),
    csRsInGroup: num(g.rs_in_group),
    csGroupMembers: num(g.members),

    // I — institutional sponsorship. The count AND its direction; the count
    // alone is not the reading, because more is not always better.
    csFunds: num(i.funds),
    csFundsChg: num(i.change),
    csFundsDir: i.direction || null,

    // M — the market, and what THIS stock did on the distribution days. The
    // status is the same on every row and the per-stock half is not, which is
    // the only reason the pair is worth collecting.
    csMarket: (market && market.status) || null,
    csDdChecked: num(sd.checked),
    csDdHeld: num(sd.held),
    csDdAvgRel: num(sd.avgRel),
    csDdVerdict: sd.verdict || null,
  };
}

/** The column names, in order. Exported so the register and the guard agree. */
const COLUMNS = Object.keys(rowFor('X'));

/*
 * EVERY COLUMN, ALL NULL. Spread this before the real values so a row that
 * has no CANSLIM reading still carries the columns.
 *
 * The alternative — letting the keys simply be absent — gives a RAGGED table:
 * a stock with filings has thirty more columns than one without, the CSV
 * header depends on which row happened to be first, and a model trained on it
 * sees "column missing" and "column null" as the same thing when they are not.
 */
const BLANK = Object.freeze(rowFor('X'));

/**
 * Load every shared model once, then attach to all rows.
 *
 * ONE LOAD FOR THE WHOLE SCAN, not one per row: these are files and cached
 * day-long fetches, and a register day is 150 rows.
 */
async function attach(rows) {
  const list = (rows || []).filter(r => r && r.ticker);
  if (!list.length) return { attached: 0 };
  const symbols = list.map(r => r.ticker);
  const oneil = require('../sideD/oneil');
  const groupsMod = require('../sideD/groups');

  const safe = async (fn, dflt) => { try { return await fn(); } catch { return dflt; } };
  const [stocksC, ratingsC, f13, fundC, baseC] = await Promise.all([
    safe(() => oneil.loadStocks(symbols), { stocks: {} }),
    safe(() => oneil.loadRatings(symbols), { stocks: {} }),
    safe(() => oneil.loadF13(), null),
    safe(() => oneil.loadFundamentalsCached(symbols), { stocks: {} }),
    safe(() => oneil.loadBases(symbols), { stocks: {} }),
  ]);
  const market = (() => { try { return oneil.read(); } catch { return null; } })();
  const groups = (() => { try { return groupsMod.read(); } catch { return null; } })();

  const ctx = {
    market,
    stocks: (stocksC && stocksC.stocks) || {},
    groups,
    f13,
    ratings: (ratingsC && ratingsC.stocks) || {},
    fundamentals: (fundC && fundC.stocks) || {},
    bases: (baseC && baseC.stocks) || {},
  };
  let attached = 0;
  for (const row of list) {
    row.canslim_row = rowFor(row.ticker, ctx);
    // Counted as attached only when SOMETHING was found, so the log
    // distinguishes "ran and found nothing" from "ran".
    if (Object.values(row.canslim_row).some(v => v != null)) attached += 1;
  }
  return { attached, of: list.length };
}

module.exports = { rowFor, attach, COLUMNS, BLANK };
