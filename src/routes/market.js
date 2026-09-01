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
router.get('/oneil', async (req, res) => {
  let model = oneil.read();

  // NOTHING ELSE BUILDS IT. qp writes the file, but only when something asks
  // qp for it — so with nine tools reading and nobody asking, the file never
  // appeared and every market tab showed "not built yet" forever. Waiting for
  // a person to run a curl is not a mechanism.
  //
  // So a reader that finds nothing asks qp once, with a short timeout. Nine
  // tools doing this is self-limiting: qp caches for twelve hours, so the
  // first request rebuilds and the other eight get that answer.
  if (!model) {
    try {
      const qp = process.env.QP_URL || 'http://127.0.0.1:8765';
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 25000);
      await fetch(`${qp}/api/oneil/market`, { signal: ctl.signal });
      clearTimeout(timer);
      model = oneil.read();
    } catch { /* qp down or slow — fall through to the honest answer below */ }
  }

  if (!model) {
    return res.json({
      ok: false,
      reason: 'not built yet',
      detail: 'qp publishes this and was asked just now but did not answer. '
        + 'Check that qp-chart is running: systemctl status qp-chart',
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
