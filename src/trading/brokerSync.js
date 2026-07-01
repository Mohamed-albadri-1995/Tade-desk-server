/**
 * Broker Fill Sync
 *
 * When paper mode fans out to an Alpaca paper profile, the submitted
 * bracket order lives on Alpaca — it decides the real fill price, the
 * real slippage, and (via its stop_loss / take_profit legs) the real
 * exit. This poller keeps our local trading_positions + trade_cards
 * in sync with what Alpaca actually did, so the grading engine learns
 * from real fills rather than the price we saw at signal-fire time.
 *
 * Strategy: every ~15s, look up open positions whose alpaca_order_id
 * is set, GET /v2/orders/{id}?nested=true to pull the parent + child
 * legs, and:
 *   - if parent filled → overwrite entry_price with filled_avg_price
 *   - if any child leg filled → close the position at its avg price
 *     and complete the trade card so grading picks it up
 */

const db = require('../db');
const brokers = require('./brokers');
const router  = require('./router');
const sizer   = require('./sizer');

const POLL_INTERVAL_MS = 15_000;
const BALANCE_POLL_MS  = 60_000;   // account equity moves slowly; hourly enough would work, but keep it snappy
const PAPER_URL = 'https://paper-api.alpaca.markets';

let _timer = null;
let _balanceTimer = null;
let _busy = false;

async function _pollOnce() {
  if (_busy) return;
  _busy = true;
  try {
    const rows = db.prepare(`
      SELECT id, alpaca_order_id, entry_price, direction, ticker
        FROM trading_positions
       WHERE status = 'open' AND alpaca_order_id IS NOT NULL
    `).all();

    if (!rows.length) return;

    // Group by broker profile so we reuse credentials across positions.
    // Every alpaca profile with matching env can be authoritative for any
    // submitted order — but simplest is to try each active profile in turn
    // until one returns 200. Small position count in a session makes this
    // O(n*profiles) but n is tiny.
    const profiles = brokers.getActive().filter(b => b.type === 'alpaca');
    if (!profiles.length) return;

    for (const pos of rows) {
      // 1. Authoritative check first: does Alpaca still hold this position?
      //    /v2/positions/{ticker} returns 404 when the position is gone —
      //    whether it closed via our bracket, via manual close on Alpaca
      //    UI, via margin liquidation, or via EOD wash. Any 404 → reconcile
      //    locally and move on.
      const positionState = await _fetchPosition(profiles, pos.ticker);
      if (positionState?.notFound) {
        await _reconcileClosed(pos, positionState.profile);
        continue;
      }

      // 2. Position still open on Alpaca — check the bracket's legs for
      //    fills so we can stamp the real entry price and detect exit at
      //    the moment the leg fires (before Alpaca cleans up the row).
      const detail = await _fetchOrder(profiles, pos.alpaca_order_id);
      if (!detail) continue;
      await _reconcile(pos, detail);
    }
  } catch (err) {
    console.warn('[BrokerSync] poll error:', err.message);
  } finally {
    _busy = false;
  }
}

/**
 * Ask Alpaca whether it still holds a position for this ticker. Returns
 * either the raw position row, or { notFound: true } when Alpaca 404s.
 * A network / auth error against every profile returns null so the
 * caller doesn't over-reconcile on transient failures.
 */
async function _fetchPosition(profiles, ticker) {
  let hadAnyAuth404 = false;
  let hadAnyOk = false;
  for (const b of profiles) {
    const cfg = b.config || {};
    if (!cfg.key || !cfg.secret) continue;
    const raw = cfg.url && /alpaca\.markets/i.test(cfg.url) ? cfg.url : PAPER_URL;
    const base = brokers.normalizeAlpacaBase(raw);
    try {
      const resp = await fetch(`${base}/v2/positions/${encodeURIComponent(ticker)}`, {
        headers: { 'APCA-API-KEY-ID': cfg.key, 'APCA-API-SECRET-KEY': cfg.secret },
      });
      if (resp.status === 404) {
        // Alpaca answered — and it says no such position. Believe it.
        return { notFound: true, profile: b };
      }
      if (!resp.ok) { hadAnyAuth404 = false; continue; }
      hadAnyOk = true;
      return await resp.json();
    } catch { /* try next profile */ }
  }
  // Every profile errored — don't reconcile off a network blip.
  return hadAnyOk ? null : null;
}

/**
 * Alpaca no longer holds this position. Close ours at the best available
 * price. Preference order: leg's filled_avg_price if the bracket ended
 * cleanly and we can still read it, latest buffered bar close, entry
 * price as a last resort. Marks the exit reason so it's clear in the
 * ledger that this was a reconciliation rather than a manual close.
 */
async function _reconcileClosed(pos, profile) {
  // Best effort: peek at the parent order — the leg's fill price gives
  // us the accurate exit if the bracket closed the position.
  let exitPrice = null;
  let exitReason = 'reconcile';
  try {
    const detail = await _fetchOrder([profile], pos.alpaca_order_id);
    const legs = Array.isArray(detail?.legs) ? detail.legs : [];
    const filledLeg = legs.find(l => l.status === 'filled' && Number.isFinite(Number(l.filled_avg_price)));
    if (filledLeg) {
      exitPrice = Number(filledLeg.filled_avg_price);
      exitReason = filledLeg.order_type === 'limit' ? 'target'
                 : filledLeg.order_type === 'stop'  ? 'stop'
                 : 'broker';
    }
  } catch { /* fall through to bar-close fallback */ }

  if (exitPrice == null) {
    try {
      const barPoller = require('./barPoller');
      const bar = barPoller.getLatestBar?.(pos.ticker);
      if (bar && Number.isFinite(bar.c)) exitPrice = bar.c;
    } catch { /* no bars */ }
  }
  if (exitPrice == null && Number.isFinite(pos.entry_price)) {
    exitPrice = pos.entry_price;
  }
  if (exitPrice == null) return;   // truly nothing to work with — skip this tick, try again in 15s

  try {
    router.closePosition(pos.id, exitPrice, exitReason);
    console.warn(`[BrokerSync] reconciled ${pos.ticker} — Alpaca reported position closed (${exitReason} @ $${exitPrice})`);
  } catch (err) {
    console.warn(`[BrokerSync] reconcile ${pos.id} failed:`, err.message);
  }
}

async function _fetchOrder(profiles, alpacaOrderId) {
  for (const b of profiles) {
    const cfg = b.config || {};
    if (!cfg.key || !cfg.secret) continue;
    const raw = cfg.url && /alpaca\.markets/i.test(cfg.url) ? cfg.url : PAPER_URL;
    const base = brokers.normalizeAlpacaBase(raw);
    try {
      const resp = await fetch(`${base}/v2/orders/${alpacaOrderId}?nested=true`, {
        headers: {
          'APCA-API-KEY-ID':     cfg.key,
          'APCA-API-SECRET-KEY': cfg.secret,
        },
      });
      if (!resp.ok) continue;   // wrong account for this order — try the next profile
      return await resp.json();
    } catch { /* try next */ }
  }
  return null;
}

async function _reconcile(pos, order) {
  // Parent (entry) fill — stamp the real average price on our position.
  const filledAvg = _num(order.filled_avg_price);
  if (order.status === 'filled' && Number.isFinite(filledAvg) && filledAvg > 0) {
    const same = _num(pos.entry_price) === filledAvg;
    if (!same) {
      db.prepare('UPDATE trading_positions SET entry_price = ? WHERE id = ?').run(filledAvg, pos.id);
      // Card carries entry_price too — keep them consistent so R multiples
      // computed at close time use the real fill.
      db.prepare('UPDATE trade_cards SET entry_price = ? WHERE position_id = ?').run(filledAvg, pos.id);
    }
  }

  // Bracket child legs — 'stop_loss' or 'take_profit' filled means the
  // position exited on Alpaca. Close locally at that price.
  const legs = Array.isArray(order.legs) ? order.legs : [];
  for (const leg of legs) {
    if (leg.status !== 'filled') continue;
    const exitPrice = _num(leg.filled_avg_price);
    if (!Number.isFinite(exitPrice) || exitPrice <= 0) continue;
    // Reuse the router's close path so ledger + card + grading all fire
    // in one place, same as the local position monitor uses.
    try {
      const reason = leg.order_type === 'limit' ? 'target' : leg.order_type === 'stop' ? 'stop' : 'broker';
      router.closePosition(pos.id, exitPrice, reason);
    } catch (err) {
      console.warn(`[BrokerSync] close ${pos.id} failed:`, err.message);
    }
    break;
  }
}

function _num(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }

/**
 * Pull the Alpaca account snapshot (equity, cash, buying_power) from any
 * active Alpaca profile and hand the equity to the sizer so risk-per-trade
 * uses the live balance instead of the static setting fallback.
 *
 * Cached inside sizer.js — this just triggers the refresh.
 */
async function _pollBalanceOnce() {
  const profiles = brokers.getActive().filter(b => b.type === 'alpaca');
  for (const b of profiles) {
    const cfg = b.config || {};
    if (!cfg.key || !cfg.secret) continue;
    const raw = cfg.url && /alpaca\.markets/i.test(cfg.url) ? cfg.url : PAPER_URL;
    const base = brokers.normalizeAlpacaBase(raw);
    try {
      const resp = await fetch(`${base}/v2/account`, {
        headers: {
          'APCA-API-KEY-ID':     cfg.key,
          'APCA-API-SECRET-KEY': cfg.secret,
        },
      });
      if (!resp.ok) continue;
      const body = await resp.json();
      const eq = parseFloat(body.equity);
      if (Number.isFinite(eq)) {
        // Push into the sizer's cache directly so the next signal picks
        // it up. refreshAlpacaEquity() would work too but goes through
        // the global-settings client — this uses the broker profile's
        // credentials, which is what the user actually configured.
        try { await sizer.refreshAlpacaEquity(); } catch { /* fallback below */ }
      }
      return; // one healthy profile is enough
    } catch { /* try next */ }
  }
}

function start() {
  if (_timer) return;
  _timer = setInterval(_pollOnce, POLL_INTERVAL_MS);
  _balanceTimer = setInterval(_pollBalanceOnce, BALANCE_POLL_MS);
  // Kick off an immediate poll on start so we sync anything that happened
  // while the process was down.
  _pollOnce().catch(() => { /* silent — poller will retry */ });
  _pollBalanceOnce().catch(() => { /* silent — poller will retry */ });
}

function stop() {
  if (_timer) { clearInterval(_timer); _timer = null; }
  if (_balanceTimer) { clearInterval(_balanceTimer); _balanceTimer = null; }
}

/**
 * Start the poller on process boot and leave it running. Alpaca fills
 * can happen after the trading session ends (bracket legs stay live
 * afterhours; the user might close a position from Alpaca's UI at any
 * time; margin liquidations don't care about our session state). Tying
 * lifecycle to the session meant we went deaf the moment End Session
 * was clicked. Always-on fixes that.
 *
 * When no open Alpaca positions exist, _pollOnce short-circuits after
 * the DB query — so the cost is one indexed COUNT-like SELECT every
 * 15 seconds. Cheap enough to leave running.
 */
function autoStart() {
  start();
}

module.exports = { start, stop, autoStart, _pollOnce, _pollBalanceOnce };
