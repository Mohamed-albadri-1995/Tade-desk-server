const express = require('express');
const { runFullScan, getScanStatus } = require('../pipeline');

const router = express.Router();

// POST /api/scan/run — manually trigger a full scan
router.post('/run', async (req, res) => {
  try {
    const result = await runFullScan();
    res.json({ ok: true, rowsProcessed: result.rowsProcessed, ts: result.ts });
  } catch (err) {
    console.error('[Scan] Error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /api/scan/status — scan status
router.get('/status', (req, res) => {
  res.json(getScanStatus());
});

// GET /api/scan/test — raw TV scanner probe for debugging
router.get('/test', async (req, res) => {
  const axios = require('axios');
  const TV_URL = 'https://scanner.tradingview.com/america/scan?label-product=screener-stock';
  const body = {
    columns: ['close', 'change', 'relative_volume_10d_calc'],
    filter: [
      { left: 'relative_volume_10d_calc', operation: 'greater', right: 10 },
      { left: 'close', operation: 'egreater', right: 2 },
      { left: 'average_volume_10d_calc', operation: 'greater', right: 2000000 },
    ],
    filter2: { operator: 'and', operands: [] },
    ignore_unknown_fields: true,
    markets: ['america'],
    options: { lang: 'en' },
    range: [0, 5],
    sort: { sortBy: 'relative_volume_10d_calc', sortOrder: 'desc' },
    symbols: {},
  };
  try {
    const r = await axios.post(TV_URL, body, {
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Origin': 'https://www.tradingview.com',
        'Referer': 'https://www.tradingview.com/',
      },
      timeout: 15000,
    });
    res.json({ ok: true, status: r.status, totalCount: r.data.totalCount, rowCount: (r.data.data||[]).length, sample: (r.data.data||[]).slice(0,2) });
  } catch (e) {
    res.json({ ok: false, status: e.response?.status, message: e.message, data: e.response?.data });
  }
});

module.exports = router;
