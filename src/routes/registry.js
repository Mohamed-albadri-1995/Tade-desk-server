const express = require('express');
const r0 = require('../r0/registry');

const router = express.Router();

// GET /api/registry/today — today's r0 rows, liveNow first then _score desc
router.get('/today', (req, res) => {
  const rows = r0.getTodayRows().sort((a, b) => {
    if (a.liveNow !== b.liveNow) return a.liveNow ? -1 : 1;
    return (b._score || 0) - (a._score || 0);
  });
  res.json({ count: rows.length, rows });
});

// GET /api/registry/all — all r0 rows
router.get('/all', (req, res) => {
  const rows = r0.getAll();
  res.json({ count: rows.length, rows });
});

module.exports = router;
