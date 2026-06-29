const express = require('express');
const { getRegisterData, getAvailableDates } = require('../warehouse/registers');
const db = require('../db');

const router = express.Router();

const VALID_REGISTERS = ['R0', 'R1', 'R2', 'R3A', 'R3B', 'R4A', 'R4B', 'Shortlist'];
const REGISTER_MAP = { r0:'R0', r1:'R1', r2:'R2', r3a:'R3A', r3b:'R3B', r4a:'R4A', r4b:'R4B', shortlist:'Shortlist' };
function normalizeRegister(r) { return REGISTER_MAP[r.toLowerCase()] || r; }

// GET /api/warehouse/available-dates
router.get('/available-dates', (req, res) => {
  const { register } = req.query;
  const reg = register ? normalizeRegister(register) : 'R1';
  if (!VALID_REGISTERS.includes(reg)) return res.status(400).json({ error: 'Invalid register' });
  res.json(getAvailableDates(reg));
});

// GET /api/warehouse/:register/latest
router.get('/:register/latest', (req, res) => {
  const register = normalizeRegister(req.params.register);
  if (!VALID_REGISTERS.includes(register)) return res.status(400).json({ error: 'Invalid register' });
  const data = getRegisterData(register, null);
  if (data === null) return res.status(404).json({ error: 'Not found' });
  res.json(data);
});

// GET /api/warehouse/:register/:date
router.get('/:register/:date', (req, res) => {
  const register = normalizeRegister(req.params.register);
  const { date } = req.params;
  if (!VALID_REGISTERS.includes(register)) return res.status(400).json({ error: 'Invalid register' });
  const data = getRegisterData(register, date);
  if (data === null) return res.status(404).json({ error: 'Not found' });
  res.json(data);
});

// GET /api/warehouse/export/:register/:date
router.get('/export/:register/:date', (req, res) => {
  const { register, date } = req.params;
  if (!VALID_REGISTERS.includes(register)) {
    return res.status(400).json({ error: 'Invalid register' });
  }
  const data = getRegisterData(register, date);
  if (!data || data.length === 0) {
    return res.status(404).json({ error: 'No data' });
  }
  const format = req.query.format || 'csv';
  if (format === 'json') {
    res.json({ register, date, data });
  } else {
    const keys = Object.keys(data[0] || {});
    const csv = [keys.join(','), ...data.map(row =>
      keys.map(k => JSON.stringify(row[k] ?? '')).join(',')
    )].join('\n');
    res.type('text/csv').send(csv);
  }
});

// GET /api/warehouse/export/all
router.get('/export/all', (req, res) => {
  const all = {};
  for (const reg of VALID_REGISTERS) {
    try { all[reg] = getRegisterData(reg, null) || []; } catch { all[reg] = []; }
  }
  res.json(all);
});

// POST /api/warehouse/import
router.post('/import', express.json(), (req, res) => {
  // Accepts { register, date, rows[] }
  const { register, date, rows } = req.body || {};
  if (!register || !date || !Array.isArray(rows)) {
    return res.status(400).json({ error: 'register, date, and rows[] required' });
  }
  res.json({ ok: true, imported: rows.length, register, date });
});

// POST /api/warehouse/collect
router.post('/collect', async (req, res) => {
  const { captureR1, captureR2 } = require('../warehouse/registers');
  try {
    captureR1();
    captureR2();
    res.json({ ok: true, message: 'R1 and R2 captured' });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
