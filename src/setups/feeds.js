/*
 * WHICH FEED A SETUP CAN ACTUALLY DECIDE ON.
 *
 * A setup's feed is a preference (data/setup-prefs.json), and a preference can
 * name a feed that cannot serve a live decision. On 2026-09-04 `OR + VWAP
 * 09:35` was on polygon: the free plan is a day behind and allows five
 * requests a minute, so forty symbols could never finish inside the eighteen
 * seconds a clock setup has. Both attempts timed out, every day, and the desk
 * reported "MISSED THE 09:35 WINDOW" as if the platform had been slow.
 *
 * The preference was not wrong in the builder — polygon is the right feed for
 * a year of history to backtest against. It is wrong for the bar being decided
 * right now, and nothing said so. This does.
 *
 *     polygon  → alpaca when the desk has Alpaca keys, else yahoo, with a note
 *     anything else → as chosen
 *
 * THE KEYS COME FROM THE DESK'S OWN FILES, not from qp's environment: qp gets
 * them FROM here (scripts/sync-qp-env.js writes quant-platform/.env from the
 * same two files on every deploy). One source, so "the desk thinks alpaca is
 * available" and "qp has alpaca" cannot disagree.
 *
 * Nothing here reads a database, so the alerts process — which has none — can
 * ask the same question and get the same answer.
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', '..', 'data');
const KEYS_FILE = process.env.SHARED_KEYS_FILE || path.join(DATA_DIR, 'keys.json');
const BROKER_FILE = process.env.BROKER_FILE || path.join(DATA_DIR, 'broker.json');

/**
 * Why a feed cannot decide a live bar. A feed named here is never used live.
 *
 * ALL THREE ARE THE SAME LIMIT. `hybrid` and `hybrid_yahoo` are Polygon's
 * history with a second source appended for the minutes Polygon has not
 * published, so both call polygon.load ONCE PER SYMBOL before they reach the
 * part that is current (quant-platform/tools/data/hybrid.py:40,
 * hybrid_yahoo.py:70). Forty symbols at five requests a minute cannot finish
 * inside the eighteen seconds a clock setup has, whichever source fills the
 * tail — and since a live decision now bypasses the parquet cache by design,
 * every one of those forty is a fresh request, every minute.
 *
 * They are the RIGHT feeds to chart and to backtest on: deep history, and
 * consolidated volume on both sides of the seam. That is a different job from
 * deciding the bar that closed forty seconds ago, and this is the line between
 * the two.
 */
const LIVE_UNUSABLE = {
  polygon: 'polygon is a day behind on the free plan and limited to five requests '
    + 'a minute — it cannot decide a live bar',
  hybrid: 'hybrid fetches Polygon history for every symbol first, and the free plan '
    + 'allows five requests a minute — it cannot answer in the seconds a clock '
    + 'setup has',
  hybrid_yahoo: 'hybrid_yahoo fetches Polygon history for every symbol first, and the '
    + 'free plan allows five requests a minute — it cannot answer in the seconds a '
    + 'clock setup has',
};

/*
 * WHAT DECIDES WHEN NOBODY HAS CHOSEN — and it is yahoo, which is a correction.
 *
 * For part of 2026-09-04 this file made the answer alpaca, on the reasoning
 * that a real-time feed beats a delayed one because a bar that does not exist
 * cannot be traded. That reasoning ignored what the platform had already
 * measured and written down in three places:
 *
 *   tools/data/yahoo.py:16    alpaca's free tier is IEX — one morning it
 *                             carried 0.17M shares of AAPL where the
 *                             consolidated tape carried 4.2M. Four percent.
 *   tools/data/yahoo.py:22    yahoo IS consolidated, and against polygon on
 *                             the same morning the two agree on VWAP to
 *                             within 0.06%.
 *   chart/data_manager.py:25  yahoo is "the only feed here that can serve a
 *                             decision taken DURING the session".
 *
 * BOTH LIVE SETUPS STOP AT THE SESSION VWAP (chart/server.py:991). VWAP is
 * volume-weighted, so on this desk the feed does not merely supply the bars —
 * it DECIDES WHERE THE STOP SITS. qp already refuses to report a backtest of a
 * VWAP-stopped strategy run on alpaca: "the numbers below are not this
 * strategy… rerun on polygon or yahoo". Putting the LIVE desk on the feed
 * whose backtest the platform will not print is the same error with the
 * safety net removed.
 *
 * So the two failure modes are not comparable, and that is the whole argument:
 *
 *   yahoo too slow    →  the stale gate SKIPS the run. Visible, logged, and
 *                        the Control measures the lag every five minutes.
 *   alpaca on VWAP    →  a stop placed on a line drawn from four percent of
 *                        the tape. Silent, and it trades.
 *
 * A visible skip beats a silent wrong number. That is the rule this desk is
 * built on and it decides this too.
 *
 * WHAT IS NOT KNOWN, said plainly: yahoo's true intraday lag has never been
 * measured on this desk. The 0/5/5 minutes the Control reported on 2026-09-04
 * were taken while qp was serving every live decision from a parquet cache
 * keyed to the first fetch of the day — the 85 and 90 minute readings that
 * afternoon were that bug, not Yahoo. The cache is fixed; the number arrives
 * with Monday's session. If it turns out yahoo cannot hold two minutes, the
 * answer is a per-setup choice made against that measurement, not this comment.
 *
 * Alpaca stays available and stays right for a setup that is NOT
 * volume-weighted and does need the exact minute. It is chosen, not defaulted.
 */
const SUBSTITUTE = 'yahoo';

const DEFAULT_NOTE = 'no feed chosen for this setup — deciding on yahoo, which reports '
  + 'the consolidated tape (its VWAP is within 0.06% of polygon\'s) and is the only '
  + 'free feed that answers during the session. If it runs late the decision is '
  + 'skipped rather than taken on a stale bar.';

function readJson(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    return raw && typeof raw === 'object' ? raw : null;
  } catch {
    return null;
  }
}

/**
 * The Alpaca key pair the desk holds, and where it found it — or null.
 *
 * keys.json first (the shared file, entered once), then the first broker
 * destination that carries a pair. NEVER LOGGED, NEVER RETURNED BY AN API:
 * the two callers are the feed choice, which needs only "is there one", and
 * the deploy sync, which writes it to a gitignored file.
 */
function alpacaCreds() {
  const shared = readJson(KEYS_FILE);
  if (shared && shared.alpacaApiKey && shared.alpacaApiSecret) {
    return { key: String(shared.alpacaApiKey).trim(),
             secret: String(shared.alpacaApiSecret).trim(), from: 'keys.json' };
  }
  const broker = readJson(BROKER_FILE);
  for (const d of (broker && broker.destinations) || []) {
    if (d && d.alpacaKeyId && d.alpacaSecret) {
      return { key: String(d.alpacaKeyId).trim(),
               secret: String(d.alpacaSecret).trim(),
               from: `broker.json (${d.name || d.id || 'destination'})` };
    }
  }
  return null;
}

function deskHasAlpaca() { return alpacaCreds() !== null; }

/**
 * The feed a live decision will actually use, and the sentence explaining a
 * substitution — null when the preference stands.
 *
 * `chosen` is null when the setup has no preference; then the default above
 * applies and says so, because a default nobody picked is exactly the kind of
 * setting that decides a morning without anyone knowing it was there.
 */
/* No longer takes a key-availability probe: the answer is yahoo either way,
   and a parameter that cannot change the result is a parameter that reads as
   though it could. `deskHasAlpaca` is still what scripts/sync-qp-env.js asks
   before writing qp's .env — alpaca remains a feed you can CHOOSE. */
function liveFeedFor(chosen) {
  const raw = String(chosen || '').trim().toLowerCase();
  if (!raw) {
    return { feed: SUBSTITUTE, chosen: null, substituted: false, note: DEFAULT_NOTE };
  }
  const why = LIVE_UNUSABLE[raw];
  if (!why) return { feed: raw, note: null, substituted: false, chosen: raw };
  /*
   * A CONSOLIDATED FEED IS REPLACED BY A CONSOLIDATED FEED. All three
   * unusable feeds are Polygon-based and therefore whole-market; swapping one
   * for alpaca would quietly change what every volume-weighted number in the
   * strategy MEANS, on top of fixing the timeout. Yahoo changes the source of
   * the bars without changing what a bar is.
   */
  return {
    feed: SUBSTITUTE,
    chosen: raw,
    substituted: true,
    note: `${why}. Deciding on ${SUBSTITUTE} instead — it reports the same `
      + 'consolidated tape and answers during the session.',
  };
}

module.exports = { alpacaCreds, deskHasAlpaca, liveFeedFor, LIVE_UNUSABLE, DEFAULT_NOTE,
                   KEYS_FILE, BROKER_FILE };
