const express = require('express');
const { trainAllModels, loadTable, listTables, MEASURES, REGIME_SLUGS } = require('../sideE/train');
const { generateInsights } = require('../sideE/insights');

const router = express.Router();

// GET /api/analysis/tables — list all stored tables with metadata
router.get('/tables', (req, res) => {
  const rows = listTables();
  res.json({ tables: rows });
});

// GET /api/analysis/report?measure=up&regime=general — full report for one table
router.get('/report', (req, res) => {
  const measure = (req.query.measure || 'up').toLowerCase();
  const regime  = req.query.regime  || 'general';

  if (!MEASURES.includes(measure)) {
    return res.status(400).json({ error: `Invalid measure. Use: ${MEASURES.join(', ')}` });
  }

  const model = loadTable(measure, regime);
  if (!model) {
    return res.status(404).json({ error: 'No model trained yet. Run POST /api/analysis/train first.' });
  }
  if (model.isEmpty) {
    return res.json({
      measure,
      regime,
      isEmpty: true,
      rowCount: model.rowCount,
      trainedAt: model.trainedAt,
      config: model.config,
    });
  }

  const sortedFeatures = Object.entries(model.features)
    .sort((a, b) => b[1].importancePct - a[1].importancePct)
    .map(([name, fd]) => ({
      name,
      importance:    fd.importance,
      importancePct: fd.importancePct,
      nFeat:         fd.nFeat,
      buckets: Object.entries(fd.buckets || {})
        .sort((a, b) => b[1].bucketScore - a[1].bucketScore)
        .map(([bucket, stats]) => ({ bucket, ...stats })),
    }));

  res.json({
    measure,
    regime,
    isEmpty:      false,
    rowCount:     model.rowCount,
    trainedAt:    model.trainedAt,
    config:       model.config,
    globalStats:  model.globalStats,
    features:     sortedFeatures,
    insights:     model.insights,
  });
});

// POST /api/analysis/train — generate all 48 scoring tables
router.post('/train', async (req, res) => {
  try {
    const overrides = req.body || {};
    const result = trainAllModels(overrides);

    // Auto-generate rule-based insights for the general/up table
    try {
      const generalModel = loadTable('up', 'general');
      if (generalModel && !generalModel.isEmpty) {
        await generateInsights(generalModel, false);
      }
    } catch (iErr) {
      console.warn('[Analysis] Insights generation failed:', iErr.message);
    }

    res.json({
      ok: true,
      trainedAt:    result.trainedAt,
      config:       result.config,
      totalRows:    result.totalRows,
      tablesWritten: result.tablesWritten,
    });
  } catch (err) {
    console.error('[Analysis] Train error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /api/analysis/insights?measure=up&regime=general&regenerate=true&ai=true
router.get('/insights', async (req, res) => {
  const measure = (req.query.measure || 'up').toLowerCase();
  const regime  = req.query.regime  || 'general';

  const model = loadTable(measure, regime);
  if (!model) return res.status(404).json({ error: 'No model trained yet.' });
  if (model.isEmpty) return res.status(400).json({ error: 'Table is empty (insufficient regime data).' });

  const regenerate = req.query.regenerate === 'true';
  const forceAI    = req.query.ai === 'true';

  if (regenerate || !model.insights) {
    try {
      const insights = await generateInsights(model, forceAI);
      return res.json(insights);
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  res.json(model.insights);
});

// GET /api/analysis/feature/:name?measure=up&regime=general
router.get('/feature/:name', (req, res) => {
  const measure = (req.query.measure || 'up').toLowerCase();
  const regime  = req.query.regime  || 'general';

  const model = loadTable(measure, regime);
  if (!model) return res.status(404).json({ error: 'No model trained yet.' });
  if (model.isEmpty) return res.status(400).json({ error: 'Table is empty.' });

  const fd = model.features[req.params.name];
  if (!fd) return res.status(404).json({ error: 'Feature not found.' });

  const globalScore = model.globalStats
    ? (((Math.max(-0.5, Math.min(2.5, model.globalStats.globalExpectancy)) + 0.5) / 3.0) * 100)
    : 0;

  const buckets = Object.entries(fd.buckets || {})
    .sort((a, b) => b[1].bucketScore - a[1].bucketScore)
    .map(([bucket, stats]) => ({ bucket, ...stats }));

  res.json({
    name:          req.params.name,
    measure,
    regime,
    importance:    fd.importance,
    importancePct: fd.importancePct,
    globalStats:   model.globalStats,
    globalScore,
    buckets,
  });
});

module.exports = router;
