const config = require('./config');
const db = require('./db'); // init DB

const express = require('express');
const path = require('path');
const { startScheduler } = require('./scheduler');
const r0 = require('./r0/registry');
const { toETDate } = require('./utils/time');

const app = express();
app.use(express.json());

// Serve frontend
app.use(express.static(path.join(__dirname, '../public'), { index: false }));

// The landing page is served by one tool but probes the others, and a
// different port is a different origin, so those probes are cross-origin and
// the browser drops the response without these headers — a healthy tool then
// renders as offline. Limited to the read-only endpoints the landing page uses;
// everything else stays same-origin only.
// The landing page is served from one tool's port and reads from all of them,
// so these few GETs are cross-origin by construction. Kept to an explicit list:
// everything else stays same-origin only.
const LANDING_PROBE_PATHS = [
  '/health', '/api/tools', '/api/registry/today', '/api/analysis/status',
  '/api/analysis/screener-report',   // the month-end comparison across tools
  '/api/shortlist/all-tools',        // the unified shortlist
];
app.use((req, res, next) => {
  if (req.method === 'GET' && LANDING_PROBE_PATHS.includes(req.path)) {
    res.set('Access-Control-Allow-Origin', '*');
  }
  next();
});

// Routes
app.use('/api/registry', require('./routes/registry'));
app.use('/api/scan', require('./routes/scan'));
app.use('/api/screeners', require('./routes/screeners'));
app.use('/api/shortlist', require('./routes/shortlist'));
app.use('/api/market', require('./routes/market'));
app.use('/api/news', require('./routes/news'));
app.use('/api/warehouse', require('./routes/warehouse'));
app.use('/api/settings', require('./routes/settings'));
app.use('/api/backup', require('./routes/backup'));
app.use('/api/monitor', require('./routes/monitor'));
app.use('/api/analysis', require('./routes/analysis'));
app.use('/api/card', require('./routes/card'));

// The tool registry, so the landing page renders whatever is configured
// rather than a list hardcoded in the page.
app.get('/api/tools', (req, res) => res.json({
  ok: true, tools: config.tools, apps: config.apps,
}));

// Health — reports which tool answered, so probing the wrong port is obvious
app.get('/health', (req, res) => res.json({
  ok: true, tool: config.toolId, name: config.toolName, ts: Date.now(),
}));

// Landing page
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/home.html'));
});

// Scanner — serves scanner SPA for all /scanner/* paths
app.get('/scanner', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});
app.get('/scanner/*path', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

// Fallback → home
app.get('/{*path}', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/home.html'));
});

config.assertDistinct();
require('./sideA/seedScreeners').seedScreeners();

const PORT = config.port;
app.listen(PORT, () => {
  console.log(`[Server] ${config.toolName} (${config.toolId}) running on port ${PORT}`);
  console.log(`[Server]   db=${config.dbPath}`);
  console.log(`[Server]   model=${config.modelOutputRoot}  scorer=${config.scorerUrl}`);

  // Restore r0 from today's checkpoint if available (mid-day restart recovery)
  try {
    const today = toETDate(Date.now());
    const cp = db.prepare('SELECT date, data, saved_at FROM r0_checkpoint WHERE id = 1').get();
    if (cp && cp.date === today) {
      const rows = JSON.parse(cp.data);
      r0.restore(rows);
      console.log(`[Startup] r0 restored from checkpoint: ${rows.length} rows from ${cp.date}`);
    }
  } catch (err) {
    console.warn('[Startup] Checkpoint restore failed:', err.message);
  }

  // One-time migration: if r4a_train / r4b_train are empty but legacy
  // tmp/r4a.csv / tmp/r4b.csv exist, import them so existing training
  // data is preserved across the upgrade.
  try {
    const training = require('./training/trainingData');
    training.migrateFromTmpCSV();
  } catch (err) {
    console.warn('[Startup] Training data migration failed:', err.message);
  }

  startScheduler();
});

module.exports = app;
