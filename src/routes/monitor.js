const express = require('express');
const { getScanStatus } = require('../pipeline');
const { getJobRegistry } = require('../scheduler');

const router = express.Router();

// GET /api/monitor — pipeline report + scheduler job status
router.get('/', (req, res) => {
  res.json({
    pipeline: getScanStatus(),
    jobs: getJobRegistry(),
  });
});

module.exports = router;
