const express = require('express');
const { getLatestSnapshot, buildMarketSnapshot } = require('../sideD/engine');
const oneil = require('../sideD/oneil');

const router = express.Router();

// GET /api/market/oneil
//
// O'Neil's market model, read from the file qp publishes. Served separately
// from /snapshot on purpose: the existing snapshot is a short-term momentum
// blend and this is a state machine, and two market reads that shared an
// endpoint would end up sharing words on the page. They are different claims.
//
// Missing is a NORMAL answer, not an error: qp may not have run yet, and the
// tab renders exactly as it does today when this returns nothing.
router.get('/oneil', (req, res) => {
  const model = oneil.read();
  if (!model) {
    return res.json({
      ok: false,
      reason: 'not built yet',
      detail: 'qp publishes this after each close — GET /api/oneil/market?refresh=1 on qp builds it now',
      file: oneil.FILE,
    });
  }
  res.json({
    ok: true,
    ...model,
    exposure: oneil.EXPOSURE[model.status] || null,
    ftdBand: oneil.ftdBand(model.sessions_since_ftd),
  });
});

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
