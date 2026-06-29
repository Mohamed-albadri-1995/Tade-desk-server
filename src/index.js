require('./db'); // init DB

const express = require('express');
const path = require('path');
const { startScheduler } = require('./scheduler');

const app = express();
app.use(express.json());

// Serve frontend
app.use(express.static(path.join(__dirname, '../public')));

// Routes
app.use('/api/registry', require('./routes/registry'));
app.use('/api/scan', require('./routes/scan'));
app.use('/api/shortlist', require('./routes/shortlist'));
app.use('/api/market', require('./routes/market'));
app.use('/api/news', require('./routes/news'));
app.use('/api/warehouse', require('./routes/warehouse'));

// Health
app.get('/health', (req, res) => res.json({ ok: true, ts: Date.now() }));

// Fallback → frontend
app.get('/{*path}', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`[Server] Trade Desk running on port ${PORT}`);
  startScheduler();
});

module.exports = app;
