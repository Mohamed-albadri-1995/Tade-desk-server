const express = require('express');
const setups = require('../setups');
const runner = require('../setups/runner');
const config = require('../config');
const { toETDate } = require('../utils/time');

const router = express.Router();

/*
 * GET /api/setups — what exists, and which of them this tool runs.
 *
 * Every tool answers, listing every setup, because the alerts app is served
 * from one place and needs the whole picture. `mine` is what separates "this
 * tool will run it" from "this tool knows about it".
 */
router.get('/', (req, res) => {
  res.json({
    ok: true,
    toolId: config.toolId,
    setups: setups.SETUPS.map(s => ({
      id: s.id,
      name: s.name,
      toolId: s.toolId,
      decisionTime: s.decisionTime,
      universeScanAt: s.universeScanAt || null,
      params: s.params,
      describe: s.describe,
      caution: s.caution,
      liveFeed: s.liveFeed || null,
      mine: s.toolId === config.toolId,
    })),
  });
});

/*
 * GET /api/setups/:id/run — evaluate now, publish nothing.
 *
 * For looking: at a past date to see what it WOULD have taken, or during the
 * morning to watch the ranking form. Never writes to the alert feed, so
 * checking a setup can never be mistaken later for the setup having fired.
 *
 * A real run only happens on the schedule. That is not a limitation to work
 * around — the setup is defined by a single decision at a single time, and a
 * second evaluation at 10:20 is a different setup with a worse edge.
 */
router.get('/:id/run', async (req, res) => {
  const setup = setups.get(req.params.id);
  if (!setup) return res.status(404).json({ ok: false, error: 'No such setup' });

  const date = req.query.date || toETDate(Date.now());
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ ok: false, error: 'date must be YYYY-MM-DD' });
  }
  // An explicit list makes the endpoint usable from a tool that is not the
  // owner — otherwise T2's setup can only ever be previewed on T2's port.
  const tickers = String(req.query.tickers || '')
    .split(',').map(t => t.trim().toUpperCase()).filter(Boolean);

  try {
    const out = await runner.runSetup(setup, { date, dryRun: true, tickers });
    res.json(out);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

/*
 * POST /api/setups/:id/fire — run it for real, now.
 *
 * The scheduled run is the one that matters; this exists for the morning the
 * process was restarting at 10:00. Refused from a tool that does not own the
 * setup, because the universe would be that tool's card list and the answer
 * would look identical to a correct one.
 */
router.post('/:id/fire', async (req, res) => {
  const setup = setups.get(req.params.id);
  if (!setup) return res.status(404).json({ ok: false, error: 'No such setup' });
  if (setup.toolId !== config.toolId) {
    return res.status(400).json({
      ok: false,
      error: `${setup.id} belongs to ${setup.toolId}; run it there so it sees the right card list`,
    });
  }
  try {
    res.json(await runner.runSetup(setup, {}));
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
