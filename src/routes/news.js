const express = require('express');
const { fetchNewsForTicker } = require('../sideC/news');
const { combineCatalyst } = require('../sideC/technical');
const r0 = require('../r0/registry');

const router = express.Router();

// GET /api/news/:ticker
router.get('/:ticker', async (req, res) => {
  const ticker = req.params.ticker.toUpperCase();
  try {
    const stock = r0.getRow(ticker)?.stock;
    const { news, catalyst } = await fetchNewsForTicker(ticker, stock && stock.tvSymbol);
    const combined = combineCatalyst(catalyst, stock);
    r0.updateNews(ticker, news, combined);
    res.json({ ticker, news, catalyst: combined });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
