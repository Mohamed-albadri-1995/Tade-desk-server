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

  const bars = {};
  const sources = {};
  let tries = 0;

  while (tries < attempts) {
    tries++;
    if (!list.some(t => !reachesDecision(bars[t], lastWanted))) break;

    // Each feed is asked only for what the ones before it could not supply.
    for (const src of order) {
      const need = list.filter(t => !reachesDecision(bars[t], lastWanted));
      if (!need.length) break;
      if (!src.available()) continue;
      try {
        const got = await src.fetch(need, date);
        const label = src.label ? src.label() : src.id;
        for (const [t, b] of Object.entries(got || {})) {
          if (b && b.length) { bars[t] = b; sources[t] = label; }
        }
      } catch (err) {
        console.warn(`[Setups] ${src.id} bars failed:`, err.message);
      }
    }

    const have = list.filter(t => reachesDecision(bars[t], lastWanted)).length;
    if (have / list.length >= minCoverage) break;
    if (tries < attempts) {
      console.log(`[Setups] ${have}/${list.length} tickers have the ${lastWanted} bar — waiting`);
      await sleep(waitMs);
    }
  }

  const missing = list.filter(t => !reachesDecision(bars[t], lastWanted));
  // IEX volume is a fraction of the tape, so a VWAP from it is not the level a
  // chart shows. Named per ticker so the alert can carry the caveat only where
  // it applies rather than as blanket small print.
  const degraded = Object.entries(sources)
    .filter(([, s]) => s === 'alpaca:iex')
    .map(([t]) => t);

  return {
    bars, sources, missing, degraded,
    waitedMs: Date.now() - started,
    attempts: tries,
    coverage: list.length ? (list.length - missing.length) / list.length : 1,
  };
}

module.exports = { fetchMorning, reachesDecision, SOURCES };
