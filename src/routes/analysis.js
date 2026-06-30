const express = require('express');
const axios = require('axios');
const path = require('path');
const fs = require('fs');
const multer = require('multer');

const SCORER_URL = process.env.SCORER_URL || 'http://127.0.0.1:3001';
const router = express.Router();

const TMP_DIR = path.join(__dirname, '..', '..', 'tmp');
const upload = multer({ dest: TMP_DIR });

// GET /api/analysis/status — scorer health
router.get('/status', async (req, res) => {
  try {
    const resp = await axios.get(`${SCORER_URL}/health`, { timeout: 3000 });
    res.json({ ok: true, ready: resp.data?.ready === true, scorer: resp.data });
  } catch {
    res.json({ ok: false, ready: false, error: 'Scorer service not reachable' });
  }
});

// GET /api/analysis/model-info — factor compositions for explainability
router.get('/model-info', async (req, res) => {
  try {
    const resp = await axios.get(`${SCORER_URL}/model-info`, { timeout: 10000 });
    res.json(resp.data);
  } catch (err) {
    const msg = err.response?.data?.error || err.message;
    res.status(500).json({ ok: false, error: msg });
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

// POST /api/analysis/upload-csv?register=r4a|r4b&mode=replace|append
// Accepts a CSV file upload and saves/appends to tmp/r4a.csv or tmp/r4b.csv
router.post('/upload-csv', upload.single('file'), (req, res) => {
  try {
    const register = (req.query.register || '').toLowerCase();
    if (!['r4a', 'r4b'].includes(register)) {
      return res.status(400).json({ ok: false, error: 'register must be r4a or r4b' });
    }
    if (!req.file) {
      return res.status(400).json({ ok: false, error: 'No file uploaded' });
    }

    const mode = req.query.mode || 'append';
    const destPath = path.join(TMP_DIR, `${register}.csv`);
    const uploadedPath = req.file.path;

    fs.mkdirSync(TMP_DIR, { recursive: true });

    if (mode === 'replace' || !fs.existsSync(destPath)) {
      fs.renameSync(uploadedPath, destPath);
    } else {
      // Append: skip header row of uploaded file, append data rows
      const uploaded = fs.readFileSync(uploadedPath, 'utf8');
      const lines = uploaded.split('\n');
      const dataLines = lines.slice(1).filter(l => l.trim()); // skip header
      const existing = fs.readFileSync(destPath, 'utf8');
      const needsNewline = existing.length && !existing.endsWith('\n');
      fs.appendFileSync(destPath, (needsNewline ? '\n' : '') + dataLines.join('\n') + '\n', 'utf8');
      fs.unlinkSync(uploadedPath);
    }

    // Count rows in the resulting file
    const content = fs.readFileSync(destPath, 'utf8');
    const rows = content.split('\n').filter(l => l.trim()).length - 1; // minus header

    res.json({ ok: true, register, mode, path: destPath, rows });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
