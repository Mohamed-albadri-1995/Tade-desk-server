const express = require('express');
const { getLatestSnapshot, buildMarketSnapshot } = require('../sideD/engine');

const router = express.Router();

// GET /api/market/snapshot
router.get('/snapshot', async (req, res) => {
  let snapshot = getLatestSnapshot();
  if (!snapshot) {
    try {
      snapshot = await buildMarketSnapshot();
    } catch (err) {
      return res.status(503).json({ error: 'Market data unavailable', detail: err.message });
    }
  }
  res.json(snapshot);
});

module.exports = router;
