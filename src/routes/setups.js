const express = require('express');
const catalog = require('../setups/catalog');
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
 *
 * The list comes from qp, live. A strategy built there this morning is here
 * this morning; one deleted there is gone. Nothing is registered on this side.
 */
router.get('/', async (req, res) => {
  res.json({
    ok: true,
    toolId: config.toolId,
    setups: (await catalog.list()).map(s => ({
      id: s.id,
      name: s.name,
      tools: s.tools,
      sides: s.sides,
      strategies: s.strategies,
      strategyIds: s.strategyIds,
      decisionTime: s.decisionTime,
      universeScanAt: s.universeScanAt || null,
      describe: s.describe,
      caution: s.caution,
      liveFeed: s.liveFeed || null,
      topN: (s.rank || {}).topN || 2,
      universe: require('../setups/universe').describe(s.universe),
      universeRules: (s.universe && s.universe.rules) || [],
      // Sent back so the editor reopens on what was saved. Without it the
      // control always read "all", and re-saving silently turned an OR filter
      // into an AND one — a different filter, quietly.
      universeLogic: (s.universe && s.universe.logic) || 'AND',
      enabled: s.enabled,
      // Whether THIS setup places orders — separate from the broker being
      // armed, which is permission for the box rather than for a strategy.
      autoTrade: s.autoTrade === true,
      mine: (s.tools || []).includes(config.toolId),
    })),
  });
});

/*
 * Switch a setup on or off.
 *
 * The definition itself is the qp strategy — its windows, cutoffs and rules are
 * the thing that was tested, and they are edited in the builder that tested
 * them. What belongs to this side is whether it runs at all, and any process
 * can serve this because it is a shared file rather than a tool's database.
 */
router.post('/:id/enabled', express.json(), async (req, res) => {
  const setup = await catalog.get(req.params.id);
  if (!setup) return res.status(404).json({ ok: false, error: 'No such setup' });
  const enabled = require('../setups/prefs').setEnabled(setup.id, req.body?.enabled);
  res.json({ ok: true, id: setup.id, enabled });
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
  const setup = await catalog.get(req.params.id);
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
 * process was restarting at 10:00. Refused from a tool the setup does not name,
 * because the universe would be that tool's card list and the answer would look
 * identical to a correct one.
 */
router.post('/:id/fire', async (req, res) => {
  const setup = await catalog.get(req.params.id);
  if (!setup) return res.status(404).json({ ok: false, error: 'No such setup' });
  const owners = setup.tools || [];
  if (!owners.includes(config.toolId)) {
    return res.status(400).json({
      ok: false,
      error: `${setup.id} belongs to ${owners.join(', ') || 'no tool'}; `
        + `run it there so it sees the right card list (this is ${config.toolId})`,
    });
  }
  try {
    res.json(await runner.runSetup(setup, {}));
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
