const express = require('express');
const {
  toggleTicker,
  getTodayShortlist,
  getAllShortlists,
  exportShortlist,
  runAutoRule,
} = require('../sideF/shortlist');

const router = express.Router();

// POST /api/shortlist/toggle/:ticker
router.post('/toggle/:ticker', (req, res) => {
  const { ticker } = req.params;
  const { date } = req.body || {};
  const result = toggleTicker(ticker.toUpperCase(), date || null);
  res.json(result);
});

// GET /api/shortlist/today
router.get('/today', (req, res) => {
  const entry = getTodayShortlist();
  res.json(entry || { date: null, items: [], exported: false, exportedAt: null });
});

// GET /api/shortlist/all
router.get('/all', (req, res) => {
  res.json(getAllShortlists());
});

// GET /api/shortlist/export/:date
router.get('/export/:date', (req, res) => {
  const result = exportShortlist(req.params.date);
  if (result === null) {
    return res.status(404).json({ error: 'No shortlist for that date' });
  }
  const filename = `shortlist${req.params.date.replace(/-/g,'')}.txt`;
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.type('text/plain').send(result);
});

// POST /api/shortlist/run-rule — manually trigger auto rule (always re-runs regardless of existing entry)
router.post('/run-rule', (req, res) => {
  const entry = runAutoRule({ force: true });
  if (!entry) {
    return res.json({ ok: false, reason: 'No stocks meet the minimum score threshold' });
  }
  res.json({ ok: true, entry });
});

// GET /api/shortlist/all-tools — the union across every tool for a date.
// Served with a permissive origin because the landing page reads it from a
// different port; see LANDING_PROBE_PATHS in index.js.
router.get('/all-tools', (req, res) => {
  try {
    const { union } = require('../sideF/globalShortlist');
    const date = req.query.date || require('../utils/time').toETDate(Date.now());
    res.json({ ok: true, date, rows: union(date) });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

/*
 * The union across every tool, as a symbol list for TradingView.
 *
 * TradingView has no public API for writing a watchlist, so this cannot push
 * anything into an account — and asking for the credentials that would allow it
 * is not a trade worth making for a list of ticker symbols. What it does have is
 * an import: a plain text file of symbols, or a comma-separated paste. So the
 * job here is to produce exactly that, from all nine tools at once, instead of
 * exporting nine files and merging them by hand.
 *
 *   ?format=csv   one line, comma separated — for pasting
 *   (default)     one per line — for "Import list…"
 *
 * Exchange-qualified where a tool supplied the symbol. A bare ticker resolves
 * to whichever listing TradingView prefers, which for a dual-listed name need
 * not be the one that was screened, so the qualified form is used wherever it
 * exists and the bare one only as a fallback.
 *
 * Unlike the per-tool export this does NOT mark anything as exported. That flag
 * records a tool's own decision about its own list; a cross-tool convenience
 * read has no business writing to nine tools' state.
 */
router.get('/all-tools/export', (req, res) => {
  try {
    const { union } = require('../sideF/globalShortlist');
    const date = req.query.date || require('../utils/time').toETDate(Date.now());
    const symbols = union(date).map(r => r.symbol || r.ticker);
    const sep = req.query.format === 'csv' ? ',' : '\n';
    res.setHeader('Content-Disposition',
      `attachment; filename="shortlist-all-${date.replace(/-/g, '')}.txt"`);
    res.type('text/plain').send(symbols.join(sep));
  } catch (err) {
    res.status(500).type('text/plain').send('');
  }
});

module.exports = router;
