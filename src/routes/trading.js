/**
 * Trading Tool API Routes
 * Mounted at /api/trading
 */

const express = require('express');
const { v4: uuidv4 } = require('uuid');
const db = require('../db');
require('../trading/db'); // ensure tables exist
const session      = require('../trading/session');
const marketGate   = require('../trading/marketGate');
const setupEngine  = require('../trading/setupEngine');
const sizer        = require('../trading/sizer');
const router0      = require('../trading/router');
const barPoller    = require('../trading/barPoller');
const backtest     = require('../trading/backtest');
const brokers      = require('../trading/brokers');
const grading      = require('../trading/grading');
const checks       = require('../trading/checks');
const { toETDate } = require('../utils/time');

const router = express.Router();

// ─── Session ─────────────────────────────────────────────────────────────────

router.post('/session/start', async (req, res) => {
  res.json(await session.start());
});
router.post('/session/end', (req, res) => {
  res.json(session.end('manual'));
});
router.post('/session/pause', (req, res) => {
  res.json(session.pause('manual'));
});
router.post('/session/resume', (req, res) => {
  res.json(session.resume());
});
router.get('/session', (req, res) => {
  const s = session.getSession();
  res.json(s || { status: 'idle' });
});

// ─── Market Gate (was Side A) ────────────────────────────────────────────────

router.get('/gate', (req, res) => {
  res.json({ ready: session.isGateReady(), tickers: marketGate.getAll() });
});
router.get('/gate/:ticker', (req, res) => {
  const entry = marketGate.get(req.params.ticker.toUpperCase());
  if (!entry) return res.status(404).json({ error: 'Ticker not in gate' });
  res.json(entry);
});
// Legacy aliases for anything still calling the old paths
router.get('/sideA',          (req, res) => res.json(marketGate.getAll()));
router.get('/sideA/:ticker',  (req, res) => {
  const entry = marketGate.get(req.params.ticker.toUpperCase());
  if (!entry) return res.status(404).json({ error: 'Ticker not in gate' });
  res.json(entry);
});

// ─── Setup Engine — Setups (was Side B) ──────────────────────────────────────

router.get('/setups', (req, res) => {
  const rows = db.prepare('SELECT * FROM trading_setups ORDER BY name').all();
  res.json(rows.map(r => ({ ...r, config: JSON.parse(r.config || '{}') })));
});

router.get('/indicators', (req, res) => {
  res.json(barPoller.listEngines());
});

router.post('/setups', (req, res) => {
  const { name, description, indicator, entry_type, window_start, window_end, config } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });
  const id = uuidv4();
  db.prepare(`
    INSERT INTO trading_setups (id, name, description, indicator, entry_type, window_start, window_end, enabled, config)
    VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)
  `).run(id, name, description || '', indicator || null, entry_type || 'market', window_start || '9:35', window_end || '10:00', JSON.stringify(config || {}));
  setupEngine.loadSetups();
  res.json({ ok: true, id });
});

router.patch('/setups/:id', (req, res) => {
  const { name, description, indicator, entry_type, window_start, window_end, enabled, config } = req.body;
  const row = db.prepare('SELECT * FROM trading_setups WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Setup not found' });
  db.prepare(`
    UPDATE trading_setups SET name=?, description=?, indicator=?, entry_type=?, window_start=?, window_end=?, enabled=?, config=?
    WHERE id=?
  `).run(
    name ?? row.name,
    description ?? row.description,
    indicator !== undefined ? (indicator || null) : row.indicator,
    entry_type ?? row.entry_type,
    window_start ?? row.window_start,
    window_end ?? row.window_end,
    enabled != null ? (enabled ? 1 : 0) : row.enabled,
    config ? JSON.stringify(config) : row.config,
    req.params.id
  );
  setupEngine.loadSetups();
  res.json({ ok: true });
});

router.delete('/setups/:id', (req, res) => {
  db.prepare('DELETE FROM trading_setups WHERE id = ?').run(req.params.id);
  setupEngine.loadSetups();
  res.json({ ok: true });
});

// ─── Setup Engine — Signals ──────────────────────────────────────────────────

router.post('/webhook', (req, res) => {
  const payload = req.body;
  if (!payload?.ticker || !payload?.direction) {
    return res.status(400).json({ error: 'ticker and direction required' });
  }
  const result = setupEngine.receiveWebhook(payload);
  router0.broadcast({ type: 'webhook_signal', ...result, payload, ts: Date.now() });
  res.json({ ok: true, ...result });
});

router.post('/signal/test', (req, res) => {
  const { ticker, setupId, direction, sl, tp, entryType } = req.body;
  if (!ticker || !setupId || !direction || !sl || !tp) {
    return res.status(400).json({ error: 'ticker, setupId, direction, sl, tp required' });
  }
  const s = session.getSession();
  setupEngine.onIndicatorFire(
    { ticker, setupId, direction, sl: parseFloat(sl), tp: parseFloat(tp), entryType: entryType || 'market' },
    s?.id || 'manual',
    (sig) => {
      const bid = req.body.bid || null;
      const ask = req.body.ask || null;
      router0.processSignal({ ...sig, sessionId: s?.id || 'manual' }, bid, ask);
    }
  );
  res.json({ ok: true });
});

router.get('/signals', (req, res) => {
  const { date, ticker } = req.query;
  let q = 'SELECT * FROM trading_signals WHERE 1=1';
  const params = [];
  if (date) { q += ' AND date = ?'; params.push(date); }
  if (ticker) { q += ' AND ticker = ?'; params.push(ticker.toUpperCase()); }
  q += ' ORDER BY fired_at DESC LIMIT 100';
  res.json(db.prepare(q).all(...params));
});

router.get('/comparison/:date', (req, res) => {
  res.json(setupEngine.comparisonReport(req.params.date));
});

// ─── Sizer (was Side C) ──────────────────────────────────────────────────────

router.post('/size', (req, res) => {
  const { entryPrice, sl, gateMultiplier, sideAMultiplier, score } = req.body;
  if (!entryPrice || !sl) return res.status(400).json({ error: 'entryPrice and sl required' });
  try {
    const result = sizer.calculate({
      entryPrice: parseFloat(entryPrice),
      sl: parseFloat(sl),
      gateMultiplier: parseFloat(gateMultiplier ?? sideAMultiplier ?? 1.0),
      score: score != null ? parseFloat(score) : null,
    });
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

// ─── Orders (Router) ─────────────────────────────────────────────────────────

router.get('/orders', (req, res) => {
  const { date } = req.query;
  const today = date || toETDate(Date.now());
  const rows = db.prepare('SELECT * FROM trading_orders WHERE date = ? ORDER BY created_at DESC').all(today);
  res.json(rows.map(r => ({ ...r, alpaca_payload: JSON.parse(r.alpaca_payload) })));
});

// ─── Positions ───────────────────────────────────────────────────────────────

router.get('/positions', (req, res) => {
  const rows = db.prepare("SELECT * FROM trading_positions ORDER BY opened_at DESC").all();
  res.json(rows);
});
router.get('/positions/open', (req, res) => {
  res.json(router0.listOpenPositions());
});
router.get('/positions/closed-today', (req, res) => {
  res.json(router0.listClosedPositionsToday());
});

router.post('/positions', (req, res) => {
  const { orderId, ticker, direction, shares, entryPrice, entryTime, sl, tp } = req.body;
  if (!ticker || !direction || !shares || !entryPrice) {
    return res.status(400).json({ error: 'ticker, direction, shares, entryPrice required' });
  }
  const id = uuidv4();
  db.prepare(`
    INSERT INTO trading_positions (id, order_id, ticker, direction, shares, entry_price, entry_time, sl, tp, status, opened_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?)
  `).run(id, orderId || '', ticker.toUpperCase(), direction, parseInt(shares), parseFloat(entryPrice),
     entryTime || new Date().toISOString(), parseFloat(sl), parseFloat(tp), Date.now());
  res.json({ ok: true, id });
});

router.post('/positions/:id/close', (req, res) => {
  const { exitPrice } = req.body || {};
  const result = router0.closePosition(req.params.id, parseFloat(exitPrice), 'manual');
  if (!result.ok) return res.status(400).json({ ok: false, error: result.error });
  res.json({ ok: true, position: result.position, pnl: result.position.pnl });
});
router.patch('/positions/:id/close', (req, res) => {
  const { exitPrice } = req.body || {};
  const result = router0.closePosition(req.params.id, parseFloat(exitPrice), 'manual');
  if (!result.ok) return res.status(400).json({ ok: false, error: result.error });
  res.json({ ok: true, pnl: result.position.pnl });
});

// ─── Poller ──────────────────────────────────────────────────────────────────

router.get('/poller/status', (req, res) => {
  res.json(barPoller.getStatus());
});

// ─── Backtest (Path B) ───────────────────────────────────────────────────────

router.get('/backtest/indicators', (req, res) => {
  res.json({ ok: true, indicators: backtest.listIndicators() });
});
router.post('/backtest', async (req, res) => {
  try {
    const result = await backtest.runBacktest(req.body || {});
    if (!result.ok) return res.status(400).json(result);
    res.json(result);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── Brokers ─────────────────────────────────────────────────────────────────

router.get('/brokers', (req, res) => {
  res.json({ ok: true, brokers: brokers.list() });
});
router.get('/brokers/active', (req, res) => {
  res.json({ ok: true, active: brokers.getActive() });
});
router.post('/brokers', (req, res) => {
  try {
    const created = brokers.create(req.body || {});
    res.json({ ok: true, broker: created });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});
router.patch('/brokers/:id', (req, res) => {
  const updated = brokers.update(req.params.id, req.body || {});
  if (!updated) return res.status(404).json({ ok: false, error: 'Broker not found' });
  res.json({ ok: true, broker: updated });
});
router.delete('/brokers/:id', (req, res) => {
  brokers.remove(req.params.id);
  res.json({ ok: true });
});
router.get('/broker-types', (req, res) => {
  res.json({ ok: true, types: brokers.VALID_TYPES });
});

// ─── Grading ─────────────────────────────────────────────────────────────────

router.get('/grading/setup/:setupId', (req, res) => {
  const account = req.query.account || null;
  const stats = grading.setupExpectancy(req.params.setupId, { account });
  res.json({ ok: true, stats });
});
router.get('/grading/setup/:setupId/checks', (req, res) => {
  const account = req.query.account || null;
  res.json({ ok: true, contributions: grading.checkContributions(req.params.setupId, { account }) });
});
router.post('/grading/preview', (req, res) => {
  try {
    const { setupId, additionalChecks = [], account = null } = req.body || {};
    if (!setupId) return res.status(400).json({ ok: false, error: 'setupId required' });
    res.json({ ok: true, grade: grading.gradeSignal({ setupId, additionalChecks, account }) });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── Check Library (Part A) ──────────────────────────────────────────────────
// Categories: 'default' (auto-applied to every setup) and 'additional'
// (opt-in per setup via setup_check_assignments).

router.get('/checks', (req, res) => {
  const category    = req.query.category || null;
  const enabledOnly = req.query.enabled === '1';
  res.json({ ok: true, checks: checks.listChecks({ category, enabledOnly }) });
});
router.get('/checks/:id', (req, res) => {
  const c = checks.getCheck(req.params.id);
  if (!c) return res.status(404).json({ ok: false, error: 'Not found' });
  res.json({ ok: true, check: c });
});
router.post('/checks', (req, res) => {
  try {
    res.json({ ok: true, check: checks.createCheck(req.body || {}) });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});
router.patch('/checks/:id', (req, res) => {
  try {
    const updated = checks.updateCheck(req.params.id, req.body || {});
    if (!updated) return res.status(404).json({ ok: false, error: 'Not found' });
    res.json({ ok: true, check: updated });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});
router.delete('/checks/:id', (req, res) => {
  checks.removeCheck(req.params.id);
  res.json({ ok: true });
});
router.post('/checks/validate', (req, res) => {
  const v = checks.validateCondition(req.body?.condition);
  res.json({ ok: v.ok, error: v.error || null });
});

// Per-setup additional-check assignments
router.get('/setups/:id/checks', (req, res) => {
  res.json({ ok: true, additional: checks.assignmentsForSetup(req.params.id) });
});
router.put('/setups/:id/checks', (req, res) => {
  const ids = Array.isArray(req.body?.checkIds) ? req.body.checkIds : [];
  res.json({ ok: true, additional: checks.setAssignmentsForSetup(req.params.id, ids) });
});

// ─── SSE — live notifications ────────────────────────────────────────────────

router.get('/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  res.write('data: {"type":"connected"}\n\n');
  router0.addListener(res);
});

module.exports = router;
