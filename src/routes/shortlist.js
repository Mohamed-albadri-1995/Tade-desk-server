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
  const result = toggleTicker(ticker.toUpperCase());
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
  res.type('text/plain').send(result);
});

// POST /api/shortlist/run-rule — manually trigger auto rule
router.post('/run-rule', (req, res) => {
  const entry = runAutoRule();
  res.json({ ok: true, entry });
});

module.exports = router;
