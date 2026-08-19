/*
 * Alert rules and what they fired, shared across the nine tools.
 *
 * Two files beside the databases, for the same reason the shortlist and the
 * CANSLIM list live there: the trader is one person with one screen, and a rule
 * that says "tell me when anything breaks its pre-market high" is not a
 * property of T1 or of T7. Keeping rules per-tool would mean writing the same
 * rule nine times and editing it nine times.
 *
 *   data/alert-rules.json    the rules. One document, edited from one place.
 *   data/alert-fires.json    what fired, written per tool, read by everyone.
 *
 * WHY FIRES ARE WRITTEN PER TOOL. Nine processes evaluate concurrently, and a
 * single shared list would need locking to avoid losing entries. Each tool owns
 * its own key and touches nothing else, so the worst a collision can cost is
 * one tool's last write — the same trade-off the shortlist already makes, and
 * the next fire restores it.
 *
 * Rules are NOT written by the evaluating tools, only read, so the same
 * argument does not apply to them: the single writer is whichever tool is
 * serving the UI at the time.
 */

const fs = require('fs');
const path = require('path');

/*
 * The data directory, resolved WITHOUT a tool's config.
 *
 * These files belong to the desk, not to T1 — and the alerts service is its own
 * process with no database and no TOOL_ID. Deriving the path from a tool's
 * dbPath would have made a shared file depend on which tool happened to be
 * asking, which is exactly backwards.
 */
const DIR = process.env.DATA_DIR || path.join(__dirname, '..', '..', 'data');
const RULES_FILE = process.env.ALERT_RULES_FILE || path.join(DIR, 'alert-rules.json');
const FIRES_FILE = process.env.ALERT_FIRES_FILE || path.join(DIR, 'alert-fires.json');

// A day's fires, and no more. The list is a feed to glance at, not a register:
// what happened last Tuesday belongs in the outcome data, not here.
const MAX_PER_TOOL = 200;

function readJSON(file, fallback) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    return raw && typeof raw === 'object' ? raw : fallback;
  } catch {
    return fallback;              // absent or unreadable — behave as empty
  }
}

function writeJSON(file, data) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // Write-then-rename, so a reader mid-scan never sees half a file.
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, file);
    return true;
  } catch (err) {
    console.warn('[Alerts] could not write', path.basename(file), '-', err.message);
    return false;
  }
}

// ── rules ─────────────────────────────────────────────────────────────────

function listRules() {
  const state = readJSON(RULES_FILE, { rules: [] });
  return Array.isArray(state.rules) ? state.rules : [];
}

function saveRule(rule) {
  const { validate } = require('./engine');
  const errors = validate(rule);
  if (errors.length) throw new Error(errors.join('; '));

  const rules = listRules();
  const clean = {
    id: rule.id || (Math.max(0, ...rules.map(r => Number(r.id) || 0)) + 1),
    name: String(rule.name).trim().slice(0, 80),
    enabled: rule.enabled !== false,
    left: String(rule.left),
    operator: String(rule.operator),
    // A numeric right side is stored as a number so the engine never has to
    // guess whether '10' means the field or the value.
    right: (typeof rule.right === 'string' && Number.isFinite(Number(rule.right)))
      ? Number(rule.right) : rule.right,
    scope: {
      tools: [...new Set((rule.scope?.tools || []).map(t => String(t).trim().toUpperCase()).filter(Boolean))],
      tickers: [...new Set((rule.scope?.tickers || []).map(t => String(t).trim().toUpperCase()).filter(Boolean))],
    },
    updatedAt: Date.now(),
  };

  const i = rules.findIndex(r => String(r.id) === String(clean.id));
  if (i >= 0) rules[i] = { ...rules[i], ...clean };
  else rules.push(clean);

  writeJSON(RULES_FILE, { updatedAt: Date.now(), rules });
  return clean;
}

function deleteRule(id) {
  const rules = listRules();
  const left = rules.filter(r => String(r.id) !== String(id));
  if (left.length === rules.length) return false;
  writeJSON(RULES_FILE, { updatedAt: Date.now(), rules: left });
  return true;
}

// ── fires ─────────────────────────────────────────────────────────────────

/*
 * The permanent record, beside the day's feed.
 *
 * data/alert-fires.json is a FEED: newest first, capped, and reset each morning
 * so the first alert of the day does not arrive under yesterday's close. That
 * is right for reading on a phone and useless for the question that matters
 * later — "what did this setup actually signal, and when exactly?"
 *
 * So every fire is also appended here, and nothing is ever trimmed. Append-only
 * JSON-per-line rather than a JSON document, for one reason: nine processes
 * write, and rewriting a growing array from nine writers loses entries. An
 * append of one line does not, and a file that is half-written on a crash costs
 * one line rather than the file.
 *
 * One file per month, so it stays readable and a year can be deleted by
 * deleting a file. Named by the ET date the fire belongs to.
 *
 * THE TIME IS THE REAL ONE. `at` is the wall clock at the instant the fire was
 * built — not the bar it was decided on, which is `setup.decisionAt` and is
 * usually a minute earlier. Both are kept, because the gap between them is the
 * thing you want when a fill looks wrong: 10:00:07 with a 09:59 decision bar is
 * a healthy morning, 10:00:52 is not.
 */
const HISTORY_DIR = process.env.ALERT_HISTORY_DIR || path.join(DIR, 'history');

function historyFile(date) {
  const month = String(date || '').slice(0, 7) || 'undated';
  return path.join(HISTORY_DIR, `alert-history-${month}.jsonl`);
}

function appendHistory(fires, date) {
  if (!fires || !fires.length) return 0;
  try {
    fs.mkdirSync(HISTORY_DIR, { recursive: true });
    const lines = fires.map(f => JSON.stringify({
      ...f,
      date: f.date || date,
      // Exact, to the millisecond, in a form that is readable without a tool.
      // Kept ALONGSIDE the epoch rather than instead of it: the epoch is what
      // sorts and compares correctly, the string is what a person reads.
      atET: f.at ? new Date(f.at).toLocaleString('en-CA', {
        timeZone: 'America/New_York', hour12: false,
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
      }) : null,
    })).join('\n');
    fs.appendFileSync(historyFile(date), `${lines}\n`);
    return fires.length;
  } catch (err) {
    // Never throws outward. Losing the archive is bad; losing the alert that
    // was about to be delivered because the archive could not be written is
    // worse, and they are one call apart.
    console.error('[Alerts] could not append history:', err.message);
    return 0;
  }
}

/**
 * Read the record back.
 *
 * `date` selects one session; without it the whole month is returned. Newest
 * first, matching the feed, so the two read the same way.
 */
function history({ date = null, month = null, limit = 500 } = {}) {
  const file = historyFile(date || month || '');
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return [];                         // no such month — not an error
  }
  const out = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const f = JSON.parse(line);
      if (date && f.date !== date) continue;
      out.push(f);
    } catch { /* one bad line does not spoil the month */ }
  }
  return out.sort((a, b) => (b.at || 0) - (a.at || 0)).slice(0, limit);
}

/** Which sessions the record holds, newest first — for a date picker. */
function historyDates(month = null) {
  let files;
  try {
    /*
     * ALERT HISTORY ONLY, by name.
     *
     * This directory is no longer the alert feed's alone — the manager's
     * session log rotates into it by month, one line per pass, and those lines
     * carry a `date` too. Reading every .jsonl here would put a day in the
     * picker because a POSITION was watched on it, and choosing that day would
     * then show an empty feed, which reads as "the alerts were lost".
     */
    files = fs.readdirSync(HISTORY_DIR)
      .filter(f => f.startsWith('alert-history-') && f.endsWith('.jsonl'));
  } catch {
    return [];
  }
  if (month) files = files.filter(f => f.includes(month));
  const days = new Set();
  for (const f of files) {
    let raw;
    try { raw = fs.readFileSync(path.join(HISTORY_DIR, f), 'utf8'); } catch { continue; }
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try { const d = JSON.parse(line).date; if (d) days.add(d); } catch { /* skip */ }
    }
  }
  return [...days].sort().reverse();
}

/** Append this tool's fires. Only this tool's key is touched. */
function publishFires(fires, date) {
  if (!fires || !fires.length) return { published: 0 };
  // Archived first. If the feed write fails, the record still exists; the other
  // order loses the only permanent copy to the more fragile of the two writes.
  appendHistory(fires, date);
  const state = readJSON(FIRES_FILE, { tools: {} });
  state.tools = state.tools || {};
  // Required lazily: only the screeners publish, and they always have a config.
  const config = require('../config');
  const mine = state.tools[config.toolId];
  // A new day starts an empty list rather than appending to yesterday's —
  // otherwise the first alert of the morning arrives below yesterday's close.
  const keep = (mine && mine.date === date) ? (mine.fires || []) : [];
  state.tools[config.toolId] = {
    name: config.toolName,
    date,
    updatedAt: Date.now(),
    fires: [...fires, ...keep].slice(0, MAX_PER_TOOL),   // newest first
  };
  state.updatedAt = Date.now();
  writeJSON(FIRES_FILE, state);
  return { published: fires.length };
}

/** Everything that fired today, across every tool, newest first. */
function recentFires(date, limit = 100) {
  const state = readJSON(FIRES_FILE, { tools: {} });
  const out = [];
  for (const [toolId, entry] of Object.entries(state.tools || {})) {
    if (!entry || (date && entry.date !== date)) continue;
    for (const f of entry.fires || []) out.push({ ...f, toolId: f.toolId || toolId });
  }
  return out.sort((a, b) => (b.at || 0) - (a.at || 0)).slice(0, limit);
}

module.exports = {
  RULES_FILE, FIRES_FILE, MAX_PER_TOOL, HISTORY_DIR,
  listRules, saveRule, deleteRule, publishFires, recentFires,
  appendHistory, history, historyDates, historyFile,
};
