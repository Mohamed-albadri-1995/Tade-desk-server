const express = require('express');
const r0 = require('../r0/registry');
const { scoreRow } = require('../sideE/score');
const VALID_BIASES = ['auto', 'long', 'short'];

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

// PUT /api/registry/:ticker/bias — set bias (auto|long|short) or cycle if no body
router.put('/:ticker/bias', express.json(), (req, res) => {
  const { ticker } = req.params;
  const row = r0.getRow(ticker);
  if (!row) return res.status(404).json({ ok: false, error: 'Ticker not in r0' });

  let bias;
  if (req.body && req.body.bias && VALID_BIASES.includes(req.body.bias)) {
    bias = req.body.bias;
  } else {
    // Cycle: auto → long → short → auto
    const cycle = { auto: 'long', long: 'short', short: 'auto' };
    bias = cycle[row.bias || 'auto'] || 'long';
  }

  r0.updateBias(ticker, bias);

  // Re-score immediately with the new bias so the card reflects the change
  scoreRow(r0.getRow(ticker)).then(result => {
    if (result) r0.upsertRows([{ ...r0.getRow(ticker), ...result }]);
  }).catch(() => {});

  res.json({ ok: true, ticker, bias });
});

module.exports = router;
