/*
 * The tool's own name, and whether it is running.
 *
 * WHY THIS IS NOT IN tools.config.json.
 *
 * `tools.config.json` is in the repo, and the deploy script reads it to decide
 * which ports to open and which services to install. A name edited there is a
 * name edited by redeploying — and worse, edited for EVERY tool at once from a
 * file none of the nine can write to.
 *
 * So the config file keeps the DEFAULT and this keeps the OVERRIDE, in the
 * settings table of the tool's own database. That database lives outside the
 * repo (see logic_audit35 — "strategies survive a deploy"), which means a
 * rename survives a deploy for exactly the same reason a user's strategies do.
 * Delete the override and the config's name comes back.
 *
 * PAUSING A WHOLE TOOL. Same store, same reasoning. Pausing stops the tool
 * SCANNING; it changes nothing that already exists:
 *
 *   what stops    new scans — scheduled and manual
 *   what does not every card, register, shortlist, backtest and setup the tool
 *                 has ever produced. They stay, they open, they still count
 *
 * That distinction is the whole reason a pause is safe to use. A pause that
 * quietly dropped a day out of the registers would be a deletion with a
 * friendlier name, and nobody could trust it enough to press it.
 *
 * WHY A TOOL WOULD BE PAUSED. Nine tools are nine experiments running at once,
 * and a broken one is worse than a missing one: it keeps writing rows that
 * look like evidence. Pausing it stops the rows without throwing away the ones
 * that were good.
 */

const db = require('../db');
const config = require('../config');

const K_NAME = 'tool.name';
const K_PAUSED = 'tool.paused';           // JSON: { at, reason }

function _get(key) {
  try {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    return row ? row.value : null;
  } catch {
    return null;
  }
}

function _set(key, value) {
  if (value === null || value === undefined) {
    db.prepare('DELETE FROM settings WHERE key = ?').run(key);
    return;
  }
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)')
    .run(key, String(value));
}

/** The name to show. The override if there is one, the config's otherwise. */
function name() {
  return _get(K_NAME) || config.toolName;
}

/** The name in the repo, kept so the UI can offer "reset to default" and so
 *  the difference is visible rather than mysterious. */
function defaultName() {
  return config.toolName;
}

function rename(next) {
  const clean = String(next || '').trim();
  if (!clean) throw new Error('name is required');
  if (clean.length > 60) throw new Error('name is too long (60 characters)');
  // Setting it back to the config's name REMOVES the override rather than
  // storing a duplicate of it, so a later change in the repo is picked up.
  _set(K_NAME, clean === config.toolName ? null : clean);
  return name();
}

function pauseState() {
  const raw = _get(K_PAUSED);
  if (!raw) return null;
  try {
    const v = JSON.parse(raw);
    return v && v.at ? v : null;
  } catch {
    return null;
  }
}

function isPaused() {
  return !!pauseState();
}

function pause(reason) {
  _set(K_PAUSED, JSON.stringify({ at: Date.now(), reason: reason || null }));
  return pauseState();
}

function resume() {
  _set(K_PAUSED, null);
  return null;
}

/** Everything a page needs to render the header and the pause banner. */
function identity() {
  const paused = pauseState();
  return {
    id: config.toolId,
    name: name(),
    defaultName: config.toolName,
    renamed: name() !== config.toolName,
    paused: !!paused,
    pausedAt: paused ? paused.at : null,
    pausedReason: paused ? paused.reason : null,
    // Said in full on the page, because a destructive-looking button needs to
    // say what it actually does before it is pressed.
    pauseMeans: 'Pausing stops new scans. Every card, register, shortlist and '
      + 'backtest this tool has already produced stays exactly as it is.',
  };
}

module.exports = {
  name, defaultName, rename, isPaused, pauseState, pause, resume, identity,
};
