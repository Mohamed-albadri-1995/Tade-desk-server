const express = require('express');
const { fetchNewsForTicker } = require('../sideC/news');
const r0 = require('../r0/registry');

const router = express.Router();

// GET /api/news/:ticker
router.get('/:ticker', async (req, res) => {
  const ticker = req.params.ticker.toUpperCase();
  try {
    const { news, catalyst } = await fetchNewsForTicker(ticker);
    r0.updateNews(ticker, news, catalyst);
    res.json({ ticker, news, catalyst });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
