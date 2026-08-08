/*
 * T2 10:00 VWAP-extension ranking setup.
 *
 * Implements setup_spec.md v1.0 exactly. Everything here is a pure function of
 * the bars it is given: no clock, no network, no database. That is deliberate —
 * the spec ships a reference trade log of eight trades over four days, and a
 * pure implementation can be held against it in a test rather than trusted.
 *
 * WHAT THE SETUP DOES, in one paragraph. At 10:00, having watched the first
 * thirty minutes and done nothing, look at every stock on T2's card list. Keep
 * the ones trading on the correct side of the session VWAP, with VWAP moving
 * their way, and sitting in the right end of the morning's range. Throw out the
 * ones whose morning already contradicted the direction. Of whatever is left,
 * take the two that are FURTHEST from VWAP — not the closest — and trade them
 * with VWAP itself as the stop and twice that distance as the target.
 *
 * WHAT IT DOES NOT DO. No card field is used in any decision: not market cap,
 * float, catalyst, pre-market range, RVOL or regime. The spec tested all of
 * them against 110 ticker-days and none separated winners. The card list is the
 * universe and nothing more.
 *
 * A caution that belongs next to the code rather than in a document nobody
 * opens: this is eight trades over four days, and the ranking metric was chosen
 * after looking at those four days. It is not a validated edge. Section 7 of the
 * spec says so and so does the alert this produces.
 */

const DEFAULTS = {
  decisionTime: '10:00',       // evaluate once the bar BEFORE this has closed
  sessionStart: '09:30',
  rangePosLong: 55,
  rangePosShort: 45,
  slopeLookback: 10,           // bars, by index — not by clock
  invalidationLongCutoff: '09:40',
  invalidationShortCutoff: '09:50',
  topN: 2,
  targetR: 2.0,
  minBars: 10,                 // fewer than this in the morning window: skip
};

const hhmmToMin = (s) => {
  const [h, m] = String(s).split(':').map(Number);
  return h * 60 + m;
};

/**
 * The morning window: every bar from the session start up to, but not
 * including, the decision time. With the defaults that is 09:30…09:59.
 *
 * Bars are taken as given. Missing minutes are absent, never forward-filled —
 * a stock that did not trade at 09:47 did not trade at 09:47, and inventing a
 * bar there would put volume into the VWAP that never existed.
 */
function morningBars(bars, p = DEFAULTS) {
  const from = hhmmToMin(p.sessionStart);
  const to = hhmmToMin(p.decisionTime);
  return (bars || [])
    .filter(b => b && b.etTime && b.o != null && b.h != null && b.l != null && b.c != null)
    .filter(b => {
      const m = hhmmToMin(b.etTime);
      return m >= from && m < to;
    })
    .sort((a, b) => hhmmToMin(a.etTime) - hhmmToMin(b.etTime));
}

/**
 * Session VWAP, anchored at 09:30 and running over the regular session only.
 *
 * Returns the running series, one value per bar, so the slope can be read off
 * an earlier index. Pre-market is excluded by construction: morningBars() never
 * returns a bar before the session start, and an anchored VWAP that included
 * pre-market would not be the level the stop is placed at.
 */
function vwapSeries(bars) {
  let pv = 0;
  let vol = 0;
  return bars.map(b => {
    const typical = (Number(b.h) + Number(b.l) + Number(b.c)) / 3;
    const v = Number(b.v) || 0;
    pv += typical * v;
    vol += v;
    // No volume yet means no volume-weighted price yet. Null rather than a
    // guess: the caller skips the ticker, which is what the spec asks for.
    return vol === 0 ? null : pv / vol;
  });
}

/**
 * Where the decision close sits in the morning's range, 0–100.
 *
 * A stock that never moved has no range to be positioned in; 50 is the spec's
 * answer and it is the one that makes it fail both direction tests, which is
 * the right outcome for a flat stock.
 */
function rangePosition(close, low, high) {
  if (high === low) return 50;
  return ((close - low) / (high - low)) * 100;
}

/**
 * Did the morning already contradict the direction?
 *
 * For a long: the low made in the second part of the morning must not undercut
 * the low made in the first. For a short, the mirror. The cutoffs differ (09:40
 * and 09:50) because they were specified that way, not because anything was
 * swept.
 *
 * An empty sub-window passes. That is not leniency — with no bars there is no
 * evidence of invalidation, and rejecting on absence would silently drop every
 * thinly traded name.
 */
function invalidated(bars, signal, p = DEFAULTS) {
  const cutoff = hhmmToMin(signal === 'LONG'
    ? p.invalidationLongCutoff : p.invalidationShortCutoff);
  const first = bars.filter(b => hhmmToMin(b.etTime) <= cutoff);
  const second = bars.filter(b => hhmmToMin(b.etTime) > cutoff);
  if (!first.length || !second.length) return false;

  if (signal === 'LONG') {
    const a = Math.min(...first.map(b => Number(b.l)));
    const bLow = Math.min(...second.map(b => Number(b.l)));
    return bLow < a;
  }
  const c = Math.max(...first.map(b => Number(b.h)));
  const d = Math.max(...second.map(b => Number(b.h)));
  return d > c;
}

/**
 * Evaluate one ticker's morning.
 *
 * Always returns an object, never throws and never silently drops a name: a
 * ticker that is skipped says why. The reasons are the difference between "the
 * setup found nothing today" and "the data did not arrive", and from a fired
 * alert those two look identical unless the code keeps them apart.
 */
function evaluateTicker(ticker, bars, p = DEFAULTS) {
  const params = { ...DEFAULTS, ...p };
  const win = morningBars(bars, params);
  const base = { ticker, signal: 'NONE', bars: win.length };

  if (win.length < params.minBars) {
    return { ...base, skipped: `only ${win.length} morning bar(s), needs ${params.minBars}` };
  }

  const vwaps = vwapSeries(win);
  const i = win.length - 1;                       // the decision bar
  const decisionVwap = vwaps[i];
  if (decisionVwap == null) return { ...base, skipped: 'no volume in the morning window' };

  const decisionClose = Number(win[i].c);
  const morningHigh = Math.max(...win.map(b => Number(b.h)));
  const morningLow = Math.min(...win.map(b => Number(b.l)));
  const pos = rangePosition(decisionClose, morningLow, morningHigh);

  // By INDEX, not by clock. Ten bars back on a stock with gaps in its tape is
  // more than ten minutes back, and that is the intended reading: the slope is
  // over ten bars of actual trading.
  const back = Math.max(0, i - params.slopeLookback);
  const slope = decisionVwap - (vwaps[back] == null ? decisionVwap : vwaps[back]);

  const detail = {
    ...base,
    decisionAt: win[i].etTime,
    decisionClose,
    decisionVwap,
    morningHigh,
    morningLow,
    rangePosition: pos,
    vwapSlope: slope,
    volume: win.reduce((a, b) => a + (Number(b.v) || 0), 0),
  };

  let signal = 'NONE';
  if (decisionClose > decisionVwap && slope > 0 && pos >= params.rangePosLong) signal = 'LONG';
  else if (decisionClose < decisionVwap && slope < 0 && pos <= params.rangePosShort) signal = 'SHORT';

  if (signal === 'NONE') return { ...detail, signal: 'NONE', reason: 'no direction' };

  if (invalidated(win, signal, params)) {
    return { ...detail, signal: 'NONE', rejectedSignal: signal, reason: 'invalidated in the morning' };
  }

  // Always positive for a valid signal: it is the distance from VWAP, on the
  // side the signal is taken from, as a percentage of price.
  const extension = signal === 'LONG'
    ? (decisionClose / decisionVwap - 1) * 100
    : (decisionVwap / decisionClose - 1) * 100;

  return { ...detail, signal, extension };
}

/**
 * The plan for one trade.
 *
 * The stop is the session VWAP AS IT WAS AT 10:00 and does not move afterwards.
 * That is worth being explicit about because "stop at VWAP" is usually read as
 * a trailing stop, and a trailing VWAP is a different and worse setup — the
 * spec tested the morning extreme as an alternative and it was far worse, but
 * it never tested a trailing version at all.
 */
function plan(signal, entryPrice, stopPrice, p = DEFAULTS) {
  const params = { ...DEFAULTS, ...p };
  const risk = Math.abs(entryPrice - stopPrice);
  if (!(risk > 0)) return null;                    // rejected: nothing to size against
  return {
    entry: entryPrice,
    stop: stopPrice,
    risk,
    riskPct: (risk / entryPrice) * 100,
    target: signal === 'LONG'
      ? entryPrice + params.targetR * risk
      : entryPrice - params.targetR * risk,
    targetR: params.targetR,
  };
}

/**
 * Rank the survivors and take the top N.
 *
 * An absolute rank, not a threshold: if only one name survives, one is taken.
 * The tie-break is total morning volume, then the ticker itself — the second is
 * never going to matter, but a ranking that depends on the order a map happened
 * to be built in is not a ranking.
 */
function rank(results, p = DEFAULTS) {
  const params = { ...DEFAULTS, ...p };
  return results
    .filter(r => r.signal === 'LONG' || r.signal === 'SHORT')
    .sort((a, b) => {
      const d = b.extension - a.extension;
      if (Math.abs(d) > 1e-6) return d;
      const v = (b.volume || 0) - (a.volume || 0);
      if (v !== 0) return v;
      return a.ticker.localeCompare(b.ticker);
    })
    .slice(0, params.topN);
}

/**
 * The whole thing: bars in, picks out.
 *
 * `barsByTicker` is { TICKER: [bar…] }. The return carries the picks AND the
 * arithmetic behind every candidate, because "why is this not on the list" is
 * the question actually asked of a ranking, and it cannot be answered from the
 * list alone.
 */
function run(barsByTicker, p = DEFAULTS) {
  const params = { ...DEFAULTS, ...p };
  const all = Object.entries(barsByTicker || {})
    .map(([ticker, bars]) => evaluateTicker(ticker, bars, params));

  const picks = rank(all, params).map(r => {
    // Entry is the open of the 10:00 bar, which does not exist yet when this
    // runs live. decision_close stands in as the reference — the spec allows
    // exactly this substitution for backtesting, and live the alert says "at
    // market now" rather than quoting a price it cannot know.
    const entry = r.entryPrice != null ? r.entryPrice : r.decisionClose;
    return { ...r, plan: plan(r.signal, entry, r.decisionVwap, params) };
  }).filter(r => r.plan);       // risk == 0 is rejected

  return {
    picks,
    candidates: all,
    counts: {
      evaluated: all.length,
      skipped: all.filter(r => r.skipped).length,
      signalled: all.filter(r => r.signal !== 'NONE').length,
      invalidated: all.filter(r => r.rejectedSignal).length,
    },
    params,
  };
}

module.exports = {
  DEFAULTS, morningBars, vwapSeries, rangePosition, invalidated,
  evaluateTicker, plan, rank, run,
};
