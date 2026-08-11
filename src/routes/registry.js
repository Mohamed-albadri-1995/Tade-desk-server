const express = require('express');
const r0 = require('../r0/registry');
const { scoreRow } = require('../sideE/score');
const VALID_BIASES = ['auto', 'long', 'short'];

const router = express.Router();

// GET /api/registry?tickers=AAPL,MSFT — r0 rows for the given tickers.
// Used by the trading session's 30-second context poll (9:35–10:00 window)
// to refresh scanner context (regime, secBias, shortTerm/mid/long, secScore, …)
// for the shortlisted tickers without pulling the entire registry.
router.get('/', (req, res) => {
  const raw = (req.query.tickers || '').trim();
  if (!raw) {
    // Fall back to today's rows so the endpoint is self-explanatory.
    const rows = r0.getTodayRows();
    return res.json({ count: rows.length, rows });
  }
  const wanted = new Set(raw.split(',').map(t => t.trim().toUpperCase()).filter(Boolean));
  const rows = r0.getAll().filter(row => wanted.has(String(row.ticker || '').toUpperCase()));
  res.json({ count: rows.length, rows });
});

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
router.put('/:ticker/bias', express.json(), async (req, res) => {
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

  // Await re-score so the response includes the updated score
  try {
    const result = await scoreRow(r0.getRow(ticker));
    if (result) r0.upsertRows([{ ...r0.getRow(ticker), ...result }]);
    const updated = r0.getRow(ticker);
    return res.json({ ok: true, ticker, bias, _score: updated._score, _scoreDetails: updated._scoreDetails });
  } catch {
    return res.json({ ok: true, ticker, bias });
  }
});

module.exports = router;
