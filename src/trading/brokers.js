/**
 * Broker Registry
 *
 * A "broker profile" is a named destination the Router can send an order
 * to. Types today:
 *   - 'paper'   — records the order locally, never touches an external API
 *   - 'alpaca'  — routes to Alpaca (paper or live URL) using this profile's keys
 *
 * A user can have many profiles and enable any subset — the Router will
 * fan out to every enabled profile. This lets them run one setup on
 * Alpaca paper, the same setup on another paper account, and record
 * everything locally, all at once.
 *
 * NOTE: This registry is passive today. The actual submission wiring for
 * 'alpaca' type is stubbed — Router calls send() which just logs. Order
 * submission is deferred (per plan) until the user gives the go-ahead.
 */

const db = require('../db');
const { v4: uuidv4 } = require('uuid');

db.exec(`
  CREATE TABLE IF NOT EXISTS trading_brokers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    type TEXT NOT NULL,
    config TEXT NOT NULL DEFAULT '{}',
    enabled INTEGER NOT NULL DEFAULT 1,
    is_default INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );
`);

const VALID_TYPES = ['paper', 'alpaca'];

function _row(r, opts = {}) {
  if (!r) return null;
  const cfg = safeParse(r.config);
  // Mask secrets in list responses — the raw config is still available
  // for internal callers via getRaw(id).
  const config = opts.masked === false ? cfg : maskSecrets(cfg);
  return {
    id:        r.id,
    name:      r.name,
    type:      r.type,
    config,
    enabled:   r.enabled === 1,
    isDefault: r.is_default === 1,
    createdAt: r.created_at,
  };
}

function maskSecrets(cfg) {
  const out = { ...cfg };
  if (out.secret) out.secret = 'set';
  // Key stays visible so the user can eyeball which profile is which.
  return out;
}

function safeParse(s) {
  try { return JSON.parse(s || '{}'); } catch { return {}; }
}

/**
 * Ensure at least a paper profile always exists — the tool should be
 * usable out-of-the-box without configuration.
 */
function seedDefaults() {
  const row = db.prepare("SELECT id FROM trading_brokers WHERE type = 'paper' AND name = 'Local Paper'").get();
  if (!row) {
    db.prepare(`
      INSERT INTO trading_brokers (id, name, type, config, enabled, is_default, created_at)
      VALUES (?, 'Local Paper', 'paper', '{}', 1, 1, ?)
    `).run(uuidv4(), Date.now());
  }
}
seedDefaults();

function list(opts = {}) {
  const where = opts.enabledOnly ? 'WHERE enabled = 1' : '';
  return db.prepare(`SELECT * FROM trading_brokers ${where} ORDER BY is_default DESC, name`).all().map(_row);
}

function get(id) {
  return _row(db.prepare('SELECT * FROM trading_brokers WHERE id = ?').get(id));
}

function create({ name, type, config = {}, enabled = true, isDefault = false }) {
  if (!name) throw new Error('name is required');
  if (!VALID_TYPES.includes(type)) throw new Error(`type must be one of: ${VALID_TYPES.join(', ')}`);
  const id = uuidv4();
  const txn = db.transaction(() => {
    if (isDefault) db.prepare('UPDATE trading_brokers SET is_default = 0').run();
    db.prepare(`
      INSERT INTO trading_brokers (id, name, type, config, enabled, is_default, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, name, type, JSON.stringify(config), enabled ? 1 : 0, isDefault ? 1 : 0, Date.now());
  });
  txn();
  return get(id);
}

function update(id, patch) {
  const row = db.prepare('SELECT * FROM trading_brokers WHERE id = ?').get(id);
  if (!row) return null;
  // Merge config on top of the existing one so a partial patch
  // (e.g. no `secret` field) doesn't wipe fields the caller didn't touch.
  const existingCfg = safeParse(row.config);
  const mergedCfg   = patch.config != null ? { ...existingCfg, ...patch.config } : existingCfg;
  const next = {
    name:      patch.name    ?? row.name,
    type:      patch.type    ?? row.type,
    config:    JSON.stringify(mergedCfg),
    enabled:   patch.enabled != null ? (patch.enabled ? 1 : 0) : row.enabled,
    isDefault: patch.isDefault != null ? (patch.isDefault ? 1 : 0) : row.is_default,
  };
  if (!VALID_TYPES.includes(next.type)) throw new Error('invalid type');
  const txn = db.transaction(() => {
    if (next.isDefault) db.prepare('UPDATE trading_brokers SET is_default = 0').run();
    db.prepare('UPDATE trading_brokers SET name=?, type=?, config=?, enabled=?, is_default=? WHERE id=?')
      .run(next.name, next.type, next.config, next.enabled, next.isDefault, id);
  });
  txn();
  return get(id);
}

function remove(id) {
  db.prepare('DELETE FROM trading_brokers WHERE id = ?').run(id);
}

/**
 * The Router asks for "who should this order be sent to." Returns the
 * currently enabled profiles WITH raw config (unmasked) so the caller
 * has the real key/secret needed to actually submit.
 */
function getActive() {
  const rows = db.prepare("SELECT * FROM trading_brokers WHERE enabled = 1").all();
  const mapped = rows.map(r => _row(r, { masked: false }));
  if (mapped.length > 0) return mapped;
  return db.prepare("SELECT * FROM trading_brokers WHERE type = 'paper' LIMIT 1")
    .all().map(r => _row(r, { masked: false }));
}

/**
 * Unmasked lookup for internal callers (e.g. when actually submitting
 * to Alpaca and we need the real secret). NEVER expose over HTTP.
 */
function getRaw(id) {
  return _row(db.prepare('SELECT * FROM trading_brokers WHERE id = ?').get(id), { masked: false });
}

const PAPER_URL = 'https://paper-api.alpaca.markets';
const LIVE_URL  = 'https://api.alpaca.markets';

/**
 * Submit an order to a broker profile.
 *
 * paper type ....... offline-only, records nothing external.
 * alpaca env=paper . POSTs to paper-api.alpaca.markets/v2/orders. Real
 *                    fills, real slippage, no real money.
 * alpaca env=live .. still stubbed — flip when the user says go.
 *
 * Bracket order: entry + stop_loss + take_profit in one submit so
 * Alpaca handles exits even if this process dies. Our local
 * positionMonitor still watches bars but the source of truth for
 * closed P&L is the Alpaca fill.
 */
async function send(broker, order) {
  if (!broker) return { ok: false, error: 'No broker profile' };
  if (broker.type === 'paper') {
    return { ok: true, submitted: false, mode: 'paper', brokerId: broker.id, brokerName: broker.name };
  }
  if (broker.type !== 'alpaca') {
    return { ok: false, error: `Unknown broker type ${broker.type}` };
  }

  const cfg = broker.config || {};
  // env is derived from the profile's URL — the UI lets the user pick
  // Paper vs Live in the "Base URL" dropdown, so we don't want a second
  // field to keep in sync. Falls back to explicit `env` if set.
  const url = (cfg.url || PAPER_URL).toLowerCase();
  const env = cfg.env
    ? String(cfg.env).toLowerCase()
    : (url.includes('paper-api') ? 'paper' : 'live');
  if (env === 'live') {
    return {
      ok: true, submitted: false, mode: 'live-stub',
      brokerId: broker.id, brokerName: broker.name,
      note: 'Live submission is deliberately stubbed — flip in brokers.js when ready',
    };
  }

  if (!cfg.key || !cfg.secret) {
    return { ok: false, error: 'Alpaca profile missing key/secret', brokerId: broker.id };
  }

  // Prefer the user-configured URL if it looks like Alpaca; otherwise
  // fall back to the paper endpoint.
  const base = cfg.url && /alpaca\.markets/i.test(cfg.url) ? cfg.url : PAPER_URL;
  const payload = {
    symbol:        order.ticker,
    qty:           String(order.shares),
    side:          order.direction === 'Long' ? 'buy' : 'sell',
    type:          order.entryType === 'limit' ? 'limit' : 'market',
    time_in_force: 'day',
    client_order_id: order.orderId,
  };
  if (payload.type === 'limit' && order.entryPrice) payload.limit_price = String(order.entryPrice);
  // Bracket: SL + TP legs in the same submit so Alpaca owns the exit.
  if (order.sl && order.tp) {
    payload.order_class    = 'bracket';
    payload.stop_loss      = { stop_price: String(order.sl) };
    payload.take_profit    = { limit_price: String(order.tp) };
  }

  try {
    const resp = await fetch(`${base}/v2/orders`, {
      method: 'POST',
      headers: {
        'APCA-API-KEY-ID':     cfg.key,
        'APCA-API-SECRET-KEY': cfg.secret,
        'Content-Type':        'application/json',
      },
      body: JSON.stringify(payload),
    });
    const body = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      return {
        ok: false, submitted: false,
        brokerId: broker.id, brokerName: broker.name,
        error: `Alpaca ${resp.status}: ${body.message || body.code || 'submit failed'}`,
        response: body,
      };
    }
    return {
      ok: true, submitted: true, mode: `alpaca-${env}`,
      brokerId: broker.id, brokerName: broker.name,
      alpacaOrderId: body.id || null,
      alpacaStatus:  body.status || null,
      response: body,
    };
  } catch (err) {
    return {
      ok: false, submitted: false,
      brokerId: broker.id, brokerName: broker.name,
      error: `Alpaca network error: ${err.message}`,
    };
  }
}

module.exports = {
  list,
  get,
  getRaw,
  create,
  update,
  remove,
  getActive,
  send,
  VALID_TYPES,
};
