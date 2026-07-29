const express = require('express');
const axios = require('axios');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const training = require('../training/trainingData');

const config = require('../config');

const SCORER_URL = config.scorerUrl;
const router = express.Router();

const TMP_DIR = config.tmpDir;
// The model tree this tool reads. Per-tool, so two tools never display or
// train over each other's tables.
const OUTPUTS_DIR = config.modelOutputRoot;
const upload = multer({ dest: TMP_DIR });
const R4A_CSV = path.join(TMP_DIR, 'r4a.csv');
const R4B_CSV = path.join(TMP_DIR, 'r4b.csv');

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

// POST /api/analysis/train — regen CSVs from accumulated DB rows, then train
router.post('/train', async (req, res) => {
  try {
    const r4aPath = training.writeTrainingCSV('R4A');
    const r4bPath = training.writeTrainingCSV('R4B');
    const r4aCount = training.getRowCount('R4A');
    const r4bCount = training.getRowCount('R4B');

    if (!r4aPath || !r4bPath) {
      return res.status(400).json({
        ok: false,
        error: `Not enough accumulated data — R4A: ${r4aCount} rows, R4B: ${r4bCount} rows. Upload CSVs or run EOD capture first.`,
        r4aCount,
        r4bCount,
      });
    }

    const resp = await axios.post(
      `${SCORER_URL}/train`,
      { r4a: r4aPath, r4b: r4bPath },
      { timeout: 180000 }
    );

    // The scorer reports which process answered and where it wrote. If that is
    // not the outputs directory this server reads, an orphaned scorer is
    // holding port 3001 and training is landing somewhere we never display —
    // which otherwise looks exactly like a retrain that changed nothing.
    const warnings = [];
    const wroteTo = resp.data?.output_root;
    if (wroteTo && path.resolve(wroteTo) !== path.resolve(OUTPUTS_DIR)) {
      warnings.push(
        `Training wrote to ${wroteTo}, but this server reads ${OUTPUTS_DIR}. ` +
        'Another scorer process is likely holding port 3001 — check `lsof -i:3001`.'
      );
    }
    if (resp.data?.reloaded_processor) {
      warnings.push('Scorer was running outdated training code and reloaded it before training.');
    }

    res.json({ ...resp.data, r4aCount, r4bCount, ...(warnings.length ? { warnings } : {}) });
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
// Parses a CSV upload and writes rows into the persistent training table.
// Rows are deduped by (date, ticker) — re-uploading the same date replaces
// just those rows, leaving older history intact.
router.post('/upload-csv', upload.single('file'), (req, res) => {
  try {
    const register = (req.query.register || '').toUpperCase();
    if (!['R4A', 'R4B'].includes(register)) {
      return res.status(400).json({ ok: false, error: 'register must be r4a or r4b' });
    }
    if (!req.file) {
      return res.status(400).json({ ok: false, error: 'No file uploaded' });
    }

    const mode = (req.query.mode || 'append').toLowerCase();
    const uploadedPath = req.file.path;

    const content = fs.readFileSync(uploadedPath, 'utf8');
    fs.unlinkSync(uploadedPath);

    const result = training.ingestUploadedCSV(register, content, mode);

    res.json({
      ok: true,
      register,
      mode,
      parsed: result.parsed,
      inserted: result.inserted,
      skipped: result.skipped,
      rows: result.total,
      dates: result.dates,
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /api/analysis/training-summary — accumulated training data overview
router.get('/training-summary', (req, res) => {
  try {
    res.json({
      ok: true,
      r4a: {
        rows: training.getRowCount('R4A'),
        dates: training.getDistinctDates('R4A'),
      },
      r4b: {
        rows: training.getRowCount('R4B'),
        dates: training.getDistinctDates('R4B'),
      },
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// DELETE /api/analysis/training-data?register=r4a|r4b[&date=YYYY-MM-DD]
// Clear all rows, or just one date's rows.
router.delete('/training-data', (req, res) => {
  try {
    const register = (req.query.register || '').toUpperCase();
    if (!['R4A', 'R4B'].includes(register)) {
      return res.status(400).json({ ok: false, error: 'register must be r4a or r4b' });
    }
    if (req.query.date) {
      training.clearDate(register, req.query.date);
    } else {
      training.clearAll(register);
    }
    res.json({
      ok: true,
      register,
      rows: training.getRowCount(register),
      dates: training.getDistinctDates(register),
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /api/analysis/table-data?base=B4&table=main
// Returns factor_importance + all factor bucket CSVs for a given base/table
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
