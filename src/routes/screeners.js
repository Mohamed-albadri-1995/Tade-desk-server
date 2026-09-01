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
    windowNotes: require('../sideA/seedScreeners').WINDOW_NOTES,
    // The floor applies to every screener, so it belongs on the screener page
    // rather than buried in settings where nobody would connect it to a result
    // count that looked lower than expected.
    floor: (() => {
      const tradable = require('../sideA/tradable');
      const t = tradable.thresholds();
      return { ...t, rules: tradable.describe(t) };
    })(),
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

// PUT /api/screeners/:id/name — rename, and nothing else.
//
// Separate from the full update on purpose: renaming used to mean loading the
// whole definition into the editor and saving it back, which touches every
// rule, the window, the sort and the mirror for the sake of a typo. The key is
// NOT changed — it is stamped on every card this screener has ever matched.
router.put('/:id/name', express.json(), (req, res) => {
  try {
    res.json({ ok: true, screener: store.rename(Number(req.params.id), (req.body || {}).name) });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

// POST /api/screeners/:id/pause  ·  POST /api/screeners/:id/resume
//
// Pausing stops the screener LOOKING. Everything it already found stays: the
// cards keep its key, still open, and still count in every backtest they were
// already part of. That is what makes it safe to press on a hunch and undo an
// hour later, which is the only reason to have a pause rather than a delete.
router.post('/:id/pause', express.json(), (req, res) => {
  try {
    const reason = (req.body || {}).reason || null;
    res.json({ ok: true, screener: store.setPaused(Number(req.params.id), true, reason) });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

router.post('/:id/resume', (req, res) => {
  try {
    res.json({ ok: true, screener: store.setPaused(Number(req.params.id), false) });
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
