/**
 * Trading Session Manager
 *
 * Lifecycle of a trading session:
 *   - Pull shortlist from scanner at 9:35 ET
 *   - Poll scanner context every 30s (9:35–10:00), update Market Gate
 *   - Load Setup Engine's setups
 *   - Graceful end at 10:00 ET
 */

const { v4: uuidv4 } = require('uuid');
const db = require('../db');
const marketGate    = require('./marketGate');   // was sideA
const setupEngine   = require('./setupEngine');  // was sideB
const sizer         = require('./sizer');        // was sideC
const router        = require('./router');       // was center
const barPoller     = require('./barPoller');
const brokerSync    = require('./brokerSync');
const historicalCache = require('./historicalCache');
const volumeBaseline = require('./volumeBaseline');
const { toETDate } = require('../utils/time');

const SCANNER_URL = process.env.SCANNER_URL || 'http://127.0.0.1:3000';

let _session = null;
let _contextPollInterval = null;
let _initialPollDone = false;

function getSession() {
  return _session;
}

function isActive() {
  return _session?.status === 'active';
}

function isPaused() {
  return _session?.status === 'paused';
}

function isRunning() {
  return isActive() || isPaused();
}

/**
 * True once the first context poll has populated the Market Gate for
 * this session's tickers. Signals that fire before this returns true
 * should be treated as "gate not ready" and blocked (fail-safe default).
 */
function isGateReady() {
  return isActive() && _initialPollDone;
}

// ─── Shortlist fetch ─────────────────────────────────────────────────────────

async function fetchShortlist() {
  const res = await fetch(`${SCANNER_URL}/api/shortlist/today`);
  if (!res.ok) throw new Error(`Scanner shortlist fetch failed: ${res.status}`);
  return res.json();
}

// ─── Context poll ────────────────────────────────────────────────────────────

async function pollContext(tickers) {
  if (!tickers.length) return;
  try {
    const res = await fetch(`${SCANNER_URL}/api/registry?tickers=${tickers.join(',')}`);
    if (!res.ok) return;
    const rows = await res.json();
    const entries = (Array.isArray(rows) ? rows : rows.rows || [])
      .filter(r => tickers.includes(r.ticker))
      .map(r => ({
        ticker: r.ticker,
        context: r.context || {},
        _score: r._score,
        _scoreDetails: r._scoreDetails,
      }));
    marketGate.updateAll(entries);
    _initialPollDone = true;
  } catch (e) {
    console.warn('[TradingSession] Context poll failed:', e.message);
  }
}

// ─── Session start ───────────────────────────────────────────────────────────

async function start() {
  if (isRunning()) return { ok: false, reason: 'Session already running' };

  const today = toETDate(Date.now());
  const sessionId = uuidv4();

  let shortlistEntry;
  try {
    shortlistEntry = await fetchShortlist();
  } catch (e) {
    return { ok: false, reason: `Failed to fetch shortlist: ${e.message}` };
  }

  const shortlist = shortlistEntry?.items || [];
  const tickers = shortlist.map(i => i.ticker).filter(Boolean);

  db.prepare(`
    INSERT INTO trading_sessions (id, date, started_at, shortlist, status)
    VALUES (?, ?, ?, ?, 'active')
  `).run(sessionId, today, Date.now(), JSON.stringify(shortlist));

  // Prime the Market Gate with initial data from the shortlist. Context
  // fields are still empty here — the first pollContext() below fills them.
  marketGate.clear();
  for (const item of shortlist) {
    marketGate.update(item.ticker, {}, item._score, item._scoreDetails);
  }

  // Load setups for the Setup Engine.
  setupEngine.loadSetups();
  setupEngine.clearSessionLog();

  // Refresh live account equity for the Sizer. Non-fatal.
  sizer.refreshAlpacaEquity().then(eq => {
    if (eq.source === 'alpaca') {
      console.log('[TradingSession] Alpaca equity refreshed:', eq.value);
    } else {
      console.log('[TradingSession] Alpaca equity unavailable — using trading_equity setting');
    }
  }).catch(() => { /* logged inside sizer */ });

  volumeBaseline.ensureBuilt(tickers, today).catch(err => {
    console.warn('[TradingSession] Volume baseline build failed:', err.message);
  });

  _session = { id: sessionId, date: today, tickers, shortlist, status: 'active', startedAt: Date.now() };
  _initialPollDone = false;

  // First context poll runs before we let the bar poller emit signals so
  // the direction gate is populated by the time signals arrive.
  await pollContext(tickers);

  _contextPollInterval = setInterval(() => {
    if (!isActive()) return;
    const now = Date.now();
    const etHour = new Date(now).toLocaleString('en-US', { timeZone: 'America/New_York', hour: 'numeric', hour12: false });
    const etMin  = new Date(now).toLocaleString('en-US', { timeZone: 'America/New_York', minute: 'numeric' });
    const minutesSince935 = (parseInt(etHour) - 9) * 60 + parseInt(etMin) - 35;
    const minutesSince1000 = (parseInt(etHour) - 10) * 60 + parseInt(etMin);
    if (minutesSince935 >= 0 && minutesSince1000 < 0) {
      pollContext(_session?.tickers || tickers);
      refreshSetups().catch(() => {});
      refreshShortlist().catch(() => {});
    }
  }, 30000);

  // Warm the historical cache in the background. Indicator engines that
  // want multi-day lookback (2-day VWAP, 5-day MA, week/month anchors)
  // read from it via barPoller merge. Non-blocking: fires the fetches
  // and moves on — engines that consult it early get today-only bars and
  // gain the fuller picture as the fetches complete.
  historicalCache.warmup(tickers, 6).catch(err => {
    console.warn('[TradingSession] historicalCache warmup failed:', err.message);
  });

  // Bar poller (source is chosen by the trading_data_source setting).
  // Single source of truth: setup engine loaded the setups above, so pull
  // that same list here rather than querying the DB again.
  const activeSetups = setupEngine.getActiveSetupsArray();
  barPoller.start(sessionId, tickers, activeSetups, (signal, sid) => {
    // Boundary guard: if the session ended (or was paused) while this
    // evaluation was in flight, drop the fire instead of writing it.
    if (!isActive()) return;
    setupEngine.onIndicatorFire(signal, sid, (enrichedSignal) => {
      const q = barPoller.getLatestQuote(enrichedSignal.ticker);
      router.processSignal(
        { ...enrichedSignal, sessionId: sid },
        q?.bid ?? null,
        q?.ask ?? null
      ).catch(err => console.warn('[TradingSession] processSignal error:', err.message));
    });
  });

  // brokerSync is started on process boot (index.js) so it survives
  // session lifecycle; nothing to do here.

  console.log(`[TradingSession] Started ${sessionId} with ${tickers.length} tickers`);
  return { ok: true, sessionId, tickers, shortlist };
}

// ─── Hot reload (setups + tickers) ───────────────────────────────────────────

/**
 * Re-read enabled setups from the DB and push them into the bar poller
 * without restarting the whole loop.
 */
async function refreshSetups() {
  if (!isActive() && !isPaused()) return { ok: false, reason: 'No session running' };
  setupEngine.loadSetups();
  const setups = setupEngine.getActiveSetupsArray();
  barPoller.updateSetups(setups);
  return { ok: true, count: setups.length };
}

/**
 * Re-pull today's shortlist and push new tickers into the poller.
 * Same-list runs are cheap (no-op). Added tickers get the volume baseline
 * built in the background so their rvol works quickly.
 */
async function refreshShortlist() {
  if (!isActive() && !isPaused()) return { ok: false, reason: 'No session running' };
  try {
    const entry = await fetchShortlist();
    const items = entry?.items || [];
    const tickers = items.map(i => i.ticker).filter(Boolean);
    if (!_session) return { ok: false, reason: 'No session record' };
    // Prime new tickers on the Market Gate so the fail-safe (unknown =>
    // block) doesn't kick in on the very next fire.
    for (const t of tickers) {
      if (!marketGate.get(t)) marketGate.update(t, {}, null, null);
    }
    _session.tickers = tickers;
    _session.shortlist = items;
    barPoller.updateTickers(tickers);
    volumeBaseline.ensureBuilt(tickers, toETDate(Date.now())).catch(() => {});
    // Kick a fresh context poll so the Market Gate for the new tickers
    // fills in immediately rather than waiting up to 30 s.
    pollContext(tickers).catch(() => {});
    return { ok: true, count: tickers.length };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

// ─── Pause / Resume ──────────────────────────────────────────────────────────

function pause(reason = 'manual') {
  if (!isActive()) return { ok: false, reason: 'No active session to pause' };
  _session.status = 'paused';
  db.prepare("UPDATE trading_sessions SET status = 'paused' WHERE id = ?").run(_session.id);
  barPoller.stop();
  // brokerSync stays running across pause/end — Alpaca fills can still
  // land afterhours or via manual close on Alpaca's own UI, and we
  // need to keep our local record in sync regardless of session state.
  console.log(`[TradingSession] Paused ${_session.id} (${reason})`);
  router.broadcast({ type: 'session_paused', reason, ts: Date.now() });
  return { ok: true };
}

function resume() {
  if (!isPaused()) return { ok: false, reason: 'No paused session to resume' };
  _session.status = 'active';
  db.prepare("UPDATE trading_sessions SET status = 'active' WHERE id = ?").run(_session.id);
  // Reload setups in case the user edited them while paused.
  setupEngine.loadSetups();
  // Single source of truth: setup engine loaded the setups above, so pull
  // that same list here rather than querying the DB again.
  const activeSetups = setupEngine.getActiveSetupsArray();
  const sid = _session.id;
  const tickers = _session.tickers;
  barPoller.start(sid, tickers, activeSetups, (signal, sesid) => {
    if (!isActive()) return;
    setupEngine.onIndicatorFire(signal, sesid, (enrichedSignal) => {
      const q = barPoller.getLatestQuote(enrichedSignal.ticker);
      router.processSignal(
        { ...enrichedSignal, sessionId: sesid },
        q?.bid ?? null,
        q?.ask ?? null
      ).catch(err => console.warn('[TradingSession] processSignal error:', err.message));
    });
  });
  console.log(`[TradingSession] Resumed ${_session.id}`);
  router.broadcast({ type: 'session_resumed', ts: Date.now() });
  return { ok: true };
}

// ─── Session end ─────────────────────────────────────────────────────────────

function end(reason = 'manual') {
  if (!_session) return { ok: false, reason: 'No active session' };

  clearInterval(_contextPollInterval);
  _contextPollInterval = null;
  barPoller.stop();
  // brokerSync stays running across pause/end — Alpaca fills can still
  // land afterhours or via manual close on Alpaca's own UI, and we
  // need to keep our local record in sync regardless of session state.

  db.prepare("UPDATE trading_sessions SET ended_at = ?, status = 'ended' WHERE id = ?")
    .run(Date.now(), _session.id);

  console.log(`[TradingSession] Ended ${_session.id} (${reason})`);
  const ended = { ..._session, status: 'ended' };
  _session = null;
  _initialPollDone = false;

  router.broadcast({ type: 'session_ended', reason, ts: Date.now() });
  return { ok: true, session: ended };
}

// ─── Daily auto start/stop — 9:35 AM ET start, 10:00 AM ET end (per plan) ────

let _lastAutoStartDate = null;
let _lastAutoEndDate = null;

function _etParts(now) {
  const hour = parseInt(new Date(now).toLocaleString('en-US', { timeZone: 'America/New_York', hour: 'numeric', hour12: false }));
  const min  = parseInt(new Date(now).toLocaleString('en-US', { timeZone: 'America/New_York', minute: 'numeric' }));
  return { hour, min };
}

setInterval(() => {
  const now = Date.now();
  const today = toETDate(now);
  const { hour, min } = _etParts(now);

  if (hour === 9 && min === 35 && !isRunning() && _lastAutoStartDate !== today) {
    _lastAutoStartDate = today;
    start().then(r => {
      if (!r.ok) console.warn('[TradingSession] Auto-start failed:', r.reason);
    });
  }

  if (hour === 10 && min === 0 && isRunning() && _lastAutoEndDate !== today) {
    _lastAutoEndDate = today;
    end('auto');
  }
}, 20000);

module.exports = { start, end, pause, resume, getSession, isActive, isPaused, isRunning, isGateReady, pollContext, refreshSetups, refreshShortlist };
