/*
 * The tool's own name and running state.
 *
 * Nine tools are nine experiments running side by side. Two things about each
 * of them were fixed in a file in the repo and could only be changed by
 * redeploying: what it is called, and whether it is running at all. Both are
 * now decisions the desk can make, stored in the tool's own database — which
 * lives outside the repo, so they survive a deploy for the same reason the
 * user's strategies do.
 */

const express = require('express');
const identity = require('../sideA/toolIdentity');

const router = express.Router();

// GET /api/tool — name, default name, and whether it is paused
router.get('/', (req, res) => {
  res.json({ ok: true, ...identity.identity() });
});

// PUT /api/tool/name  { name }  — send the default name back to clear the
// override, rather than storing a copy of it; that way a later change in the
// repo is picked up instead of being shadowed forever.
router.put('/name', express.json(), (req, res) => {
  try {
    identity.rename((req.body || {}).name);
    res.json({ ok: true, ...identity.identity() });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

// POST /api/tool/pause  { reason? }
//
// Stops new scans — the scheduled ones and the Run-scan button alike, because
// the guard is inside runFullScan() where both of them arrive. Nothing that
// already exists is touched.
router.post('/pause', express.json(), (req, res) => {
  identity.pause((req.body || {}).reason || null);
  res.json({ ok: true, ...identity.identity() });
});

// POST /api/tool/resume
router.post('/resume', (req, res) => {
  identity.resume();
  res.json({ ok: true, ...identity.identity() });
});

module.exports = router;
