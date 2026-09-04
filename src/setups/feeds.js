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

/** Why a feed cannot decide a live bar. A feed named here is never used live. */
const LIVE_UNUSABLE = {
  polygon: 'polygon is a day behind on the free plan and limited to five requests '
    + 'a minute — it cannot decide a live bar',
};

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
 */
function liveFeedFor(chosen, { hasAlpaca = deskHasAlpaca } = {}) {
  const want = String(chosen || 'yahoo').toLowerCase();
  const why = LIVE_UNUSABLE[want];
  if (!why) return { feed: want, note: null, substituted: false, chosen: want };
  const feed = hasAlpaca() ? 'alpaca' : 'yahoo';
  return {
    feed,
    chosen: want,
    substituted: true,
    note: `${why}. Deciding on ${feed} instead`
      + (feed === 'yahoo' ? ' — add Alpaca keys to the desk for a real-time feed' : '')
      + '.',
  };
}

module.exports = { alpacaCreds, deskHasAlpaca, liveFeedFor, LIVE_UNUSABLE,
                   KEYS_FILE, BROKER_FILE };
