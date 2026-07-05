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
const setupScorerClient = require('../trading/setupScorerClient');
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
router.post('/session/refresh-setups', async (req, res) => {
  res.json(await session.refreshSetups());
});
router.post('/session/refresh-shortlist', async (req, res) => {
  res.json(await session.refreshShortlist());
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

/**
 * List qp setups (the Python library setups exposed via the compare
 * tool bridge). Falls back to a hardcoded list if the bridge is offline
 * so the UI still populates. Wired into the Setup edit modal.
 */
router.get('/qp-setups', async (req, res) => {
  const qpBridge = require('../trading/qpBridge');
  try {
    const url = (process.env.QP_URL || 'http://127.0.0.1:8765') + '/qp-setups';
    const r = await fetch(url);
    if (r.ok) {
      const list = await r.json();
      return res.json(list);
    }
  } catch (err) { /* fall through to hardcoded fallback */ }
  res.json([
    { id: 'qp:healthy_pullback_l3', name: 'Healthy Pullback L3',
      side: 'long', description: 'Prior bar rejects off Daily/2D/LL VWAP; current bar breaks above.' },
    { id: 'qp:vwap_cluster_bounce', name: 'VWAP Cluster Bounce',
      side: 'both', description: 'Two-or-more VWAPs converge; price bounces with candle + volume + direction.' },
    { id: 'qp:bb_zone_ma_touch',    name: 'BB Zone MA Touch',
      side: 'both', description: 'MA(9/13/20) touch inside a BB zone with VWAP ±σ + body/wick filters.' },
  ]);
});

/**
 * Return an indicator's mandatory conditions — the list its debug()
 * function produces. Called from the Setup edit modal so the user can
 * SEE the same conditions in the UI as are defined in the script,
 * without editing the script.
 *
 * Runs debug() on a synthetic bar sequence just to elicit the condition
 * NAMES; pass/note fields are ignored (they'd be meaningless without
 * real market data). Any throw is treated as "engine doesn't expose
 * conditions" so a partially-implemented indicator doesn't 500 the UI.
 */
router.get('/indicators/:key/conditions', (req, res) => {
  try {
    const engine = require('../trading/indicators/' + req.params.key);
    if (typeof engine.debug !== 'function') {
      return res.json({ ok: true, conditions: [] });
    }
    // 30 synthetic 1-min bars — enough for most engines' minimum-bars
    // guard to pass without triggering any actual signal.
    const bars = [];
    for (let i = 0; i < 30; i++) {
      bars.push({ t: Date.now() - (30 - i) * 60000, o: 100 + i * 0.01, h: 100 + i * 0.01 + 0.05, l: 100 + i * 0.01 - 0.05, c: 100 + i * 0.01, v: 1000, etTime: '09:35' });
    }
    const dbg = engine.debug(bars, null, { rvol: 1 });
    const conditions = (dbg?.conditions || []).map(c => ({ name: c.name }));
    res.json({ ok: true, conditions });
  } catch (err) {
    res.json({ ok: true, conditions: [], warning: err.message });
  }
});

router.post('/setups', (req, res) => {
  const { name, description, indicator, qp_setup_id, entry_type, window_start, window_end, config } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });
  const id = uuidv4();
  db.prepare(`
    INSERT INTO trading_setups (id, name, description, indicator, entry_type, window_start, window_end, enabled, config)
    VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)
  `).run(id, name, description || '', indicator || null, entry_type || 'market', window_start || '9:35', window_end || '10:00', JSON.stringify(config || {}));
  if (qp_setup_id) {
    // Strip the "qp:" prefix if present — the debug-swap logic in
    // checks.js sends the id straight to the compare-tool bridge which
    // handles either form, but keeping bare ids in the DB avoids double
    // prefixes if a caller later concatenates.
    const bare = String(qp_setup_id).replace(/^qp:/, '');
    db.prepare('UPDATE trading_setups SET qp_setup_id=? WHERE id=?').run(bare, id);
  }
  setupEngine.loadSetups();
  res.json({ ok: true, id });
});

router.patch('/setups/:id', (req, res) => {
  const { name, description, indicator, qp_setup_id, entry_type, window_start, window_end, enabled, config,
          override_kill_switch, auto_pause_c_streak } = req.body;
  const row = db.prepare('SELECT * FROM trading_setups WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Setup not found' });
  db.prepare(`
    UPDATE trading_setups SET name=?, description=?, indicator=?, entry_type=?, window_start=?, window_end=?, enabled=?, config=?,
      override_kill_switch=?, auto_pause_c_streak=?
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
    override_kill_switch != null ? (override_kill_switch ? 1 : 0) : (row.override_kill_switch || 0),
    auto_pause_c_streak != null ? Math.max(0, parseInt(auto_pause_c_streak, 10) || 0) : (row.auto_pause_c_streak || 0),
    req.params.id
  );
  if (qp_setup_id !== undefined) {
    const bare = qp_setup_id ? String(qp_setup_id).replace(/^qp:/, '') : null;
    db.prepare('UPDATE trading_setups SET qp_setup_id=? WHERE id=?').run(bare, req.params.id);
  }
  setupEngine.loadSetups();
  // If a session is running, hot-reload the poller so the change takes
  // effect on the next tick without a pause/resume.
  if (session.isRunning()) {
    try { session.refreshSetups(); } catch { /* non-fatal */ }
  }
  res.json({ ok: true });
});

router.delete('/setups/:id', (req, res) => {
  db.prepare('DELETE FROM trading_setups WHERE id = ?').run(req.params.id);
  setupEngine.loadSetups();
  // If a session is running, hot-reload the poller so the change takes
  // effect on the next tick without a pause/resume.
  if (session.isRunning()) {
    try { session.refreshSetups(); } catch { /* non-fatal */ }
  }
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
      router0.processSignal({ ...sig, sessionId: s?.id || 'manual' }, bid, ask)
        .catch(err => console.warn('[Trading] test-signal processSignal error:', err.message));
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

// Historical bar cache status — for debugging warmup timing.
router.get('/historical-cache/status', (req, res) => {
  const historicalCache = require('../trading/historicalCache');
  res.json({ ok: true, ...historicalCache.getStatus() });
});

/**
 * Debug helper: fetch N days of Alpaca 1-min bars for any ticker and
 * return a count per date. Used to distinguish "our cache is broken"
 * from "the ticker just doesn't trade every minute" — a well-known
 * liquid stock (AAPL, SPY) should return ~390 bars/day.
 *
 * GET /api/trading/debug/fetch-bars?ticker=AAPL&days=5
 */
router.get('/debug/fetch-bars', async (req, res) => {
  const ticker = String(req.query.ticker || '').toUpperCase();
  const days = Math.max(1, Math.min(30, parseInt(req.query.days, 10) || 5));
  const source = String(req.query.source || 'yahoo').toLowerCase();
  if (!ticker) return res.status(400).json({ ok: false, error: 'ticker query param required' });

  const alpacaClient = require('../alpaca/client');
  const yahooClient  = require('../yahoo/client');
  const { toETDate } = require('../utils/time');
  const client = source === 'alpaca' ? alpacaClient : yahooClient;
  const now = Date.now();
  const out = { ticker, days, source, byDate: {}, total: 0 };
  for (let d = days; d >= 1; d--) {
    const dt = new Date(now - d * 24 * 3600 * 1000);
    const iso = toETDate(dt.getTime());
    const wday = new Date(iso + 'T12:00:00-05:00').getDay();
    if (wday === 0 || wday === 6) { out.byDate[iso] = 'weekend-skip'; continue; }
    try {
      const map = await client.fetchIntradayBars([ticker], iso);
      const n = (map[ticker] || []).length;
      out.byDate[iso] = n;
      out.total += n;
    } catch (err) {
      out.byDate[iso] = `error: ${err.message}`;
    }
  }
  res.json({ ok: true, ...out });
});

// Live account balances — one row per enabled Alpaca broker profile.
// Hits /v2/account synchronously so the numbers on-screen match what
// Alpaca reports right now (not the sizer's cached copy).
router.get('/account-balance', async (req, res) => {
  const brokerMod = require('../trading/brokers');
  const profiles = brokerMod.getActive().filter(b => b.type === 'alpaca');
  const out = [];
  for (const b of profiles) {
    const cfg = b.config || {};
    if (!cfg.key || !cfg.secret) {
      out.push({ brokerId: b.id, name: b.name, ok: false, error: 'missing key/secret' });
      continue;
    }
    const raw = cfg.url && /alpaca\.markets/i.test(cfg.url) ? cfg.url : 'https://paper-api.alpaca.markets';
    const base = brokerMod.normalizeAlpacaBase(raw);
    const env = base.includes('paper-api') ? 'paper' : 'live';
    try {
      const resp = await fetch(`${base}/v2/account`, {
        headers: { 'APCA-API-KEY-ID': cfg.key, 'APCA-API-SECRET-KEY': cfg.secret },
      });
      if (!resp.ok) {
        out.push({ brokerId: b.id, name: b.name, env, ok: false, error: `Alpaca ${resp.status}` });
        continue;
      }
      const body = await resp.json();
      out.push({
        brokerId:     b.id,
        name:         b.name,
        env,
        ok:           true,
        equity:       parseFloat(body.equity),
        cash:         parseFloat(body.cash),
        buyingPower:  parseFloat(body.buying_power),
        status:       body.status,
      });
    } catch (err) {
      out.push({ brokerId: b.id, name: b.name, env, ok: false, error: err.message });
    }
  }
  res.json({ ok: true, balances: out });
});

// Signal history — every native fire from today with its setup name and
// the trade card id so the UI can jump straight into the card viewer to
// see which checks (mandatory/default/additional) were aligned.
router.get('/signal-history', (req, res) => {
  const today = require('../utils/time').toETDate(Date.now());
  const rows = db.prepare(`
    SELECT l.id, l.ticker, l.direction, l.sl, l.tp, l.fired_at, l.source, l.matched,
           l.setup_id, s.name AS setup_name,
           c.id AS card_id, c.grade
      FROM trading_signal_log l
      LEFT JOIN trading_setups s ON s.id = l.setup_id
      LEFT JOIN trade_cards    c ON c.setup_id = l.setup_id AND c.ticker = l.ticker
                                AND ABS(c.fired_at - l.fired_at) < 60000
     WHERE l.date = ?
     ORDER BY l.fired_at DESC
  `).all(today);
  res.json({ ok: true, signals: rows });
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

router.post('/positions/:id/close', async (req, res) => {
  const { exitPrice, mode } = req.body || {};
  // 'market' → route to Alpaca DELETE /v2/positions when possible; falls
  // back to closing at latest-bar close if no Alpaca profile is active.
  if (mode === 'market') {
    try {
      const result = await router0.marketClosePosition(req.params.id);
      if (!result.ok) return res.status(400).json({ ok: false, error: result.error });
      return res.json({ ok: true, ...result });
    } catch (err) {
      return res.status(500).json({ ok: false, error: err.message });
    }
  }
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
// One call returns the kill / multiplier state for EVERY setup so the
// setups list can badge them without N round trips.
router.get('/grading/setups-status', (req, res) => {
  const account = req.query.account || null;
  const rows = db.prepare('SELECT id, override_kill_switch FROM trading_setups').all();
  const status = {};
  for (const r of rows) {
    try {
      const m = grading.setupSizeMultiplier(r.id, { account });
      status[r.id] = {
        multiplier:     m.multiplier,
        reason:         m.reason,
        breakdown:      m.breakdown ?? null,
        killed:         m.multiplier === 0,
        override:       r.override_kill_switch === 1,
        n:              m.stats?.n ?? 0,
        expectancyR:    m.stats?.expectancyR ?? null,
        winRate:        m.stats?.winRate ?? null,
        avgWinR:        m.stats?.avgWinR ?? null,
        avgLossR:       m.stats?.avgLossR ?? null,
        profitFactor:   m.stats?.profitFactor ?? null,
        maxDrawdownR:   m.stats?.maxDrawdownR ?? null,
        longestLossStreak: m.stats?.longestLossStreak ?? null,
        grade:          m.stats?.grade ?? null,
      };
    } catch { status[r.id] = null; }
  }
  res.json({ ok: true, status });
});
// ── Per-setup factor-analysis model (Python service proxy) ────────────
// Each setup gets its own trained model. These endpoints just forward to
// the Python scorer; if it isn't running the client returns null and the
// UI treats the setup as "not trained yet, using naive fallback".
router.get('/grading/setup/:setupId/model', async (req, res) => {
  try {
    const m = await setupScorerClient.getSetupModel(req.params.setupId);
    res.json({ ok: true, ready: !!m?.ready, meta: m?.meta || null });
  } catch (err) { res.json({ ok: false, error: err.message }); }
});
router.post('/grading/setup/:setupId/train', async (req, res) => {
  try {
    const r = await setupScorerClient.trainSetup(req.params.setupId);
    res.json(r || { ok: false, error: 'Python scorer unreachable' });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});
router.post('/grading/train-all', async (req, res) => {
  try {
    const r = await setupScorerClient.trainAll();
    res.json(r || { ok: false, error: 'Python scorer unreachable' });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

router.get('/grading/setup/:setupId/trend', (req, res) => {
  const account = req.query.account || null;
  const bucketSize = Math.max(1, Math.min(50, parseInt(req.query.bucket || '5', 10)));
  res.json({ ok: true, trend: grading.expectancyTrend(req.params.setupId, { account, bucketSize }) });
});
router.get('/grading/events', (req, res) => {
  const setupId = req.query.setupId || null;
  const limit   = parseInt(req.query.limit || '100', 10);
  res.json({ ok: true, events: grading.listEvents({ setupId, limit }) });
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

// Journal-tab summary: overall + per-setup, sourced from trade_cards (which
// includes journal-imported history via the bridge). Replaces the old
// /api/journal/analysis/account.
router.get('/grading/summary', (req, res) => {
  const { from, to, account } = req.query;
  res.json({ ok: true, ...grading.accountSummary({ from, to, account }) });
});

// Trade cards — the actual snapshots grading learns from.
router.get('/cards', (req, res) => {
  const { limit, setupId, ticker, from, to, account } = req.query;
  res.json({ ok: true, cards: grading.listCards({ limit, setupId, ticker, from, to, account }) });
});
router.get('/cards/:id', (req, res) => {
  const card = grading.getCard(req.params.id);
  if (!card) return res.status(404).json({ ok: false, error: 'Not found' });
  res.json({ ok: true, card });
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

// Preview a candidate condition against a caller-supplied context (or a
// default synthetic context) so the user can verify the JSON before saving.
router.post('/checks/test', (req, res) => {
  const body = req.body || {};
  const defaultCtx = {
    ind: {
      close: 105, open: 104, high: 106, low: 103.5, volume: 250000,
      vwap:  102, ema9: 104.8, ema13: 104.2, ema20: 103.1, ema50: 100,
      sma5:  103, sma20: 101.5, pmHigh: 101, pmLow: 99, prevClose: 100,
      rvol:  3.2, atr: 1.2,
    },
    scanner: {
      regime: 'STRONG_UP', longTerm: 'BULLISH', midTerm: 'UPTREND',
      shortTerm: 'BULLISH', secBias: 'BULLISH', secScore: 45,
      secHot: true, sector: 'Technology', industry: 'Semiconductors',
      themes: ['AI'], broadResolved: 'Technology', _score: 82,
    },
    bars: (() => {
      const bs = [];
      for (let i = 0; i < 30; i++) {
        bs.push({ o: 100+i*0.1, h: 100.5+i*0.1, l: 99.5+i*0.1, c: 100.2+i*0.1, v: 10000+i*500 });
      }
      return bs;
    })(),
    history: {
      ema9:  [102, 103, 103.5, 104.2, 104.8],
      ema13: [101.5, 102, 102.5, 103, 104.2],
      vwap:  [100, 100.5, 101, 101.5, 102],
    },
  };
  const ctx = body.ctx || defaultCtx;
  const result = checks.testCondition(body.condition, ctx);
  res.json(result);
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
