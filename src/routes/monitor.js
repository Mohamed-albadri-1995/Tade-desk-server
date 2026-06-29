const express = require('express');
const { getScanStatus } = require('../pipeline');
const { getJobRegistry, toggleJob, rescheduleJob, resetJobSchedule } = require('../scheduler');

const router = express.Router();

// GET /api/monitor
router.get('/', (req, res) => {
  res.json({
    pipeline: getScanStatus(),
    jobs: getJobRegistry(),
  });
});

// POST /api/monitor/jobs/:jobId/toggle
router.post('/jobs/:jobId/toggle', (req, res) => {
  const entry = toggleJob(req.params.jobId);
  if (!entry) return res.status(404).json({ ok: false, error: 'Job not found' });
  res.json({ ok: true, jobId: entry.jobId, enabled: entry.enabled });
});

// POST /api/monitor/jobs/:jobId/schedule  body: { schedule: "*/5 9 * * 1-5" }
router.post('/jobs/:jobId/schedule', (req, res) => {
  const { schedule } = req.body || {};
  if (!schedule) return res.status(400).json({ ok: false, error: 'schedule required' });
  const result = rescheduleJob(req.params.jobId, schedule);
  res.json(result);
});

// POST /api/monitor/jobs/:jobId/reset  — restore default schedule
router.post('/jobs/:jobId/reset', (req, res) => {
  const result = resetJobSchedule(req.params.jobId);
  res.json(result);
});

module.exports = router;
