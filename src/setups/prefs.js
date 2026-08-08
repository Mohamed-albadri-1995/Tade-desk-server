/*
 * Which setups are switched on.
 *
 * A setup is a third kind of thing on the alerts page and it was the only one
 * with nowhere to live: rules are listed and editable, fires are listed as they
 * happen, and a setup existed only in the moment it fired. You could not see
 * what setups there were, when they would run, or turn one off — and with a
 * second setup that stops being a cosmetic problem.
 *
 * The definitions stay in code, because a setup is an algorithm and not a form:
 * its windows, cutoffs and ranking are the thing that was tested. What belongs
 * to the trader is whether it runs at all, and that is what this holds.
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

module.exports = { FILE, isEnabled, setEnabled };
