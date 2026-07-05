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

// Routes
app.use('/api/registry', require('./routes/registry'));
app.use('/api/scan', require('./routes/scan'));
app.use('/api/shortlist', require('./routes/shortlist'));
app.use('/api/market', require('./routes/market'));
app.use('/api/news', require('./routes/news'));
app.use('/api/warehouse', require('./routes/warehouse'));
app.use('/api/settings', require('./routes/settings'));
app.use('/api/backup', require('./routes/backup'));
app.use('/api/monitor', require('./routes/monitor'));
app.use('/api/analysis', require('./routes/analysis'));

// Health
app.get('/health', (req, res) => res.json({ ok: true, ts: Date.now() }));

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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`[Server] Screener running on port ${PORT}`);

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
