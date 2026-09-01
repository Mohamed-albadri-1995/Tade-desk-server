const express = require('express');
const { runFullScan, getScanStatus } = require('../pipeline');
const { captureR3 } = require('../sideH/capture');

const router = express.Router();

// POST /api/scan/capture-r3 — manually trigger R3 EOD capture
router.post('/capture-r3', async (req, res) => {
  const { date } = req.body || {};
  try {
    const result = await captureR3(date || undefined);
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error('[R3] Manual capture error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /api/scan/run — manually trigger a full scan
router.post('/run', async (req, res) => {
  try {
    const result = await runFullScan();
    // `paused` travels too. Without it the page said "Scan complete · 0 rows"
    // for a tool that deliberately did not scan, which is the same sentence a
    // scan that found nothing produces — and the two need different answers.
    res.json({
      ok: true,
      rowsProcessed: result && result.rowsProcessed,
      ts: result && result.ts,
      paused: !!(result && result.paused),
      pausedReason: result && result.pausedReason,
    });
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

// GET /api/scan/health — validate TV response structure against expected column types
router.get('/health', async (req, res) => {
  const axios = require('axios');
  const { COMMON_COLUMNS } = require('../sideA/tvScanner');
  const TV_URL = 'https://scanner.tradingview.com/america/scan?label-product=screener-stock';
  const TV_HEADERS = {
    'Content-Type': 'application/json',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Origin': 'https://www.tradingview.com', 'Referer': 'https://www.tradingview.com/',
    'Accept': 'application/json', 'Accept-Language': 'en-US,en;q=0.9',
  };
  const body = {
    columns: COMMON_COLUMNS,
    filter: [{ left: 'relative_volume_10d_calc', operation: 'greater', right: 10 }, { left: 'close', operation: 'egreater', right: 2 }],
    filter2: { operator: 'and', operands: [] },
    ignore_unknown_fields: true, markets: ['america'], options: { lang: 'en' }, range: [0, 3], sort: { sortBy: 'relative_volume_10d_calc', sortOrder: 'desc' }, symbols: {},
  };
  try {
    const r = await axios.post(TV_URL, body, { headers: TV_HEADERS, timeout: 15000 });
    const rows = r.data.data || [];
    if (!rows.length) return res.json({ ok: true, status: 'no_data', totalCount: r.data.totalCount, columns: COMMON_COLUMNS });
    const sample = rows[0];
    const d = sample.d || [];
    const colReport = COMMON_COLUMNS.map((col, i) => {
      const val = d[i];
      const t = val === null || val === undefined ? 'null' : typeof val;
      const preview = t === 'object' ? JSON.stringify(val).slice(0, 60) : String(val).slice(0, 30);
      return { col, index: i, type: t, preview };
    });
    const issues = colReport.filter(c => c.type === 'object' && c.col !== 'ticker-view');
    res.json({ ok: true, totalCount: r.data.totalCount, rowCount: rows.length, symbol: sample.s, columnCount: COMMON_COLUMNS.length, responseLength: d.length, issues: issues.length ? issues : 'none', columns: colReport });
  } catch (e) {
    res.json({ ok: false, status: e.response?.status, message: e.message, data: e.response?.data });
  }
});

// GET /api/scan/debug — run bigmoves scanner and return raw TV response or error
router.get('/debug', async (req, res) => {
  const axios = require('axios');
  const { COMMON_COLUMNS, SCANNERS_DEBUG } = require('../sideA/tvScanner');
  const TV_URL = 'https://scanner.tradingview.com/america/scan?label-product=screener-stock';
  const TV_HEADERS = {
    'Content-Type': 'application/json',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Origin': 'https://www.tradingview.com',
    'Referer': 'https://www.tradingview.com/',
    'Accept': 'application/json',
    'Accept-Language': 'en-US,en;q=0.9',
  };
  const body = {
    columns: COMMON_COLUMNS,
    filter: [
      { left: 'relative_volume_10d_calc', operation: 'greater', right: 10 },
      { left: 'close', operation: 'egreater', right: 2 },
      { left: 'average_volume_10d_calc', operation: 'greater', right: 2000000 },
    ],
    filter2: {
      operator: 'and',
      operands: [
        { operation: { operator: 'or', operands: [
          { operation: { operator: 'and', operands: [
            { expression: { left: 'type', operation: 'equal', right: 'stock' } },
            { expression: { left: 'typespecs', operation: 'has', right: ['common'] } }
          ]}},
          { operation: { operator: 'and', operands: [
            { expression: { left: 'type', operation: 'equal', right: 'stock' } },
            { expression: { left: 'typespecs', operation: 'has', right: ['preferred'] } }
          ]}},
          { operation: { operator: 'and', operands: [
            { expression: { left: 'type', operation: 'equal', right: 'dr' } }
          ]}},
          { operation: { operator: 'and', operands: [
            { expression: { left: 'type', operation: 'equal', right: 'fund' } },
            { expression: { left: 'typespecs', operation: 'has_none_of', right: ['etf', 'mutual', 'closedend'] } }
          ]}}
        ]}},
        { expression: { left: 'typespecs', operation: 'has_none_of', right: ['pre-ipo'] } }
      ]
    },
    ignore_unknown_fields: true,
    markets: ['america'],
    options: { lang: 'en' },
    range: [0, 50],
    sort: { sortBy: 'relative_volume_10d_calc', sortOrder: 'desc' },
    symbols: {},
  };
  try {
    const r = await axios.post(TV_URL, body, { headers: TV_HEADERS, timeout: 15000 });
    res.json({ ok: true, status: r.status, totalCount: r.data.totalCount, rowCount: (r.data.data||[]).length, columns: COMMON_COLUMNS.length, sample: (r.data.data||[]).slice(0,2) });
  } catch (e) {
    res.json({ ok: false, status: e.response?.status, message: e.message, data: e.response?.data });
  }
});

module.exports = router;
