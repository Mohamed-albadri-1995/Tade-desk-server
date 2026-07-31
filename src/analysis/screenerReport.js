/*
 * Which screeners find stocks that move, and which do not.
 *
 * This is not a trade report. There is no stop, no target and no exit — it
 * measures the MOVE a stock made after the entry time, in ATR units, which is
 * the question a screener can actually be held responsible for. Whether a move
 * is tradable is a question about setups, and comes later.
 *
 * Read off the accumulated training rows, so it covers every day captured, not
 * just what happens to be on screen.
 */

const db = require('../db');

// A move worth having, in ATR. Same threshold the model calls a win, so the
// scorecard and the model are not quietly grading on different curves.
const GOOD_R = 1.3;
const BIG_R = 2.0;

// Below this, the numbers are noise dressed up as a verdict.
const MIN_CARDS = 20;
const MIN_DAYS = 5;

function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

const mean = xs => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const round = (v, n = 2) => (v == null ? null : Number(v.toFixed(n)));

/**
 * @param {'A'|'B'} entry which entry time to measure from
 */
function buildScreenerReport({ entry = 'B' } = {}) {
  const table = entry === 'A' ? 'r4a_train' : 'r4b_train';
  const upKey = entry === 'A' ? 'upR_A' : 'upR_B';
  const downKey = entry === 'A' ? 'downR_A' : 'downR_B';

  let raw;
  try {
    raw = db.prepare(`SELECT date, data FROM ${table}`).all();
  } catch (err) {
    return { ok: false, error: err.message, screeners: [] };
  }

  // Map<screenerName, { up: [], down: [], days: Map<date, bestUpR> }>
  const byScreener = new Map();
  const allDates = new Set();
  let rowsUsed = 0;

  for (const r of raw) {
    let d;
    try { d = JSON.parse(r.data); } catch { continue; }
    const up = d[upKey];
    const down = d[downKey];
    if (up == null || !Number.isFinite(Number(up))) continue;

    // screenerKeys is stored as an array or as a "+"-joined string depending on
    // when the row was written; both mean the same thing.
    const keys = Array.isArray(d.screenerKeys)
      ? d.screenerKeys
      : String(d.screenerKeys || '').split('+').filter(Boolean);
    if (!keys.length) continue;

    rowsUsed++;
    allDates.add(r.date);

    for (const name of keys) {
      if (!byScreener.has(name)) byScreener.set(name, { up: [], down: [], days: new Map() });
      const s = byScreener.get(name);
      s.up.push(Number(up));
      if (down != null && Number.isFinite(Number(down))) s.down.push(Number(down));
      const best = s.days.get(r.date);
      if (best === undefined || Number(up) > best) s.days.set(r.date, Number(up));
    }
  }

  const screeners = [...byScreener.entries()].map(([name, s]) => {
    const n = s.up.length;
    const good = s.up.filter(v => v >= GOOD_R).length;
    const big = s.up.filter(v => v >= BIG_R).length;
    const days = s.days.size;
    // Consistency is the point of the whole exercise: a screener that produced
    // every one of its good moves on two wild days is not a screener you can
    // plan around, however flattering its average.
    const daysWithGood = [...s.days.values()].filter(v => v >= GOOD_R).length;

    const thin = n < MIN_CARDS || days < MIN_DAYS;
    const goodPct = (good / n) * 100;
    const consistency = (daysWithGood / days) * 100;

    return {
      name,
      cards: n,
      days,
      avgUpR: round(mean(s.up)),
      medUpR: round(median(s.up)),
      avgDownR: round(mean(s.down)),
      goodPct: round(goodPct, 1),
      bigPct: round((big / n) * 100, 1),
      consistency: round(consistency, 1),
      thin,
      verdict: thin ? 'not enough data' : verdictFor(goodPct, consistency),
    };
  }).sort((a, b) => {
    if (a.thin !== b.thin) return a.thin ? 1 : -1;     // judged ones first
    return (b.goodPct || 0) - (a.goodPct || 0);
  });

  // The baseline every screener is judged against: all rows pooled. A screener
  // beating its own tool's average is the only comparison that means anything —
  // one tool samples $2 small caps and another samples large caps, so an
  // absolute win rate says more about the universe than about the screener.
  const pooled = [...byScreener.values()].flatMap(s => s.up);
  const baseline = pooled.length ? {
    cards: rowsUsed,
    days: allDates.size,
    avgUpR: round(mean(pooled)),
    goodPct: round((pooled.filter(v => v >= GOOD_R).length / pooled.length) * 100, 1),
  } : null;

  return {
    ok: true,
    entry,
    goodR: GOOD_R,
    bigR: BIG_R,
    minCards: MIN_CARDS,
    minDays: MIN_DAYS,
    baseline,
    screeners,
  };
}

// Deliberately blunt. The trader asked for "keep this one, delete that one",
// not a score they then have to interpret.
function verdictFor(goodPct, consistency) {
  if (goodPct >= 35 && consistency >= 50) return 'keep';
  if (goodPct >= 25 || consistency >= 40) return 'watch';
  return 'drop';
}

module.exports = { buildScreenerReport, GOOD_R, BIG_R, MIN_CARDS, MIN_DAYS };
