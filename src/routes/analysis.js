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

// GET /api/analysis/table-data?base=B4&table=main
// Returns factor_importance + all factor bucket CSVs for a given base/table
const OUTPUTS_DIR = path.join(__dirname, '..', 'scoring', 'outputs');
const VALID_BASES = ['B1','B2','B3','B4','B5','B6'];

router.get('/table-data', (req, res) => {
  const base = (req.query.base || '').toUpperCase();
  const table = req.query.table || 'main'; // 'main' or 'sub_uptrend' etc.

  if (!VALID_BASES.includes(base)) {
    return res.status(400).json({ ok: false, error: 'base must be B1–B6' });
  }

  const dir = path.join(OUTPUTS_DIR, base, table);
  if (!fs.existsSync(dir)) {
    return res.status(404).json({ ok: false, error: `Table not found: ${base}/${table}` });
  }

  function parseCSV(filepath) {
    if (!fs.existsSync(filepath)) return null;
    const lines = fs.readFileSync(filepath, 'utf8').trim().split('\n');
    if (lines.length < 2) return [];
    const headers = lines[0].split(',');
    return lines.slice(1).map(line => {
      const vals = line.split(',');
      const obj = {};
      headers.forEach((h, i) => {
        const v = vals[i];
        obj[h] = isNaN(v) || v === '' ? v : Number(v);
      });
      return obj;
    });
  }

  // Find all factor bucket files
  const files = fs.readdirSync(dir);
  const factorFiles = files.filter(f => /^factor_\d+_buckets\.csv$/.test(f)).sort();
  const factors = factorFiles.map(fname => {
    const num = parseInt(fname.match(/factor_(\d+)_buckets/)[1]);
    return { factor: num, buckets: parseCSV(path.join(dir, fname)) };
  });

  const importance = parseCSV(path.join(dir, 'factor_importance.csv'));

  // List all available tables for this base
  const baseDir = path.join(OUTPUTS_DIR, base);
  const availableTables = fs.existsSync(baseDir)
    ? fs.readdirSync(baseDir).filter(d => fs.statSync(path.join(baseDir, d)).isDirectory())
    : [];

  res.json({ ok: true, base, table, importance, factors, availableTables });
});

// GET /api/analysis/available-tables — list all trained bases and their tables
router.get('/available-tables', (req, res) => {
  if (!fs.existsSync(OUTPUTS_DIR)) {
    return res.json({ ok: true, bases: {} });
  }
  const result = {};
  for (const base of VALID_BASES) {
    const baseDir = path.join(OUTPUTS_DIR, base);
    if (!fs.existsSync(baseDir)) continue;
    result[base] = fs.readdirSync(baseDir)
      .filter(d => fs.statSync(path.join(baseDir, d)).isDirectory());
  }
  res.json({ ok: true, bases: result });
});

module.exports = router;
