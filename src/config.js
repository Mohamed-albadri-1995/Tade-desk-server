/*
 * Per-tool configuration.
 *
 * One codebase runs several independent tools — each a full copy of the
 * screener pointed at a different set of TradingView filters, on its own port,
 * with its own database, its own model and its own training history. Nothing is
 * shared between them, so a tool can be added or wiped without touching the
 * others.
 *
 * Everything is driven by environment variables so a tool is a pm2 entry, not a
 * fork of the code. Defaults reproduce the original single-tool setup exactly,
 * so an instance started with no environment at all behaves as before.
 *
 *   TOOL_ID=T2 TOOL_NAME="Momentum" PORT=3010 \
 *   DB_PATH=data/t2.db SCORER_URL=http://127.0.0.1:3011 \
 *   MODEL_OUTPUT_ROOT=src/scoring/outputs-t2 node src/index.js
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

// The registry of every tool — see tools.config.json. Read once here so the
// landing page, the deploy script and the seeder cannot drift apart.
function loadRegistry(key = 'tools') {
  try {
    const raw = fs.readFileSync(path.join(ROOT, 'tools.config.json'), 'utf8');
    return JSON.parse(raw)[key] || [];
  } catch (err) {
    console.warn('[Config] could not read tools.config.json:', err.message);
    return [];
  }
}

function resolve(p, fallback) {
  return path.isAbsolute(p || '') ? p : path.join(ROOT, p || fallback);
}

const TOOL_ID = process.env.TOOL_ID || 'T1';

const config = {
  // Identity — shown in the UI and on the landing page.
  toolId: TOOL_ID,
  toolName: process.env.TOOL_NAME || 'Screener',

  port: parseInt(process.env.PORT || '3000', 10),

  // Each tool owns its database outright: r0, registers, shortlist, training
  // rows and settings all live here, so tools cannot read each other's history.
  dbPath: resolve(process.env.DB_PATH, 'data/tradedesk.db'),

  // The scorer instance that serves this tool, and the model tree it writes.
  // Both must be unique per tool or two tools would train over each other.
  scorerUrl: process.env.SCORER_URL || 'http://127.0.0.1:3001',
  modelOutputRoot: resolve(process.env.MODEL_OUTPUT_ROOT, 'src/scoring/outputs'),

  // Where writeTrainingCSV drops the files the scorer trains from.
  tmpDir: resolve(process.env.TMP_DIR, 'tmp'),

  // Every tool that exists, for the landing page.
  tools: loadRegistry(),

  // Whole applications on this box — the chart platform alongside this one.
  // The landing page shows them above the screener grid so there is one address
  // to remember rather than one per program.
  apps: loadRegistry('apps'),
};

// ── capture times ──────────────────────────────────────────────────────────
// The model only ever learns from one moment a day: r1 freezes the cards, and
// r3 measures how far each ran from two entry times shortly after. Those were
// fixed at 09:36 / 09:37 / 09:40, which is right for a tool that hunts at the
// open and useless for one that does not — a screener that starts at 10:00
// would have frozen an empty register every day and never trained at all.
//
// So the times follow the tool. Each is set just after its own screeners wake
// up, which is where its candidates actually appear.
//
// What this does NOT fix: the times are still fixed per tool, so a setup that
// fires at 14:00 is measured from the tool's morning snapshot. Making the
// snapshot follow each card's own discovery time is a change to the register
// model itself, not to a schedule.
const DEFAULT_CAPTURE = { r1: '09:36', entryA: '09:37', entryB: '09:40' };
const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

function readCapture(entry) {
  const from = (entry && entry.captureAt) || {};
  // The reasoning travels with the times. A time with no stated reason is a
  // number someone has to take on trust, and the trader reading the schedule is
  // the one who has to decide whether it is right for how they trade.
  const out = { ...DEFAULT_CAPTURE, why: from.why || null };
  for (const k of ['r1', 'entryA', 'entryB']) {
    const v = process.env[`CAPTURE_${k.toUpperCase()}`] || from[k];
    if (!v) continue;
    if (!HHMM.test(v)) {
      console.warn(`[Config] ignoring invalid capture time ${k}="${v}" (use HH:MM)`);
      continue;
    }
    out[k] = v;
  }
  if (!(out.r1 < out.entryA && out.entryA < out.entryB)) {
    console.warn(`[Config] capture times must run r1 < entryA < entryB ` +
      `(got ${out.r1}, ${out.entryA}, ${out.entryB}) — falling back to defaults`);
    return { ...DEFAULT_CAPTURE };
  }
  return out;
}

// Fill in identity from the registry when only TOOL_ID was given, so a tool
// started by hand still names itself correctly.
const entry = config.tools.find(t => t.id === TOOL_ID);
if (entry && !process.env.TOOL_NAME) config.toolName = entry.name;

config.captureAt = readCapture(entry);

// Fail loudly rather than let two tools silently share state — the failure mode
// is one tool's training quietly overwriting another's model.
config.assertDistinct = function assertDistinct() {
  if (TOOL_ID !== 'T1' && config.dbPath === resolve(null, 'data/tradedesk.db')) {
    console.warn(`[Config] WARNING: ${TOOL_ID} is using the default database. ` +
      'Set DB_PATH so it does not share state with T1.');
  }
  if (TOOL_ID !== 'T1' && config.modelOutputRoot === resolve(null, 'src/scoring/outputs')) {
    console.warn(`[Config] WARNING: ${TOOL_ID} is using the default model directory. ` +
      'Set MODEL_OUTPUT_ROOT so its training does not overwrite T1.');
  }
};

module.exports = config;
