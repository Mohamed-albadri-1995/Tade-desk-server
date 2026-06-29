const express = require('express');
const axios = require('axios');
const { checkScorer } = require('../sideE/score');

const SCORER_URL = process.env.SCORER_URL || 'http://127.0.0.1:3001';
const router = express.Router();

// GET /api/analysis/status — scorer health
router.get('/status', async (req, res) => {
  try {
    const resp = await axios.get(`${SCORER_URL}/health`, { timeout: 3000 });
    res.json({ ok: true, ready: resp.data?.ready === true, scorer: resp.data });
  } catch {
    res.json({ ok: false, ready: false, error: 'Scorer service not reachable' });
  }
});

// POST /api/analysis/train — trigger retraining from R4A/R4B CSVs
router.post('/train', async (req, res) => {
  try {
    const body = req.body || {};
    const resp = await axios.post(`${SCORER_URL}/train`, body, { timeout: 120000 });
    res.json(resp.data);
  } catch (err) {
    const msg = err.response?.data?.error || err.message;
    res.status(500).json({ ok: false, error: msg });
  }
});

// POST /api/analysis/score — score a single card (debug/test)
router.post('/score', async (req, res) => {
  try {
    const resp = await axios.post(`${SCORER_URL}/score`, req.body, { timeout: 10000 });
    res.json(resp.data);
  } catch (err) {
    const msg = err.response?.data?.error || err.message;
    res.status(500).json({ ok: false, error: msg });
  }
});

module.exports = router;
