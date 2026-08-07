/*
 * The alerts service — its own process, its own port, like every other tool.
 *
 * It does NOT evaluate. The nine screeners do that on their own scans, because
 * they already hold the cards: price, the pre-market levels, the moving
 * averages, all re-quoted every five minutes. A tenth process re-fetching the
 * same data to compare the same numbers would be a second source of truth about
 * what "crossed" means, and the two would eventually disagree.
 *
 * So this owns the parts that are genuinely its own:
 *
 *   the rules      — written here, read by all nine
 *   the feed       — every tool's fires, merged
 *   the noise      — sound, a visible banner, a browser notification if the
 *                    origin allows one
 *
 * No database and no TOOL_ID. Everything it touches is a shared file beside the
 * databases, which is why it can run without being a screener.
 *
 *   ALERTS_PORT=3090 node src/alerts/server.js
 */

const express = require('express');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const app = express();

// The screener suite and the chart tool are on other ports, so anything they
// might read from here is cross-origin by construction. Read-only endpoints.
app.use((req, res, next) => {
  if (req.method === 'GET') res.set('Access-Control-Allow-Origin', '*');
  next();
});

app.use('/api/alerts', require('../routes/alerts'));

// Where a tool lives, so the page can deep-link a fire back to its card.
app.get('/api/tools', (req, res) => {
  try {
    const reg = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools.config.json'), 'utf8'));
    res.json({ ok: true, tools: reg.tools || [], apps: reg.apps || [] });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/health', (req, res) => {
  const store = require('./store');
  res.json({
    ok: true, app: 'ALERTS', name: 'Alerts', ts: Date.now(),
    rules: store.listRules().length,
  });
});

app.use(express.static(path.join(ROOT, 'public'), { index: false }));
app.get('/{*path}', (req, res) => res.sendFile(path.join(ROOT, 'public', 'alerts.html')));

const PORT = Number(process.env.ALERTS_PORT || 3090);
// Same guard as the screener: requiring this file in a test must not take a
// port or leave a handle open behind the assertions.
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`[Alerts] service on port ${PORT}`);
    console.log(`[Alerts]   rules=${require('./store').RULES_FILE}`);
  });
}

module.exports = app;
