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

/*
 * GET /api/market/oneil/stocks?symbols=A,B,C
 *
 * The per-card half of the market model (spec section 14): what each of these
 * stocks did on the exact sessions the index was distributed.
 *
 * WHY IT IS ONE CALL FOR MANY SYMBOLS. The card must not fetch — rule X5, no
 * network call in a card render — so the page asks once for everything on
 * screen and every card reads from that. A register day is 150 cards and each
 * re-renders on every re-quote; a request per card per render would be
 * thousands, for an answer that changes once a day.
 */
router.get('/oneil/stocks', async (req, res) => {
  const symbols = String(req.query.symbols || '')
    .replace(/\s+/g, ',').split(',').filter(Boolean);
  if (!symbols.length) return res.json({ ok: false, error: 'no symbols' });
  try {
    const c = await oneil.loadStocks(symbols);
    return res.json({
      ok: true,
      asOf: c.asOf,
      // The dates travel with the verdicts so the card can show WHICH sessions
      // it is talking about. "Up on 4 of 5" that cannot be checked against a
      // chart is a number to be believed rather than read.
      distributionDays: c.days,
      stocks: c.stocks,
      fetchedAt: c.at || null,
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

/*
 * GET /api/market/groups — the L block: group ranks and rank-within-group.
 *
 * Like /oneil, a reader that finds nothing asks qp once. Nothing else builds
 * the file, and waiting for somebody to run a curl is not a mechanism.
 */
router.get('/groups', async (req, res) => {
  const groups = require('../sideD/groups');
  let model = groups.read();
  if (!model) {
    try {
      const qp = process.env.QP_URL || 'http://127.0.0.1:8765';
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 60000);
      try {
        await fetch(`${qp}/api/oneil/groups`, { signal: ctl.signal });
      } finally { clearTimeout(timer); }
      model = groups.read();
    } catch { /* qp down — the honest answer below */ }
  }
  if (!model) {
    return res.json({
      ok: false,
      reason: 'not built yet',
      detail: 'qp ranks the groups from the industry map the tools write as '
        + 'they scan. Run a scan, then GET /api/oneil/groups?refresh=1 on qp.',
      map: require('../sideA/industryMap').stats(),
    });
  }
  res.json({ ok: model.ok !== false, ...model, map: require('../sideA/industryMap').stats() });
});

/*
 * GET /api/market/oneil/ratings?symbols=A,B,C
 *
 * Phase 4: U/D volume ratio, Accumulation/Distribution, and the workshop's
 * section 3 — the RS line at new high ground BEFORE price, and divergence.
 * One call for everything on screen; see the note on /oneil/stocks.
 */
router.get('/oneil/ratings', async (req, res) => {
  const symbols = String(req.query.symbols || '')
    .replace(/\s+/g, ',').split(',').filter(Boolean);
  if (!symbols.length) return res.json({ ok: false, error: 'no symbols' });
  try {
    const c = await oneil.loadRatings(symbols);
    res.json({ ok: true, stocks: c.stocks, fetchedAt: c.at || null });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
