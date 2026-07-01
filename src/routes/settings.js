const express = require('express');
const db = require('../db');
const { resetHotState } = require('../sideD/sectors');

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
  scorerEntryTime:        { type: 'str', maxLen: 10 },
  regimeSampleThreshold:  { type: 'int', min: 1,    max: 500 },
  finnhubApiKey:          { type: 'str', maxLen: 100 },
  githubBackupToken:      { type: 'str', maxLen: 200 },
  alpacaApiKey:           { type: 'str', maxLen: 100 },
  alpacaApiSecret:        { type: 'str', maxLen: 100 },
  analysisEntryType:      { type: 'str', maxLen: 10  },
  analysisDirectionalBias:{ type: 'str', maxLen: 10  },
  analysisSuccessThreshold:{ type: 'str', maxLen: 10 },
  analysisTrainingWindow: { type: 'str', maxLen: 10  },
  aiApiKey:               { type: 'str', maxLen: 200 },
  aiModel:                { type: 'str', maxLen: 100 },
  trading_equity:              { type: 'float', min: 0, max: 10000000 },
  trading_risk_pct:            { type: 'float', min: 0, max: 100 },
  trading_max_shares:          { type: 'int',   min: 0, max: 100000 },
  trading_max_dollar_risk:     { type: 'float', min: 0, max: 100000 },
  trading_max_total_exposure:  { type: 'float', min: 0, max: 10000000 },
  trading_max_open_positions:  { type: 'int',   min: 1, max: 20 },
  trading_daily_loss_limit:    { type: 'float', min: 0, max: 100000 },
  trading_data_source:              { type: 'str', maxLen: 20 },
  trading_execution_mode:           { type: 'str', maxLen: 10 },
  trading_gate_enabled:             { type: 'str', maxLen: 4  },
  trading_gate_neutral_multiplier:  { type: 'float', min: 0, max: 2 },
  trading_gate_weak_sec_score:      { type: 'float', min: 0, max: 200 },
  trading_gate_weak_sec_multiplier: { type: 'float', min: 0, max: 2 },
  // Legacy aliases kept so an in-flight UI save doesn't error
  trading_sideA_gate_enabled:       { type: 'str', maxLen: 4  },
  trading_sideA_neutral_multiplier: { type: 'float', min: 0, max: 2 },
  trading_sideA_weak_sec_score:     { type: 'float', min: 0, max: 200 },
  trading_sideA_weak_sec_multiplier:{ type: 'float', min: 0, max: 2 },
  alpacaAccountUrl:            { type: 'str', maxLen: 200 },
  alpacaMarketFeed:            { type: 'str', maxLen: 10 },
  // Grading engine thresholds
  grading_min_setup_trades:      { type: 'int',   min: 1, max: 1000 },
  grading_min_check_side_trades: { type: 'int',   min: 1, max: 1000 },
  grading_kill_expectancy_r:     { type: 'float', min: -10, max: 10 },
  grading_kill_min_trades:       { type: 'int',   min: 1, max: 1000 },
  grading_live_aplus_r:          { type: 'float', min: -10, max: 10 },
  grading_live_a_r:              { type: 'float', min: -10, max: 10 },
  grading_live_b_r:              { type: 'float', min: -10, max: 10 },
};

const MASKED_KEYS = new Set(['finnhubApiKey', 'githubBackupToken', 'alpacaApiKey', 'alpacaApiSecret', 'aiApiKey']);

// GET /api/settings/:key — single-value read (used by the trading UI to
// hydrate individual form fields on tab open). Unknown keys 404; masked
// keys return 'set' or '' instead of the raw value.
router.get('/:key', (req, res, next) => {
  const { key } = req.params;
  // Reserved names that collide with sub-routers.
  if (key === 'test' || key === 'reset-hot') return next();
  if (!SETTING_RULES[key]) return res.status(404).json({ ok: false, error: 'Unknown setting' });
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  const raw = row?.value ?? '';
  const value = MASKED_KEYS.has(key) ? (raw ? 'set' : '') : raw;
  res.json({ ok: true, key, value });
});

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
    } else if (rule.type === 'float') {
      if (raw === '' || raw == null) { validated[key] = ''; continue; }
      const n = Number(raw);
      if (!Number.isFinite(n)) { errors.push(`${key} must be a number`); continue; }
      if (n < rule.min || n > rule.max) { errors.push(`${key} must be between ${rule.min} and ${rule.max}`); continue; }
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

// GET /api/settings/test/:service — live connectivity test for each key
router.get('/test/:service', async (req, res) => {
  const https = require('https');

  function httpGet(options) {
    return new Promise((resolve, reject) => {
      const req = https.request(options, r => {
        let data = '';
        r.on('data', c => data += c);
        r.on('end', () => resolve({ status: r.statusCode, body: data }));
      });
      req.on('error', reject);
      req.setTimeout(8000, () => { req.destroy(); reject(new Error('Timeout')); });
      req.end();
    });
  }

  function httpPost(options, body) {
    return new Promise((resolve, reject) => {
      const r = https.request(options, res => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => resolve({ status: res.statusCode, body: data }));
      });
      r.on('error', reject);
      r.setTimeout(10000, () => { r.destroy(); reject(new Error('Timeout')); });
      r.write(body);
      r.end();
    });
  }

  const getSetting = k => {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(k);
    return row?.value || '';
  };

  const service = req.params.service;

  try {
    if (service === 'finnhub') {
      const key = getSetting('finnhubApiKey');
      if (!key) return res.json({ ok: false, message: 'No key set' });
      const r = await httpGet({ hostname: 'finnhub.io', path: `/api/v1/quote?symbol=SPY&token=${key}` });
      const d = JSON.parse(r.body);
      if (r.status === 200 && d.c) {
        res.json({ ok: true, message: `Connected — SPY current price: $${d.c}` });
      } else {
        res.json({ ok: false, message: `Error ${r.status}: ${r.body.slice(0, 100)}` });
      }

    } else if (service === 'github') {
      const token = getSetting('githubBackupToken');
      if (!token) return res.json({ ok: false, message: 'No token set' });
      const r = await httpGet({
        hostname: 'api.github.com',
        path: '/user',
        headers: { 'Authorization': `token ${token}`, 'User-Agent': 'trade-desk-server' },
      });
      const d = JSON.parse(r.body);
      if (r.status === 200 && d.login) {
        res.json({ ok: true, message: `Connected — GitHub user: ${d.login}` });
      } else {
        res.json({ ok: false, message: `Error ${r.status}: ${d.message || r.body.slice(0, 100)}` });
      }

    } else if (service === 'alpaca') {
      const key = getSetting('alpacaApiKey');
      const secret = getSetting('alpacaApiSecret');
      if (!key || !secret) return res.json({ ok: false, message: 'Key or secret not set' });
      const r = await httpGet({
        hostname: 'paper-api.alpaca.markets',
        path: '/v2/account',
        headers: { 'APCA-API-KEY-ID': key, 'APCA-API-SECRET-KEY': secret },
      });
      const d = JSON.parse(r.body);
      if (r.status === 200 && d.account_number) {
        res.json({ ok: true, message: `Connected — Account: ${d.account_number}, Status: ${d.status}` });
      } else {
        res.json({ ok: false, message: `Error ${r.status}: ${d.message || r.body.slice(0, 100)}` });
      }

    } else if (service === 'ai') {
      const key = getSetting('aiApiKey');
      if (!key) return res.json({ ok: false, message: 'No key set' });
      const isAnthropic = key.startsWith('sk-ant-');
      const isGemini = key.startsWith('AIza');
      const model = getSetting('aiModel') || (isAnthropic ? 'claude-haiku-4-5' : isGemini ? 'gemini-2.0-flash' : 'anthropic/claude-haiku-4-5');

      let r, d;
      if (isAnthropic) {
        const body = JSON.stringify({ model, max_tokens: 10, messages: [{ role: 'user', content: 'Reply with exactly: OK' }] });
        r = await httpPost({
          hostname: 'api.anthropic.com', path: '/v1/messages', method: 'POST',
          headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        }, body);
        d = JSON.parse(r.body);
        if (r.status === 200 && d.content?.[0]) {
          res.json({ ok: true, message: `Connected — Claude (Anthropic) — Model: ${model} — Reply: "${d.content[0].text?.trim()}"` });
        } else {
          res.json({ ok: false, message: `Error ${r.status}: ${d.error?.message || r.body.slice(0, 150)}` });
        }
      } else if (isGemini) {
        const body = JSON.stringify({ contents: [{ parts: [{ text: 'Reply with exactly: OK' }] }], generationConfig: { maxOutputTokens: 10 } });
        r = await httpPost({
          hostname: 'generativelanguage.googleapis.com', path: `/v1beta/models/${model}:generateContent?key=${key}`, method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        }, body);
        d = JSON.parse(r.body);
        const text = d.candidates?.[0]?.content?.parts?.[0]?.text;
        if (r.status === 200 && text) {
          res.json({ ok: true, message: `Connected — Gemini (Google) — Model: ${model} — Reply: "${text.trim()}"` });
        } else {
          res.json({ ok: false, message: `Error ${r.status}: ${d.error?.message || r.body.slice(0, 150)}` });
        }
      } else {
        const body = JSON.stringify({ model, messages: [{ role: 'user', content: 'Reply with exactly: OK' }], max_tokens: 10 });
        r = await httpPost({
          hostname: 'openrouter.ai', path: '/api/v1/chat/completions', method: 'POST',
          headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'HTTP-Referer': 'https://github.com/Mohamed-albadri-1995/Tade-desk-server' },
        }, body);
        d = JSON.parse(r.body);
        if (r.status === 200 && d.choices?.[0]) {
          res.json({ ok: true, message: `Connected — OpenRouter — Model: ${model} — Reply: "${d.choices[0].message?.content?.trim()}"` });
        } else {
          res.json({ ok: false, message: `Error ${r.status}: ${d.error?.message || r.body.slice(0, 150)}` });
        }
      }

    } else {
      res.status(400).json({ ok: false, message: 'Unknown service' });
    }
  } catch (err) {
    res.json({ ok: false, message: `Network error: ${err.message}` });
  }
});

// POST /api/settings/reset-hot — clear in-memory hot sector state
router.post('/reset-hot', (req, res) => {
  resetHotState();
  res.json({ ok: true, message: 'Hot sector state cleared. Run a scan to rebuild under current thresholds.' });
});

module.exports = router;
