/**
 * Trading Session Manager
 *
 * Manages the lifecycle of a trading session:
 *   - Pull shortlist from scanner at 9:35
 *   - Poll scanner context every 30s (9:35–10:00), update Side A
 *   - Load setups for Side B
 *   - Graceful end at 10:00
 */

const { v4: uuidv4 } = require('uuid');
const db = require('../db');
const sideA = require('./sideA');
const sideB = require('./sideB');
const center = require('./center');
const barPoller = require('./barPoller');
const { toETDate } = require('../utils/time');

const SCANNER_URL = process.env.SCANNER_URL || 'http://127.0.0.1:3000';

let _session = null;
let _contextPollInterval = null;

function getSession() {
  return _session;
}

function isActive() {
  return _session?.status === 'active';
}

// ─── Shortlist fetch ──────────────────────────────────────────────────────────

async function fetchShortlist() {
  const res = await fetch(`${SCANNER_URL}/api/shortlist/today`);
  if (!res.ok) throw new Error(`Scanner shortlist fetch failed: ${res.status}`);
  return res.json();
}

// ─── Context poll ─────────────────────────────────────────────────────────────

async function pollContext(tickers) {
  if (!tickers.length) return;
  try {
    // Fetch r0 rows for shortlisted tickers from scanner's registry
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
    sideA.updateAll(entries);
  } catch (e) {
    console.warn('[TradingSession] Context poll failed:', e.message);
  }
}

// ─── Session start ────────────────────────────────────────────────────────────

async function start() {
  if (isActive()) return { ok: false, reason: 'Session already active' };

  const today = toETDate(Date.now());
  const sessionId = uuidv4();

  // Pull shortlist
  let shortlistEntry;
  try {
    shortlistEntry = await fetchShortlist();
  } catch (e) {
    return { ok: false, reason: `Failed to fetch shortlist: ${e.message}` };
  }

  const shortlist = shortlistEntry?.items || [];
  const tickers = shortlist.map(i => i.ticker).filter(Boolean);

  // Persist session
  db.prepare(`
    INSERT INTO trading_sessions (id, date, started_at, shortlist, status)
    VALUES (?, ?, ?, ?, 'active')
  `).run(sessionId, today, Date.now(), JSON.stringify(shortlist));

  // Load Side A with initial data (shortlist items may carry _score)
  sideA.clear();
  for (const item of shortlist) {
    sideA.update(item.ticker, {}, item._score, item._scoreDetails);
  }

  // Load setups for Side B
  sideB.loadSetups();
  sideB.clearSessionLog();

  _session = { id: sessionId, date: today, tickers, shortlist, status: 'active', startedAt: Date.now() };

  // Initial context poll
  await pollContext(tickers);

  // Context poll every 30s
  _contextPollInterval = setInterval(() => {
    if (!isActive()) return;
    const now = Date.now();
    const etHour = new Date(now).toLocaleString('en-US', { timeZone: 'America/New_York', hour: 'numeric', hour12: false });
    const etMin  = new Date(now).toLocaleString('en-US', { timeZone: 'America/New_York', minute: 'numeric' });
    const minutesSince935 = (parseInt(etHour) - 9) * 60 + parseInt(etMin) - 35;
    const minutesSince1000 = (parseInt(etHour) - 10) * 60 + parseInt(etMin);
    if (minutesSince935 >= 0 && minutesSince1000 < 0) {
      pollContext(tickers);
    }
  }, 30000);

  // Bar poller — runs indicator engines every 60s
  const activeSetups = db.prepare('SELECT * FROM trading_setups WHERE enabled = 1').all()
    .map(r => ({ ...r, config: JSON.parse(r.config || '{}') }));
  barPoller.start(sessionId, tickers, activeSetups, (signal, sid) => {
    sideB.onIndicatorFire(signal, sid, (enrichedSignal) => {
      center.processSignal({ ...enrichedSignal, sessionId: sid });
    });
  });

  console.log(`[TradingSession] Started ${sessionId} with ${tickers.length} tickers`);
  return { ok: true, sessionId, tickers, shortlist };
}

// ─── Session end ──────────────────────────────────────────────────────────────

function end(reason = 'manual') {
  if (!_session) return { ok: false, reason: 'No active session' };

  clearInterval(_contextPollInterval);
  _contextPollInterval = null;
  barPoller.stop();

  db.prepare("UPDATE trading_sessions SET ended_at = ?, status = 'ended' WHERE id = ?")
    .run(Date.now(), _session.id);

  console.log(`[TradingSession] Ended ${_session.id} (${reason})`);
  const ended = { ..._session, status: 'ended' };
  _session = null;

  center.broadcast({ type: 'session_ended', reason, ts: Date.now() });
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

  if (hour === 9 && min === 35 && !isActive() && _lastAutoStartDate !== today) {
    _lastAutoStartDate = today;
    start().then(r => {
      if (!r.ok) console.warn('[TradingSession] Auto-start failed:', r.reason);
    });
  }

  if (hour === 10 && min === 0 && isActive() && _lastAutoEndDate !== today) {
    _lastAutoEndDate = today;
    end('auto');
  }
}, 20000);

module.exports = { start, end, getSession, isActive, pollContext };
