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

const path = require('path');

const ROOT = path.join(__dirname, '..');

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
};

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
