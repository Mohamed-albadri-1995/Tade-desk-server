const config = require('./config');
const db = require('./db'); // init DB

const express = require('express');
const path = require('path');
const { startScheduler } = require('./scheduler');
const r0 = require('./r0/registry');
const { toETDate } = require('./utils/time');

const app = express();
app.use(express.json());

/*
 * HTML IS NEVER CACHED WITHOUT REVALIDATING. This is the fix for a real
 * failure: a deploy finished, every process restarted, every health check
 * passed — and the browser kept showing the old page on all nine tools at
 * once. Express's sendFile defaults to `public, max-age=0`, and Android
 * Chrome will still serve a page it already has from its own memory or
 * back-forward cache without asking.
 *
 * `no-cache` does not mean "do not store", it means "ask before you use it".
 * The page is small and the answer is almost always a 304, so the cost is one
 * round trip and the benefit is that a deploy is a deploy.
 *
 * Assets keep normal caching — they are what caching is for.
 */
app.use((req, res, next) => {
  if (req.method === 'GET' && (req.path === '/' || !path.extname(req.path)
      || req.path.endsWith('.html'))) {
    res.set('Cache-Control', 'no-cache, must-revalidate');
  }
  next();
});

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
  '/api/alerts/risk',                // account size and risk per trade
  '/api/setups',                     // the setups, for the alerts app to list
  '/api/tool',                       // this tool's name and whether it is paused
  '/api/version',                    // which commit each tool is running
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
app.use('/api/tool', require('./routes/tool'));
// Does every data source return USABLE data? Slow and deliberate — a button,
// not a poll. See src/routes/datacheck.js.
app.use('/api/datacheck', require('./routes/datacheck'));
// Which commit this process loaded. Read once at startup on purpose — it must
// describe the code that is RUNNING, not the code in the working tree.
app.get('/api/version', (req, res) => res.json({ ok: true, ...require('./version').version() }));
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
// Setups: strategies that rank the whole universe at one moment, rather than
// comparing rows one at a time the way an alert rule does.
app.use('/api/setups', require('./routes/setups'));

// The tool registry, so the landing page renders whatever is configured
// rather than a list hardcoded in the page.
app.get('/api/tools', (req, res) => {
  /*
   * WITH ITS STAGE. Nine tools on one page all read with the same authority,
   * and they have not earned it equally: two are validated, several have a
   * fortnight of data and no verdict, and two were rewritten this week. The
   * day count is THIS tool's own archive — the landing page is served by one
   * tool and cannot see the others' databases — so a tool's own page shows a
   * real count and its neighbours fall back to the recorded verdict.
   */
  const stages = require('./stages');
  let days = {};
  try {
    const { getAvailableDates } = require('./warehouse/registers');
    days = { [config.toolId]: (getAvailableDates('R1') || []).length };
  } catch { /* a tool that cannot read its own archive still lists */ }
  const byId = Object.fromEntries(stages.all(days).map(s => [s.id, s]));
  res.json({
    ok: true,
    tools: config.tools.map(t => ({ ...t, ...(byId[t.id] || {}) })),
    apps: config.apps,
    stages: stages.STAGES,
  });
});

/*
 * Move a tool between stages, or back to the automatic default.
 *
 * `auto` REMOVES the override rather than writing the current answer: "put it
 * back to whatever the rule says" has to stay expressible, or a reset freezes
 * the tool at whatever stage it happened to be on that day.
 */
app.post('/api/tools/:id/stage', express.json(), (req, res) => {
  try {
    const out = require('./stages').setStage(req.params.id, req.body && req.body.stage);
    res.json({ ok: true, ...out });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

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

  // The NAME AND THE PAUSE ride on /health for the same reason `summary` does:
  // the landing page already probes this once per tool every 30 seconds, and a
  // second request per card would be nine more to carry two fields. It is also
  // what makes a rename visible on the landing page at all — the name override
  // lives in each tool's own database, so no other process can read it.
  //
  // `configName` travels beside it so the difference between "renamed" and
  // "this is what it is called" stays visible rather than mysterious.
  let identity = null;
  try {
    identity = require('./sideA/toolIdentity').identity();
  } catch { /* a tool whose settings table is unreadable still answers */ }

  res.json({
    ok: true,
    // WHICH CODE IS ANSWERING. "It says 4fa1f05" settles in one glance what
    // otherwise needs an SSH session: whether the deploy reached this process,
    // and whether the page you are looking at came from it.
    version: require('./version').version(),
    tool: config.toolId,
    name: identity ? identity.name : config.toolName,
    configName: config.toolName,
    renamed: identity ? identity.renamed : false,
    paused: identity ? identity.paused : false,
    pausedAt: identity ? identity.pausedAt : null,
    pausedReason: identity ? identity.pausedReason : null,
    // HOW LONG THIS PROCESS HAS BEEN UP. The card registry is in memory, so a
    // tool restarted a minute ago has no scan and no cards by construction —
    // and a check that cannot see the restart reports six tools as broken
    // straight after every deploy. See scripts/check-screeners.js.
    uptimeSec: Math.round(process.uptime()),
    ts: Date.now(), check, summary,
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

/*
 * Level 2: which of the nine, and the lists they share.
 *
 * The landing page used to be this page as well — apps, nine tool cards, the
 * shared shortlist, the CANSLIM list and a comparison table, in one scroll.
 * The first question of the day is "which program", and everything below the
 * answer was noise against it. Three levels now: / names the programs,
 * /screeners names the screeners, and a tool is the screener itself.
 */
app.get('/screeners', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/screeners.html'));
});

/*
 * Level 3 of the suite: the two shared lists that are not about today's tape.
 *
 * CANSLIM turns over on the earnings calendar and the comparison is a
 * month-end question. Both were strips at the bottom of the suite page, under
 * the thing you actually came for, in a space too small to render either
 * properly. Each is a page now.
 */
app.get('/screeners/canslim', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/canslim.html'));
});
app.get('/screeners/compare', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/compare.html'));
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
