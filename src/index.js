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
  '/api/shortlist/all-tools/export', // …and it as a TradingView symbol list
  '/api/canslim',                    // the shared growth-stock list
  '/api/alerts/rules',               // the alert rules
  '/api/alerts/fires',               // …and what they fired today
  '/api/alerts/meta',                // fields and operators for the builder
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
// The one list that is shared rather than per-tool, so the landing page can
// show it once instead of nine times. Any tool can answer it — see the route.
app.use('/api/canslim', require('./routes/canslim'));
// Alert rules and the day's fires. Shared files, so any tool can serve them.
app.use('/api/alerts', require('./routes/alerts'));

// The tool registry, so the landing page renders whatever is configured
// rather than a list hardcoded in the page.
app.get('/api/tools', (req, res) => res.json({
  ok: true, tools: config.tools, apps: config.apps,
}));

// Health — reports which tool answered, so probing the wrong port is obvious.
// It also carries when this tool is worth OPENING, because the landing page
// lists nine of them and the useful question there is "which of these should I
// be looking at right now" rather than "which are running".
app.get('/health', (req, res) => {
  let check = null;
  try {
    const store = require('./sideA/screenerStore');
    const list = store.list({ enabledOnly: true });
    const w = store.checkWindow(list);
    check = w ? {
      from: w.from, to: w.to,
      now: list.some(s => store.isWorthCheckingAt(s)),
      screeners: list.map(s => ({
        name: s.name,
        from: s.checkFrom || s.runFrom || '04:00',
        to: s.checkTo || s.runTo || '16:00',
        now: store.isWorthCheckingAt(s),
      })),
    } : null;
  } catch { /* a tool with no screeners yet still answers */ }

  // What this tool actually screens for, generated from the live definitions.
  // Carried on /health rather than on an endpoint of its own because the
  // landing page already probes this once per tool every 30 seconds — a second
  // request per card would be nine more, to say something that changes only
  // when a screener is edited.
  let summary = null;
  try {
    summary = require('./sideA/screenerSummary').summarise();
  } catch { /* same as check: a tool with no screeners still answers */ }

  res.json({
    ok: true, tool: config.toolId, name: config.toolName, ts: Date.now(), check, summary,
  });
});

/*
 * An unknown /api path is a 404, not the landing page.
 *
 * The catch-all below serves home.html for anything unmatched, which is right
 * for a browser URL and badly wrong for an API call: the caller gets HTTP 200
 * and a page of HTML where it asked for data. That is what happened when the
 * TradingView export was called against a server that had not been restarted
 * yet — the fetch succeeded, the response looked fine to `r.ok`, and the whole
 * landing page ended up on the clipboard.
 *
 * A 404 makes the same situation obvious at the first hop instead of the last.
 * Placed after every API router and before the SPA fallback, so it only sees
 * paths nothing else claimed.
 */
app.use('/api', (req, res) => {
  res.status(404).json({ ok: false, error: 'No such endpoint', path: req.originalUrl });
});

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

/*
 * Only listen when this file is the program being run.
 *
 * pm2 starts it as `node src/index.js`, so the server binds exactly as before.
 * A test that requires it gets the configured app and nothing else — no port
 * taken, no scheduler started, no open handle keeping the process alive after
 * the assertions finish.
 *
 * Without this, the route ORDER could not be tested at all, and that is where
 * the unmatched-/api bug lived: any test mounting the routers on their own
 * would pass while the deployed app went on serving HTML for unknown API paths.
 */
const PORT = config.port;
if (require.main === module) app.listen(PORT, () => {
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
