/**
 * Trading Tool API Routes
 * Mounted at /api/trading
 */

const express = require('express');
const { v4: uuidv4 } = require('uuid');
const db = require('../db');
require('../trading/db'); // ensure tables exist
const session = require('../trading/session');
const sideA = require('../trading/sideA');
const sideB = require('../trading/sideB');
const sideC = require('../trading/sideC');
const center = require('../trading/center');
const barPoller = require('../trading/barPoller');

const router = express.Router();

// ─── Session ──────────────────────────────────────────────────────────────────

router.post('/session/start', async (req, res) => {
  const result = await session.start();
  res.json(result);
});

router.post('/session/end', (req, res) => {
  res.json(session.end('manual'));
});

router.get('/session', (req, res) => {
  const s = session.getSession();
  res.json(s || { status: 'idle' });
});

// ─── Bar Poller status ────────────────────────────────────────────────────────

router.get('/poller/status', (req, res) => {
  res.json(barPoller.getStatus());
});

// ─── Side A ───────────────────────────────────────────────────────────────────

router.get('/sideA', (req, res) => {
  res.json(sideA.getAll());
});

router.get('/sideA/:ticker', (req, res) => {
  const entry = sideA.get(req.params.ticker.toUpperCase());
  if (!entry) return res.status(404).json({ error: 'Ticker not in register' });
  res.json(entry);
});

// ─── Side B — Setups ─────────────────────────────────────────────────────────

router.get('/setups', (req, res) => {
  const rows = db.prepare('SELECT * FROM trading_setups ORDER BY name').all();
  res.json(rows.map(r => ({ ...r, config: JSON.parse(r.config || '{}') })));
});

router.post('/setups', (req, res) => {
  const { name, description, entry_type, window_start, window_end, config } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });
  const id = uuidv4();
  db.prepare(`
    INSERT INTO trading_setups (id, name, description, entry_type, window_start, window_end, enabled, config)
    VALUES (?, ?, ?, ?, ?, ?, 1, ?)
  `).run(id, name, description || '', entry_type || 'market', window_start || '9:35', window_end || '10:00', JSON.stringify(config || {}));
  sideB.loadSetups();
  res.json({ ok: true, id });
});

router.patch('/setups/:id', (req, res) => {
  const { name, description, entry_type, window_start, window_end, enabled, config } = req.body;
  const row = db.prepare('SELECT * FROM trading_setups WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Setup not found' });
  db.prepare(`
    UPDATE trading_setups SET name=?, description=?, entry_type=?, window_start=?, window_end=?, enabled=?, config=?
    WHERE id=?
  `).run(
    name ?? row.name,
    description ?? row.description,
    entry_type ?? row.entry_type,
    window_start ?? row.window_start,
    window_end ?? row.window_end,
    enabled != null ? (enabled ? 1 : 0) : row.enabled,
    config ? JSON.stringify(config) : row.config,
    req.params.id
  );
  sideB.loadSetups();
  res.json({ ok: true });
});

router.delete('/setups/:id', (req, res) => {
  db.prepare('DELETE FROM trading_setups WHERE id = ?').run(req.params.id);
  sideB.loadSetups();
  res.json({ ok: true });
});

// ─── Side B — Signals ────────────────────────────────────────────────────────

// Webhook endpoint: TradingView → server (for comparison)
router.post('/webhook', (req, res) => {
  const payload = req.body;
  if (!payload?.ticker || !payload?.direction) {
    return res.status(400).json({ error: 'ticker and direction required' });
  }
  const result = sideB.receiveWebhook(payload);
  center.broadcast({ type: 'webhook_signal', ...result, payload, ts: Date.now() });
  res.json({ ok: true, ...result });
});

// Manual test: fire a signal (for debugging/testing without live data)
router.post('/signal/test', (req, res) => {
  const { ticker, setupId, direction, sl, tp, entryType } = req.body;
  if (!ticker || !setupId || !direction || !sl || !tp) {
    return res.status(400).json({ error: 'ticker, setupId, direction, sl, tp required' });
  }
  const s = session.getSession();
  sideB.onIndicatorFire(
    { ticker, setupId, direction, sl: parseFloat(sl), tp: parseFloat(tp), entryType: entryType || 'market' },
    s?.id || 'manual',
    (sig) => {
      const bid = req.body.bid || null;
      const ask = req.body.ask || null;
      center.processSignal({ ...sig, sessionId: s?.id || 'manual' }, bid, ask);
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

// End-of-day comparison report
router.get('/comparison/:date', (req, res) => {
  res.json(sideB.comparisonReport(req.params.date));
});

// ─── Side C ───────────────────────────────────────────────────────────────────

router.post('/size', (req, res) => {
  const { entryPrice, sl, sideAMultiplier, score } = req.body;
  if (!entryPrice || !sl) return res.status(400).json({ error: 'entryPrice and sl required' });
  try {
    const result = sideC.calculate({
      entryPrice: parseFloat(entryPrice),
      sl: parseFloat(sl),
      sideAMultiplier: parseFloat(sideAMultiplier) || 1.0,
      score: score != null ? parseFloat(score) : null,
    });
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

// ─── Orders (Center) ─────────────────────────────────────────────────────────

router.get('/orders', (req, res) => {
  const { date } = req.query;
  const today = date || new Date().toISOString().slice(0, 10);
  const rows = db.prepare('SELECT * FROM trading_orders WHERE date = ? ORDER BY created_at DESC').all(today);
  res.json(rows.map(r => ({ ...r, alpaca_payload: JSON.parse(r.alpaca_payload) })));
});

// ─── Positions ────────────────────────────────────────────────────────────────

router.get('/positions', (req, res) => {
  const rows = db.prepare("SELECT * FROM trading_positions ORDER BY opened_at DESC").all();
  res.json(rows);
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

router.patch('/positions/:id/close', (req, res) => {
  const { exitPrice, exitTime } = req.body;
  const pos = db.prepare('SELECT * FROM trading_positions WHERE id = ?').get(req.params.id);
  if (!pos) return res.status(404).json({ error: 'Position not found' });
  const pnl = (parseFloat(exitPrice) - pos.entry_price) * pos.shares * (pos.direction === 'Long' ? 1 : -1);
  db.prepare(`
    UPDATE trading_positions SET status='closed', exit_price=?, exit_time=?, pnl=?, closed_at=? WHERE id=?
  `).run(parseFloat(exitPrice), exitTime || new Date().toISOString(), pnl, Date.now(), req.params.id);
  res.json({ ok: true, pnl: parseFloat(pnl.toFixed(2)) });
});

// ─── SSE — live notifications ─────────────────────────────────────────────────

router.get('/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  res.write('data: {"type":"connected"}\n\n');
  center.addListener(res);
});

module.exports = router;
