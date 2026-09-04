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
 * WHAT DECIDES WHEN NOBODY HAS CHOSEN, and why it is not yahoo any more.
 *
 * A setup with no feed preference used to decide on yahoo. Yahoo's intraday
 * lag is variable — the Control measured 0, 5 and 5 minutes in ten minutes of
 * one afternoon — and a setup whose whole definition is "the 09:34 bar" cannot
 * decide on a feed that has not published 09:34 yet. The runner's stale gate
 * then skips the run, correctly and silently, which is a large part of the
 * silence this desk has been trying to explain.
 *
 * Alpaca's free tier is real time. Its cost is stated rather than hidden: it
 * is IEX only, a few percent of the tape, so VOLUME is thin and every
 * volume-weighted number computed from it — session VWAP above all — is
 * measured on that slice rather than on the consolidated tape. Prices track
 * closely; VWAP is not identical.
 *
 * That trade is taken deliberately: a level that is slightly off can still be
 * traded, a bar that does not exist cannot. Anything backtested on another
 * feed should be re-run on this one before it is trusted, and a preference on
 * the setup overrides all of it.
 */
const DEFAULT_NOTE = 'no feed chosen for this setup — deciding on alpaca, which is '
  + 'real time. Its volume is IEX only, so a session VWAP is measured on part of '
  + 'the tape; backtest on alpaca before trusting a VWAP level from it.';

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
function liveFeedFor(chosen, { hasAlpaca = deskHasAlpaca } = {}) {
  const raw = String(chosen || '').trim().toLowerCase();
  if (!raw) {
    const feed = hasAlpaca() ? 'alpaca' : 'yahoo';
    return {
      feed,
      chosen: null,
      substituted: false,
      note: feed === 'alpaca' ? DEFAULT_NOTE
        : 'no feed chosen for this setup — deciding on yahoo, which runs 0–15 minutes '
          + 'behind. Add Alpaca keys to the desk for a real-time feed.',
    };
  }
  const why = LIVE_UNUSABLE[raw];
  if (!why) return { feed: raw, note: null, substituted: false, chosen: raw };
  const feed = hasAlpaca() ? 'alpaca' : 'yahoo';
  return {
    feed,
    chosen: raw,
    substituted: true,
    note: `${why}. Deciding on ${feed} instead`
      + (feed === 'yahoo' ? ' — add Alpaca keys to the desk for a real-time feed' : '')
      + '.',
  };
}

module.exports = { alpacaCreds, deskHasAlpaca, liveFeedFor, LIVE_UNUSABLE, DEFAULT_NOTE,
                   KEYS_FILE, BROKER_FILE };
