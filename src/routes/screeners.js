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

/*
 * GET /api/screeners/history — how often each screener has EVER produced a row.
 *
 * WHY A CHECK NEEDS THIS. check-screeners probes every screener once and calls
 * a zero inside its window a problem. That is a false alarm for most of them,
 * and it cost a day of chasing ghosts:
 *
 *     T1 "Big Move"  0 live at 11:34  →  flagged as a problem
 *     its archive    96 rows across 43 of 50 days, last on 2026-09-04
 *
 * It fires about twice a day and had fired on the previous trading day. A
 * screener that produces two names a day reads ZERO most of the time it is
 * asked, so a snapshot cannot tell "rare by design" from "broken" — and a
 * check that cries wolf daily is worse than no check, because the morning it
 * means it you have already learned to scroll past it. That is the same
 * lesson the 04:00 control alarm taught.
 *
 * The archive answers it, and only the tool can read its own database — which
 * is why this is an endpoint rather than check-screeners opening files.
 *
 * PARSED, NOT PATTERN-MATCHED. Rows record the screener's DISPLAY NAME in
 * screenerKeys (src/sideA/merge.js), and `LIKE '%CANSLIM%'` would count every
 * "CANSLIM Pullback" row as a CANSLIM one — the same trap why-empty.js and
 * split-tool-history.js already avoid.
 */
router.get('/history', (req, res) => {
  try {
    const db = require('../db');
    const totalDays = db.prepare('SELECT COUNT(DISTINCT date) n FROM r1_frozen').get().n;
    const byName = new Map();
    for (const row of db.prepare('SELECT date, data FROM r1_frozen').all()) {
      let keys;
      try { keys = (JSON.parse(row.data) || {}).screenerKeys; } catch { continue; }
      if (!Array.isArray(keys)) continue;
      for (const k of keys) {
        if (!byName.has(k)) byName.set(k, { rows: 0, days: new Set(), lastDate: null });
        const h = byName.get(k);
        h.rows += 1;
        h.days.add(row.date);
        if (!h.lastDate || row.date > h.lastDate) h.lastDate = row.date;
      }
    }
    const history = {};
    for (const [name, h] of byName) {
      history[name] = { rows: h.rows, days: h.days.size, lastDate: h.lastDate };
    }
    res.json({ ok: true, totalDays, history });
  } catch (err) {
    /*
     * AN ERROR IS NOT "NO HISTORY". A caller told `{}` would read every
     * screener as one that has never produced a row and report the whole tool
     * as broken — which is the exact substitution this endpoint exists to
     * stop, made one level up.
     */
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
      // How many MATCHED, not how many came back in the page. See
      // tvScanner.runScreener — the row count saturates at the limit.
      totalCount: result.totalCount,
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
