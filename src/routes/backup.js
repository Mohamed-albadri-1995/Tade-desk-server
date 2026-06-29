const express = require('express');
const { pushBackup, restoreBackup, getBackupStatus } = require('../backup');

const router = express.Router();

// GET /api/backup/status
router.get('/status', (req, res) => {
  try {
    res.json({ ok: true, ...getBackupStatus() });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// POST /api/backup/push  — export DB and push to GitHub
router.post('/push', async (req, res) => {
  try {
    const result = await pushBackup();
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// POST /api/backup/restore  — pull from GitHub and import into DB
// body: { date: 'YYYY-MM-DD' }  (optional — omit to use latest)
router.post('/restore', async (req, res) => {
  try {
    const { date } = req.body || {};
    const result = await restoreBackup(date || null);
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

module.exports = router;
