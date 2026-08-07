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
const config = require('../config');

const DIR = path.dirname(config.dbPath);
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

/** Append this tool's fires. Only this tool's key is touched. */
function publishFires(fires, date) {
  if (!fires || !fires.length) return { published: 0 };
  const state = readJSON(FIRES_FILE, { tools: {} });
  state.tools = state.tools || {};
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
  RULES_FILE, FIRES_FILE, MAX_PER_TOOL,
  listRules, saveRule, deleteRule, publishFires, recentFires,
};
