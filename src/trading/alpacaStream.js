/**
 * Alpaca Market Data WebSocket client (per trading plan)
 *
 * Streams live 1-min bars and quotes for the shortlist tickers. Used as
 * an alternative to the 60-second HTTP poller when the user selects
 * websocket in the data-source setting.
 *
 * Uses Node's built-in WebSocket (Node 22+).
 */

const db = require('../db');

const IEX_URL  = 'wss://stream.data.alpaca.markets/v2/iex';
const SIP_URL  = 'wss://stream.data.alpaca.markets/v2/sip';

const RECONNECT_MIN_MS  = 2_000;
const RECONNECT_MAX_MS  = 30_000;

function getCredentials() {
  const rows = db
    .prepare("SELECT key, value FROM settings WHERE key IN ('alpacaApiKey','alpacaApiSecret')")
    .all();
  const creds = {};
  for (const r of rows) creds[r.key] = r.value;
  if (!creds.alpacaApiKey || !creds.alpacaApiSecret) {
    throw new Error('Alpaca credentials not set — add them in Settings > API Keys');
  }
  return { key: creds.alpacaApiKey, secret: creds.alpacaApiSecret };
}

function getFeedUrl() {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'alpacaMarketFeed'").get();
  const feed = (row?.value || 'iex').toLowerCase();
  return feed === 'sip' ? SIP_URL : IEX_URL;
}

/**
 * Convert an Alpaca bar message ({T:'b', S, o, h, l, c, v, t, ...}) into
 * the shape the bar poller / indicator engines expect ({t, o, h, l, c, v, etTime}).
 */
function normalizeBar(msg) {
  const iso = msg.t;
  let etTime = null;
  if (iso) {
    // Alpaca sends ISO 8601 with millisecond precision
    const d = new Date(iso);
    const parts = d.toLocaleTimeString('en-US', {
      timeZone: 'America/New_York',
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
    });
    etTime = parts;
  }
  return {
    t:      msg.t,
    o:      msg.o,
    h:      msg.h,
    l:      msg.l,
    c:      msg.c,
    v:      msg.v,
    etTime,
  };
}

// ────────────────────────────────────────────────────────────
// Stream implementation
// ────────────────────────────────────────────────────────────

class AlpacaStream {
  /**
   * @param {object} opts
   * @param {string[]} opts.tickers    Tickers to subscribe to
   * @param {(ticker, bar) => void}   opts.onBar    Called on each 1-min bar
   * @param {(ticker, quote) => void} [opts.onQuote] Called on each bid/ask update
   * @param {(err) => void}           [opts.onError] Non-fatal error hook
   */
  constructor({ tickers, onBar, onQuote, onError }) {
    this.tickers = (tickers || []).map(t => String(t).toUpperCase());
    this.onBar   = onBar   || (() => {});
    this.onQuote = onQuote || (() => {});
    this.onError = onError || ((err) => console.warn('[AlpacaStream]', err.message || err));
    this.ws = null;
    this.stopped = false;
    this.connected = false;
    this.authed = false;
    this.reconnectDelay = RECONNECT_MIN_MS;
    this.lastQuote = new Map(); // ticker → { bid, ask, at }
    this.status = {
      connected: false,
      authed:    false,
      lastMsgAt: null,
      lastError: null,
      subscribedTo: [...this.tickers],
      feed: null,
    };
  }

  getStatus() {
    return { ...this.status, lastQuote: Object.fromEntries(this.lastQuote) };
  }

  getLatestQuote(ticker) {
    return this.lastQuote.get(String(ticker).toUpperCase()) || null;
  }

  start() {
    this.stopped = false;
    this._connect();
  }

  stop() {
    this.stopped = true;
    if (this.ws) {
      try { this.ws.close(); } catch { /* ignore */ }
    }
    this.ws = null;
    this.connected = false;
    this.authed = false;
    this.status.connected = false;
    this.status.authed = false;
  }

  _connect() {
    if (this.stopped) return;

    let creds;
    try {
      creds = getCredentials();
    } catch (err) {
      this.onError(err);
      this._scheduleReconnect();
      return;
    }

    const url = getFeedUrl();
    this.status.feed = url.endsWith('/sip') ? 'sip' : 'iex';
    console.log('[AlpacaStream] Connecting to', url);

    let ws;
    try {
      ws = new WebSocket(url);
    } catch (err) {
      this.onError(err);
      this._scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.addEventListener('open', () => {
      this.connected = true;
      this.status.connected = true;
      this.reconnectDelay = RECONNECT_MIN_MS;
      ws.send(JSON.stringify({ action: 'auth', key: creds.key, secret: creds.secret }));
    });

    ws.addEventListener('message', (ev) => {
      this.status.lastMsgAt = Date.now();
      let msgs;
      try { msgs = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString()); }
      catch { return; }
      if (!Array.isArray(msgs)) msgs = [msgs];
      for (const msg of msgs) this._handleMessage(msg);
    });

    ws.addEventListener('error', (ev) => {
      const err = ev?.error || new Error('WebSocket error');
      this.status.lastError = err.message || 'ws error';
      this.onError(err);
    });

    ws.addEventListener('close', () => {
      this.connected = false;
      this.authed = false;
      this.status.connected = false;
      this.status.authed = false;
      if (!this.stopped) this._scheduleReconnect();
    });
  }

  _handleMessage(msg) {
    if (!msg || !msg.T) return;

    // Auth / status messages
    if (msg.T === 'success' && msg.msg === 'authenticated') {
      this.authed = true;
      this.status.authed = true;
      this._subscribe();
      return;
    }
    if (msg.T === 'subscription') {
      // { T: 'subscription', trades: [...], quotes: [...], bars: [...] }
      return;
    }
    if (msg.T === 'error') {
      this.onError(new Error(`Alpaca stream error ${msg.code}: ${msg.msg}`));
      return;
    }

    // Data messages
    if (msg.T === 'b') {
      const ticker = String(msg.S || '').toUpperCase();
      const bar = normalizeBar(msg);
      this.onBar(ticker, bar);
      return;
    }
    if (msg.T === 'q') {
      const ticker = String(msg.S || '').toUpperCase();
      const quote = { bid: msg.bp, ask: msg.ap, bs: msg.bs, as: msg.as, at: Date.now() };
      this.lastQuote.set(ticker, quote);
      this.onQuote(ticker, quote);
      return;
    }
    // Ignore trades and everything else for now
  }

  _subscribe() {
    if (!this.authed || !this.tickers.length) return;
    const payload = {
      action: 'subscribe',
      bars:   this.tickers,
      quotes: this.tickers,
    };
    try { this.ws.send(JSON.stringify(payload)); }
    catch (err) { this.onError(err); }
  }

  _scheduleReconnect() {
    if (this.stopped) return;
    const delay = this.reconnectDelay;
    console.log('[AlpacaStream] Reconnecting in', delay, 'ms');
    setTimeout(() => this._connect(), delay);
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, RECONNECT_MAX_MS);
  }
}

module.exports = { AlpacaStream, IEX_URL, SIP_URL };
