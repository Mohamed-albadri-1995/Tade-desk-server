/*
 * Fresh 1-minute bars for a setup's decision, and an honest account of them.
 *
 * WHY THIS IS NOT JUST A FETCH.
 *
 * The setup's stop is the session VWAP, and VWAP is volume-weighted. So the
 * volume in these bars is not a display field — it sets the price the trade is
 * risked against. Two feeds are available and they do not agree:
 *
 *   Yahoo   consolidated tape. Full volume, so the VWAP matches what a chart
 *           shows. Rate-limits from an AWS address, and is fetched one ticker
 *           at a time, so it is the slow one.
 *   Alpaca  one request for the whole universe, fast. But the free tier is the
 *           IEX feed, which is a few percent of the consolidated tape — a VWAP
 *           built from it is a different number from the one on the chart, and
 *           the error is not a constant offset.
 *
 * Yahoo is therefore tried first and Alpaca fills the gaps. Where Alpaca's IEX
 * feed supplied a bar, the result says so, per ticker, and the alert repeats it.
 * A wrong stop presented without qualification is worse than a late alert.
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
 * The order feeds are tried, and why it is this order.
 *
 * Polygon first because the setup's reference numbers were derived on it —
 * verifying against Yahoo gave every direction right and six of eight entry
 * prices right to the cent, while the extensions moved by up to 2.4 points.
 * The VWAP formula is identical on both sides; what differs is the volume. And
 * extension is the RANKING metric, so a feed that shifts it shifts which two
 * names are traded. Matching the feed is part of running the tested setup.
 *
 * Polygon's free plan may not serve today's bars at 10:00, and its rate limit
 * cannot carry a large universe, so it is a preference and never a requirement.
 * Whatever answered is recorded per ticker and repeated on the alert.
 */
const SOURCES = [
  {
    id: 'polygon',
    available: () => polygonClient.hasKey(),
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
      if (!src.available()) continue;
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
      if (!src.available()) continue;
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
