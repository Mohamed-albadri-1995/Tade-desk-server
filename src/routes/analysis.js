const express = require('express');
const { trainModel, loadModel } = require('../sideE/train');
const { generateInsights } = require('../sideE/insights');
const { invalidateCache } = require('../sideE/score');

const router = express.Router();

// GET /api/analysis/report — full model report
router.get('/report', (req, res) => {
  const model = loadModel();
  if (!model) return res.status(404).json({ error: 'No model trained yet. Run POST /api/analysis/train first.' });

  // Sort features by importance for response
  const sortedFeatures = Object.entries(model.features)
    .sort((a, b) => b[1].importancePct - a[1].importancePct)
    .map(([name, fd]) => ({
      name,
      importance: fd.importance,
      importancePct: fd.importancePct,
      buckets: Object.entries(fd.buckets || {})
        .sort((a, b) => b[1].winRate - a[1].winRate)
        .map(([bucket, stats]) => ({ bucket, ...stats })),
    }));

  res.json({
    trainedAt: model.trainedAt,
    config: model.config,
    globalWinRate: model.backtest.globalWinRate,
    totalRows: model.backtest.totalRows,
    features: sortedFeatures,
    backtest: model.backtest,
    insights: model.insights,
  });
});

// POST /api/analysis/train — trigger training
router.post('/train', async (req, res) => {
  try {
    const overrides = req.body || {};
    const model = trainModel(overrides);
    invalidateCache();

    // Auto-generate rule-based insights
    try {
      await generateInsights(model, false);
    } catch (iErr) {
      console.warn('[Analysis] Insights generation failed:', iErr.message);
    }

    const fullModel = loadModel();
    res.json({
      ok: true,
      trainedAt: model.trainedAt,
      config: model.config,
      totalRows: model.backtest.totalRows,
      globalWinRate: model.backtest.globalWinRate,
      backtestDays: model.backtest.days?.length || 0,
      avgTopWR: model.backtest.avgTopWR,
      avgBottomWR: model.backtest.avgBottomWR,
      insights: fullModel?.insights,
    });
  } catch (err) {
    console.error('[Analysis] Train error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /api/analysis/insights — get or regenerate insights
router.get('/insights', async (req, res) => {
  const model = loadModel();
  if (!model) return res.status(404).json({ error: 'No model trained yet.' });

  const regenerate = req.query.regenerate === 'true';
  const forceAI = req.query.ai === 'true';

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

// GET /api/analysis/feature/:name — single feature bucket breakdown
router.get('/feature/:name', (req, res) => {
  const model = loadModel();
  if (!model) return res.status(404).json({ error: 'No model trained yet.' });

  const fd = model.features[req.params.name];
  if (!fd) return res.status(404).json({ error: 'Feature not found.' });

  const gwr = model.backtest.globalWinRate || 0;
  const buckets = Object.entries(fd.buckets || {})
    .sort((a, b) => b[1].winRate - a[1].winRate)
    .map(([bucket, stats]) => ({
      bucket,
      count: stats.count,
      wins: stats.wins,
      winRate: stats.winRate,
      lift: gwr > 0 ? ((stats.winRate - gwr) / gwr * 100) : 0,
    }));

  res.json({
    name: req.params.name,
    importance: fd.importance,
    importancePct: fd.importancePct,
    globalWinRate: gwr,
    buckets,
  });
});

module.exports = router;
