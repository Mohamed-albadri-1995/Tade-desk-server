const express = require('express');
const db = require('../db');

const router = express.Router();

// Allowlist with validation rules per key
const SETTING_RULES = {
  hotImmediateThreshold:  { type: 'int', min: 0,    max: 100 },
  hotSustainedThreshold:  { type: 'int', min: 0,    max: 100 },
  hotSustainedSessions:   { type: 'int', min: 1,    max: 20  },
  hotFloorThreshold:      { type: 'int', min: 0,    max: 100 },
  coolOffDays:            { type: 'int', min: 0,    max: 30  },
  sectorBullishThreshold: { type: 'int', min: 0,    max: 100 },
  sectorBearishThreshold: { type: 'int', min: -100, max: 0   },
  shortlistMinScore:      { type: 'int', min: 0,    max: 100 },
  shortlistTopN:          { type: 'int', min: 1,    max: 50  },
  finnhubApiKey:          { type: 'str', maxLen: 100 },
};

const MASKED_KEYS = new Set(['finnhubApiKey']);

// GET /api/settings
router.get('/', (req, res) => {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const out = {};
  for (const { key, value } of rows) {
    if (!SETTING_RULES[key]) continue; // skip unknown keys
    if (MASKED_KEYS.has(key)) {
      out[key] = value ? 'set' : '';
    } else {
      out[key] = value;
    }
  }
  res.json({ ok: true, settings: out });
});

// POST /api/settings  body: { key: string, value: string|number }
router.post('/', (req, res) => {
  const updates = req.body;
  if (!updates || typeof updates !== 'object' || Array.isArray(updates)) {
    return res.status(400).json({ ok: false, error: 'Body must be a JSON object of { key: value } pairs' });
  }

  const errors = [];
  const validated = {};

  for (const [key, raw] of Object.entries(updates)) {
    const rule = SETTING_RULES[key];
    if (!rule) {
      errors.push(`Unknown key: ${key}`);
      continue;
    }

    if (rule.type === 'int') {
      const n = Number(raw);
      if (!Number.isFinite(n) || !Number.isInteger(n)) {
        errors.push(`${key} must be an integer`);
        continue;
      }
      if (n < rule.min || n > rule.max) {
        errors.push(`${key} must be between ${rule.min} and ${rule.max}`);
        continue;
      }
      validated[key] = String(n);
    } else if (rule.type === 'str') {
      const s = String(raw || '').trim();
      if (s.length > rule.maxLen) {
        errors.push(`${key} must be at most ${rule.maxLen} characters`);
        continue;
      }
      validated[key] = s;
    }
  }

  if (errors.length > 0) {
    return res.status(400).json({ ok: false, errors });
  }

  const upsert = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
  const upsertAll = db.transaction((pairs) => {
    for (const [k, v] of pairs) upsert.run(k, v);
  });
  upsertAll(Object.entries(validated));

  res.json({ ok: true, saved: Object.keys(validated) });
});

module.exports = router;
