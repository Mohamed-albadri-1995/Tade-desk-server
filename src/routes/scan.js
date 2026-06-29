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

module.exports = router;
