/*
 * Which setups are switched on.
 *
 * A setup is a third kind of thing on the alerts page and it was the only one
 * with nowhere to live: rules are listed and editable, fires are listed as they
 * happen, and a setup existed only in the moment it fired. You could not see
 * what setups there were, when they would run, or turn one off — and with a
 * second setup that stops being a cosmetic problem.
 *
 * The definition stays in qp, because a setup is an algorithm and not a form:
 * its windows, cutoffs and rules are the thing that was tested, and they are
 * edited in the builder that tested them. What belongs to this side is whether
 * it runs at all — plus the few things qp cannot see, which is what this holds.
 *
 * data/setup-prefs.json, beside the alert rules and the risk settings, for the
 * same reason: the alerts app has no database and must be able to write it,
 * while the screener process that runs the setup must be able to read it.
 *
 * Absent means enabled. A setup that is defined and deployed is meant to run;
 * requiring a file to exist before anything works would make a missing file
 * look like a broken scheduler.
 */

const fs = require('fs');
const path = require('path');

const DIR = process.env.DATA_DIR || path.join(__dirname, '..', '..', 'data');
const FILE = process.env.SETUP_PREFS_FILE || path.join(DIR, 'setup-prefs.json');

function read() {
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return raw && typeof raw === 'object' && raw.setups ? raw : { setups: {} };
  } catch {
    return { setups: {} };
  }
}

/** Is this setup switched on? Unknown means yes — see the note above. */
function isEnabled(setupId) {
  const entry = read().setups[setupId];
  return !entry || entry.enabled !== false;
}

/*
 * Everything else the screener holds about a setup whose definition lives in
 * qp: the card-field filter, how many to take, the feed. Preferences ABOUT a
 * setup rather than a definition OF one — the definition is the qp strategy,
 * and duplicating any of it here would put two copies out of step.
 */
function settingsFor(setupId) {
  const e = read().setups[setupId] || {};
  return {
    universe: e.universe || null,
    topN: e.topN || null,
    tf: e.tf || null,
    feed: e.feed || null,
    /*
     * WHICH BARS qp EVALUATES ON — 'all' (with pre/post) or 'regular' (RTH).
     *
     * A setting rather than a constant because it must match the backtest that
     * validated the setup, and the backtest has always had a view control.
     * Absent means the backtest's own default, 'all'.
     */
    view: e.view || null,
    targetR: e.targetR || null,
    fill: e.fill || null,
    caution: e.caution || null,
    /*
     * Does THIS setup send real orders?
     *
     * Separate from the broker being armed, and off unless it is explicitly
     * true. Arming is one switch for the account — "this box may place orders
     * at all" — and without a second switch per setup it would also mean every
     * setup that exists, including one assigned to a tool five minutes ago to
     * see what it does. A strategy earns this one backtest at a time.
     */
    autoTrade: e.autoTrade === true,
    /*
     * WHICH accounts this setup's orders go to, by destination id.
     *
     * autoTrade says WHETHER orders are placed without being asked; this says
     * WHERE they go, and the two are deliberately separate because the four
     * things worth expressing need both:
     *
     *   auto to two accounts    autoTrade true,  brokers ['ttp', 'alpaca']
     *   auto to one             autoTrade true,  brokers ['alpaca']
     *   alert only              autoTrade false, brokers []
     *   by hand, to one account autoTrade false, brokers ['alpaca']
     *
     * The last is the one that needed the split. A setup being trialled should
     * be looked at before it is bought, but when it IS bought there is nothing
     * to think about — it goes to the account that strategy belongs in, and
     * choosing again at 09:36 is how it goes to the wrong one.
     *
     * Empty means unsaid rather than none: with a single account configured
     * there is nothing to decide, and with two, broker.route refuses instead of
     * picking. See the note there.
     */
    brokers: Array.isArray(e.brokers) ? e.brokers.map(String) : [],
    /*
     * The most orders THIS setup may place in a session.
     *
     * Separate from the account's cap, because they answer different questions:
     * "how much am I willing to trade at all" and "how much of that is this one
     * idea allowed". A setup that ranks top 2 normally places two, so a cap of
     * one is how a strategy is trialled with real money without giving it the
     * day.
     */
    maxTradesPerDay: e.maxTradesPerDay || null,
    /*
     * Setup-level risk, overriding the account's for this setup alone.
     *
     * The account figure answers "what may a trade lose". This answers "what
     * may THIS strategy lose", which is a smaller number while a strategy is
     * young. Absent means the account's, so nothing has to be set for the
     * normal case.
     */
    riskPerTrade: e.riskPerTrade || null,
    maxPositionPct: e.maxPositionPct || null,
    /*
     * HOW the day's signals are ranked against each other, and there is no
     * default on purpose.
     *
     * An assumed metric turned a backtest of OR+VWAP 09:35 into "the two widest
     * opening ranges per day" and threw away 103 of 117 signals on a criterion
     * its spec never mentions. Unset here means unset: every signal is taken,
     * which is the only answer that invents no preference.
     */
    rankMetric: e.rankMetric || null,
    rankDirection: e.rankDirection || null,
  };
}

/** Save those settings. Only the keys given are touched. */
function saveSettings(setupId, patch) {
  const state = read();
  state.setups = state.setups || {};
  const cur = state.setups[setupId] || {};
  const next = { ...cur };
  for (const k of ['universe', 'topN', 'tf', 'feed', 'view', 'targetR', 'fill', 'caution',
                   'maxTradesPerDay', 'riskPerTrade', 'maxPositionPct',
                   'rankMetric', 'rankDirection']) {
    if (!(k in patch)) continue;
    const v = patch[k];
    if (v === null || v === '' || v === undefined) delete next[k];
    else next[k] = v;
  }
  /*
   * A PERCENTAGE, refused where it is typed.
   *
   * It divides into 100 to decide how many positions fit at once, so 0 is an
   * infinity and 600 is a position six times the account. Stored either would
   * read back as a real preference and size an order from it. The desk-wide
   * figure has had this check since it existed; the per-setup one is newer and
   * went in without it.
   */
  if (next.maxPositionPct != null) {
    const n = Number(next.maxPositionPct);
    if (!Number.isFinite(n) || n <= 0 || n > 100) {
      throw new Error('max position % must be between 1 and 100 — '
        + 'leave it blank to use the account\'s');
    }
    next.maxPositionPct = n;
  }

  // Only ever true by being said so. A truthy string or a stray 1 must not be
  // what turns a setup into one that spends money.
  if ('autoTrade' in patch) next.autoTrade = patch.autoTrade === true;
  /*
   * Routing, checked against the destinations that actually exist.
   *
   * A typo here is not a validation nicety: 'alpca' would store cleanly, read
   * back as a real preference, and then either send nowhere or — worse, if the
   * unknown id were merely dropped — fall through to whatever the default was.
   * Refused where it is typed, like the ranking count above.
   */
  if ('brokers' in patch) {
    const want = Array.isArray(patch.brokers) ? patch.brokers.map(String).filter(Boolean) : [];
    if (!want.length) delete next.brokers;
    else {
      const known = require('../broker/signalstack').destinations().map(d => d.id);
      const bad = want.filter(id => !known.includes(id));
      if (bad.length) {
        throw new Error(`no broker called ${bad.join(', ')}`
          + (known.length ? ` — configured: ${known.join(', ')}`
                          : ' — no brokers are configured yet'));
      }
      next.brokers = [...new Set(want)];
    }
  }
  /*
   * A count without a metric is not a preference, it is a trap: it takes n of
   * an unordered list and looks exactly like a ranking. Refused where it is
   * typed, so it never reaches a morning.
   */
  if (next.topN && !next.rankMetric) {
    throw new Error('choose what to rank by before setting a count — '
      + '"top 2" of an unranked list is the first 2 in card order, not the best 2');
  }
  if (next.universe) {
    const errors = require('./universe').validate(next.universe);
    if (errors.length) throw new Error(errors.join('; '));
  }
  next.updatedAt = Date.now();
  state.setups[setupId] = next;
  state.updatedAt = Date.now();
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  const tmp = `${FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, FILE);
  return settingsFor(setupId);
}

function setEnabled(setupId, enabled) {
  const state = read();
  state.setups = state.setups || {};
  state.setups[setupId] = {
    ...(state.setups[setupId] || {}),
    enabled: enabled !== false,
    updatedAt: Date.now(),
  };
  state.updatedAt = Date.now();
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  const tmp = `${FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, FILE);
  return isEnabled(setupId);
}

module.exports = { FILE, isEnabled, setEnabled, settingsFor, saveSettings };
