const express = require('express');
const store = require('../sideA/screenerStore');
const { testScreener } = require('../sideA/tvScanner');
const config = require('../config');

const router = express.Router();

// GET /api/screeners/meta — fields and operators the builder offers.
// Served from the same lists the validator uses, so the UI can never present
// an option the API would reject.
router.get('/meta', (req, res) => {
  res.json({
    ok: true,
    // captureAt travels with the tool so the schedule strip can draw the two
    // moments that decide what this tool ever learns from — when the cards
    // freeze, and the entries their outcomes are measured against.
    tool: { id: config.toolId, name: config.toolName, captureAt: config.captureAt },
    fields: store.FIELDS,
    operations: store.OPERATIONS,
  });
});

// GET /api/screeners — every screener this tool defines
router.get('/', (req, res) => {
  try {
    res.json({ ok: true, screeners: store.list() });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /api/screeners/test — run a definition without saving it
router.post('/test', express.json(), async (req, res) => {
  const def = req.body || {};
  const errors = store.validateDefinition({ name: def.name || 'test', ...def });
  if (errors.length) {
    return res.status(400).json({ ok: false, error: errors.join('; ') });
  }
  try {
    const result = await testScreener(def);
    res.json({
      ok: true,
      count: result.count,
      ms: result.ms,
      // a short preview so the trader can sanity-check what matched
      sample: result.rows.slice(0, 10).map(r => ({
        ticker: r.ticker,
        price: r.stock?.price,
        change: r.stock?.change,
        rvol: r.stock?.rvol,
      })),
    });
  } catch (err) {
    const detail = err.response?.data ? JSON.stringify(err.response.data).slice(0, 300) : '';
    res.status(500).json({ ok: false, error: `${err.message}${detail ? ' — ' + detail : ''}` });
  }
});

// POST /api/screeners — create
router.post('/', express.json(), (req, res) => {
  try {
    res.json({ ok: true, screener: store.create(req.body || {}) });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

// PUT /api/screeners/:id — update (partial; omitted fields keep their value)
router.put('/:id', express.json(), (req, res) => {
  try {
    res.json({ ok: true, screener: store.update(Number(req.params.id), req.body || {}) });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

// POST /api/screeners/:id/mirror — store the opposite-facing twin
router.post('/:id/mirror', (req, res) => {
  try {
    res.json({ ok: true, screener: store.createMirror(Number(req.params.id)) });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

// POST /api/screeners/preview-mirror — what the mirror WOULD be, unsaved
router.post('/preview-mirror', express.json(), (req, res) => {
  try {
    res.json({ ok: true, definition: store.mirrorDefinition(req.body || {}) });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

// DELETE /api/screeners/:id
router.delete('/:id', (req, res) => {
  try {
    const removed = store.remove(Number(req.params.id));
    if (!removed) return res.status(404).json({ ok: false, error: 'Not found' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
