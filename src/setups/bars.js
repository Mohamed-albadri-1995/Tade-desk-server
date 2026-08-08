/*
 * Fresh 1-minute bars for a setup's decision, and an honest account of them.
 *
 * WHY THIS IS NOT JUST A FETCH.
 *
 * The setup's stop is the session VWAP, and VWAP is volume-weighted. So the
 * volume in these bars is not a display field — it sets the price the trade is
 * risked against. Three feeds are available and none is simply best:
 *
 *   Polygon  the feed the reference numbers were derived on. No grouped
 *            endpoint for minute bars, so a universe costs one request per
 *            symbol and the free plan allows five a minute — usable for a
 *            handful of names, not for a card list.
 *   Yahoo    consolidated tape, a whole morning per request, fast enough for a
 *            real universe. Rate-limits from an AWS address.
 *   Alpaca   one request for every symbol at once. But the free tier is IEX,
 *            which carried 0.17M shares of AAPL on a morning where the
 *            consolidated tape carried 4.2M — a twenty-fifth of the volume.
 *
 * MEASURED, because the guess was wrong. On liquid names the three VWAPs agree
 * to within 0.06% — even IEX, whose tiny sample still tracks the price closely.
 * So the feed is NOT the reason a backtest number and a live number differ by
 * points; that story was told here before it was checked, and the check
 * disproved it. What the feed does change is the last decimal of a stop, and on
 * thin names rather more, which is why the source is still recorded per ticker
 * and repeated on the alert.
 *
 * THE OTHER HALF is being sure the data has actually arrived. At 10:00:00 the
 * 09:59 bar has existed for a fraction of a second and neither feed has
 * necessarily published it. Firing then would evaluate a 29-minute morning as
 * though it were the whole thing — quietly, with no error, on a slightly
 * different VWAP and a different range. So the fetch waits for the decision bar
 * and says how long it waited.
 */

const yahooClient = require('../yahoo/client');
const alpacaClient = require('../alpaca/client');
const polygonClient = require('../polygon/client');

/*
 * The order feeds are tried.
 *
 * Polygon first, because the reference numbers were derived on it and matching
 * the tape removes one variable when a live result is compared against the
 * backtest. It is a preference and nothing more — the measured disagreement
 * between these feeds on a liquid name is under 0.06%.
 *
 * Yahoo second because it is the only one that can serve a whole card list
 * quickly on the consolidated tape. Alpaca last because its free tier is IEX.
 */
/*
 * Polygon has no grouped endpoint for minute aggregates, so a universe costs
 * one request per symbol, and the free plan allows five a minute. Forty cards
 * is therefore not slow on that plan — it is impossible: the sixth call returns
 * 429 and every one after it does too.
 *
 * Asking anyway would burn the first minute of the decision on rate-limit
 * errors before falling through to a feed that could have answered
 * immediately, which is the worst possible use of 10:00. So above this size
 * Polygon is skipped outright and the log says why.
 *
 * Raise it if the plan is paid — a paid key has no per-minute cap worth
 * modelling, and then Polygon can serve the whole list.
 */
const POLYGON_MAX_SYMBOLS = Number(process.env.POLYGON_MAX_SYMBOLS || 5);

const SOURCES = [
  {
    id: 'polygon',
    available: (list) => {
      if (!polygonClient.hasKey()) return false;
      if (list.length > POLYGON_MAX_SYMBOLS) {
        console.log(`[Setups] skipping Polygon: ${list.length} symbols exceeds the `
          + `${POLYGON_MAX_SYMBOLS}/min free-plan limit (set POLYGON_MAX_SYMBOLS if paid)`);
        return false;
      }
      return true;
    },
    fetch: (tickers, date) => polygonClient.fetchIntradayBars(tickers, date),
  },
  {
    id: 'yahoo',
    available: () => true,
    fetch: (tickers, date) => yahooClient.fetchIntradayBars(tickers, date),
  },
  {
    id: 'alpaca',
    available: () => true,
    fetch: (tickers, date) => alpacaClient.fetchIntradayBars(tickers, date),
    // The feed matters enough to be named on every ticker it supplied.
    label: () => `alpaca:${alpacaClient.getFeed()}`,
  },
];

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/** Does this ticker's tape reach the decision bar? */
function reachesDecision(bars, lastWanted) {
  if (!bars || !bars.length) return false;
  return bars.some(b => b && b.etTime && b.etTime >= lastWanted);
}

/**
 * Fetch the morning's bars for a universe, waiting for the decision bar.
 *
 * `lastWanted` is the last minute that must be present — '09:59' for a 10:00
 * decision. Returns the bars plus everything needed to judge them: which feed
 * each ticker came from, which never arrived, and how long the wait was.
 *
 * Partial data is returned rather than thrown away. A universe of forty names
 * where two are missing is still a ranking over thirty-eight; refusing to
 * decide because of two would be the wrong trade-off at 10:00. The two are
 * named in the result so the gap is visible rather than inferred.
 */
async function fetchMorning(tickers, date, {
  lastWanted = '09:59',
  attempts = 6,
  waitMs = 10000,
  minCoverage = 0.8,
  // Naming a feed pins the run to it. Used by the verification script, so the
  // implementation can be held against the spec on the spec's own feed rather
  // than on whichever one happened to answer.
  only = null,
} = {}) {
  const order = only ? SOURCES.filter(s => s.id === only) : SOURCES;
  const list = [...new Set((tickers || []).map(t => String(t).toUpperCase()).filter(Boolean))];
  const started = Date.now();
  if (!list.length) {
    return { bars: {}, sources: {}, missing: [], waitedMs: 0, attempts: 0, degraded: [] };
  }

  /*
   * ONE FEED FOR THE WHOLE UNIVERSE, and this is not a preference.
   *
   * The setup RANKS by extension and takes the top two, so every candidate's
   * extension has to be measured on the same ruler. Topping up a Polygon
   * universe with Yahoo bars for the names Polygon missed produces a list where
   * some extensions were computed from one tape and some from another — and
   * those disagree by more than the gap between second place and fifth. The
   * ranking would then be partly a ranking of feeds.
   *
   * So each feed is asked for the ENTIRE universe and accepted only if it
   * covers enough of it. Mixing is the last resort, when no single feed can,
   * and it is reported rather than absorbed.
   */
  let bars = {};
  let sources = {};
  let tries = 0;
  let chosen = null;

  const coverageOf = (got) =>
    list.filter(t => reachesDecision(got[t], lastWanted)).length / list.length;

  while (tries < attempts && !chosen) {
    tries++;
    for (const src of order) {
      if (!src.available(list)) continue;
      let got;
      try {
        got = await src.fetch(list, date);
      } catch (err) {
        console.warn(`[Setups] ${src.id} bars failed:`, err.message);
        continue;
      }
      const label = src.label ? src.label() : src.id;
      const cov = coverageOf(got || {});
      // Keep the best attempt seen, so a retry that does worse cannot lose
      // ground and an exhausted loop still has the best available data.
      if (cov > coverageOf(bars)) {
        bars = {};
        sources = {};
        for (const [t, b] of Object.entries(got || {})) {
          if (b && b.length) { bars[t] = b; sources[t] = label; }
        }
      }
      if (cov >= minCoverage) { chosen = label; break; }
      console.log(`[Setups] ${src.id} covered ${Math.round(cov * 100)}% of the universe`);
    }
    if (!chosen && tries < attempts) {
      console.log(`[Setups] no feed covered ${Math.round(minCoverage * 100)}% — waiting`);
      await sleep(waitMs);
    }
  }

  /*
   * Nothing reached the bar on its own. Rather than decide on a fifth of the
   * universe, fill the gaps from the other feeds — a ranking over a mixed tape
   * is compromised, but a ranking over four names out of forty is not a
   * ranking at all. `mixed` carries the compromise to the alert.
   */
  if (!chosen) {
    for (const src of order) {
      const need = list.filter(t => !reachesDecision(bars[t], lastWanted));
      if (!need.length) break;
      if (!src.available(need)) continue;
      try {
        const got = await src.fetch(need, date);
        const label = src.label ? src.label() : src.id;
        for (const [t, b] of Object.entries(got || {})) {
          if (b && b.length && !reachesDecision(bars[t], lastWanted)) {
            bars[t] = b; sources[t] = label;
          }
        }
      } catch { /* already reported above */ }
    }
  }

  const missing = list.filter(t => !reachesDecision(bars[t], lastWanted));
  const used = [...new Set(Object.values(sources))];
  // IEX volume is a fraction of the tape, so a VWAP from it is not the level a
  // chart shows. Named per ticker so the alert can carry the caveat only where
  // it applies rather than as blanket small print.
  const degraded = Object.entries(sources)
    .filter(([, s]) => s === 'alpaca:iex')
    .map(([t]) => t);

  return {
    bars, sources, missing, degraded,
    feed: chosen || (used.length === 1 ? used[0] : null),
    // True when the candidates were not all measured on the same tape, which
    // makes the ranking partly a ranking of feeds.
    mixed: used.length > 1,
    used,
    waitedMs: Date.now() - started,
    attempts: tries,
    coverage: list.length ? (list.length - missing.length) / list.length : 1,
  };
}

module.exports = { fetchMorning, reachesDecision, SOURCES };
