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
     * The most orders THIS setup may place in a session.
     *
     * Separate from the account's cap, because they answer different questions:
     * "how much am I willing to trade at all" and "how much of that is this one
     * idea allowed". A setup that ranks top 2 normally places two, so a cap of
     * one is how a strategy is trialled with real money without giving it the
     * day.
     */
    maxTradesPerDay: e.maxTradesPerDay || null,
  };
}

/** Save those settings. Only the keys given are touched. */
function saveSettings(setupId, patch) {
  const state = read();
  state.setups = state.setups || {};
  const cur = state.setups[setupId] || {};
  const next = { ...cur };
  for (const k of ['universe', 'topN', 'tf', 'feed', 'targetR', 'fill', 'caution',
                   'maxTradesPerDay']) {
    if (!(k in patch)) continue;
    const v = patch[k];
    if (v === null || v === '' || v === undefined) delete next[k];
    else next[k] = v;
  }
  // Only ever true by being said so. A truthy string or a stray 1 must not be
  // what turns a setup into one that spends money.
  if ('autoTrade' in patch) next.autoTrade = patch.autoTrade === true;
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
