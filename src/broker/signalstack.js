/*
 * Sending an order to the broker, through SignalStack.
 *
 * SignalStack is a bridge: you POST a signal to a webhook URL and it places the
 * order at the connected broker (here Trade The Pool). The minimum body is
 *
 *     {"symbol":"AAPL","quantity":1,"action":"buy"}
 *
 * and the market entry needs nothing more. But the documented parameters also
 * include `stop_loss_price` and `take_profit_price` — a bracket — and this
 * setup has both: a stop that is the frozen 10:00 VWAP and a 2R target, decided
 * at the same instant as the entry. Sending them together is the difference
 * between a position that is protected the moment it fills and one that is
 * protected when you get to your phone. They are sent by default and can be
 * switched off, never silently omitted.
 *
 * WHAT COMES BACK. 201 with {id, status, price} — status 'filled' or
 * 'accepted', and price the average fill. So the ledger records what was
 * actually paid rather than what was hoped for, and the gap between the ranked
 * price and the fill is visible instead of assumed. An error is 400 with
 * {status, message}, the message coming from the broker itself.
 *
 * WHAT IT STILL CANNOT DO. There is no endpoint to ask what the account's
 * buying power is. So the buying power here is a number you enter, and this
 * side keeps its own tally of what it has committed today. That tally is an
 * estimate: it does not see exits, or anything placed by hand. It is a guard
 * against over-ordering, not an account balance.
 *
 * The broker's own rejection is the backstop. When it answers that the order
 * would overbuy the account, the quantity is halved and tried again — bounded,
 * and only for that class of error, because a 400 means nothing was placed
 * while a timeout means nobody knows.
 *
 * WHY THE URL IS NOT IN THE REPO. Anyone holding that URL can place orders in
 * this account. It lives in data/broker.json, which is gitignored along with
 * the rest of data/, is never logged in full, and is never returned by the API
 * — the page gets a masked version, enough to tell two hooks apart.
 */

const fs = require('fs');
const path = require('path');

const DIR = process.env.DATA_DIR || path.join(__dirname, '..', '..', 'data');
const FILE = process.env.BROKER_FILE || path.join(DIR, 'broker.json');
const LEDGER = process.env.BROKER_LEDGER || path.join(DIR, 'broker-orders.jsonl');

const HOOK_RE = /^https:\/\/app\.signalstack\.com\/hook\/[A-Za-z0-9]+$/;

function read() {
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return raw && typeof raw === 'object' ? raw : {};
  } catch {
    return {};
  }
}

function write(obj) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  const tmp = `${FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, FILE);
}

/** …/hook/3UwmLr5p… — enough to tell two hooks apart, useless to anyone else. */
function mask(url) {
  if (!url) return null;
  const id = String(url).split('/').pop();
  return id.length > 8 ? `…/hook/${id.slice(0, 4)}…${id.slice(-4)}` : '…/hook/…';
}

/*
 * Everything off by default, and `armed` separate from `enabled`.
 *
 * enabled means "this is configured"; armed means "send real orders". They are
 * two switches because the dangerous one should not be the one you flip while
 * setting the safe one up, and because a bad morning should be stoppable
 * without deleting the configuration.
 */
function settings() {
  const s = read();
  const num = v => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : null;
  };
  return {
    enabled: s.enabled === true,
    armed: s.armed === true,
    webhookUrl: s.webhookUrl || null,
    testWebhookUrl: s.testWebhookUrl || null,
    // What the broker says you can buy with. Entered, not read — see the note
    // at the top.
    buyingPower: num(s.buyingPower),
    // A ceiling on any single order, independent of buying power. The setup
    // sizes by risk, and a very tight stop produces a very large position; this
    // is the line past which no single name is worth that concentration.
    maxOrderValue: num(s.maxOrderValue),
    // Shorting is a separate permission at most prop firms, and sending a sell
    // that the account cannot take is a rejected order at the worst moment.
    allowShort: s.allowShort !== false,
    /*
     * Send the stop and the target with the entry.
     *
     * On by default. The setup decides all three at the same instant and the
     * stop is the whole risk model — an entry that arrives without it is a
     * position with no defined loss until someone gets to their phone. Off is
     * for an account that rejects brackets, and then the alert still carries
     * both numbers to place by hand.
     */
    bracket: s.bracket !== false,
    // Reduce and retry when the BROKER says the order overbuys the account.
    // Bounded, and only for that answer — see placeOrder.
    retryOnBuyingPower: s.retryOnBuyingPower !== false,
    updatedAt: s.updatedAt || null,
  };
}

/** The same, with the URLs masked — this is what the page is allowed to see. */
function publicSettings() {
  const s = settings();
  return {
    ...s,
    webhookUrl: mask(s.webhookUrl),
    testWebhookUrl: mask(s.testWebhookUrl),
    hasWebhook: !!s.webhookUrl,
    hasTestWebhook: !!s.testWebhookUrl,
  };
}

function save(patch = {}) {
  const next = { ...read() };

  for (const key of ['webhookUrl', 'testWebhookUrl']) {
    if (!(key in patch)) continue;
    const v = patch[key];
    if (v === '' || v === null) { delete next[key]; continue; }
    const url = String(v).trim();
    // Checked rather than trusted: a typo here does not fail loudly, it fails
    // by placing no order and looking exactly like a quiet morning.
    if (!HOOK_RE.test(url)) {
      throw new Error('that is not a SignalStack hook URL — it should look like '
        + 'https://app.signalstack.com/hook/XXXXXXXX');
    }
    next[key] = url;
  }

  for (const key of ['buyingPower', 'maxOrderValue']) {
    if (!(key in patch)) continue;
    const v = patch[key];
    if (v === '' || v === null) { delete next[key]; continue; }
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) throw new Error(`${key} must be a positive number`);
    next[key] = n;
  }

  if ('allowShort' in patch) next.allowShort = patch.allowShort !== false;
  if ('bracket' in patch) next.bracket = patch.bracket !== false;
  if ('retryOnBuyingPower' in patch) {
    next.retryOnBuyingPower = patch.retryOnBuyingPower !== false;
  }
  if ('enabled' in patch) next.enabled = patch.enabled === true;
  if ('armed' in patch) {
    // Arming without somewhere to send to would be a switch that reads "live"
    // and does nothing — the worst state for this particular switch.
    if (patch.armed === true && !next.webhookUrl) {
      throw new Error('set the webhook URL before arming');
    }
    if (patch.armed === true && !next.buyingPower) {
      throw new Error('set the buying power before arming — without it there is '
        + 'nothing to size against and an order could be any size');
    }
    next.armed = patch.armed === true;
  }

  next.updatedAt = Date.now();
  write(next);
  return publicSettings();
}

// ── the ledger ─────────────────────────────────────────────────────────────

/*
 * Every order this side has attempted, appended and never rewritten.
 *
 * It is the only record that an order was sent at all — SignalStack's reply
 * says "accepted", the broker is where it becomes a position, and the two are
 * reconciled by hand. A line here is what makes that possible.
 */
function record(entry) {
  try {
    fs.mkdirSync(path.dirname(LEDGER), { recursive: true });
    fs.appendFileSync(LEDGER, `${JSON.stringify(entry)}\n`);
  } catch (err) {
    console.error('[Broker] could not write the order ledger:', err.message);
  }
}

function orders(date = null) {
  let raw;
  try { raw = fs.readFileSync(LEDGER, 'utf8'); } catch { return []; }
  const out = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const o = JSON.parse(line);
      if (date && o.date !== date) continue;
      out.push(o);
    } catch { /* one bad line does not spoil the day */ }
  }
  return out;
}

/**
 * What is left to spend today, by this side's own tally.
 *
 * Only SENT orders count. A rejected signal committed nothing, and counting it
 * would shrink the next order for a trade that never happened.
 */
function committed(date) {
  return orders(date)
    .filter(o => o.sent)
    .reduce((sum, o) => sum + (o.quantity * o.price || 0), 0);
}

function remaining(date, cfg = settings()) {
  if (!cfg.buyingPower) return null;
  return Math.max(0, cfg.buyingPower - committed(date));
}

// ── sizing the order ───────────────────────────────────────────────────────

/**
 * The quantity that actually fits, as a whole number.
 *
 * Two rules, in this order:
 *
 *   whole shares    Trade The Pool takes no fractions, and a fractional
 *                   quantity is not rounded by the bridge — it is rejected, or
 *                   worse, silently truncated somewhere downstream. So it is
 *                   floored here, once, and asserted before sending.
 *
 *   what is left    If the position does not fit the remaining buying power it
 *                   is reduced to what does, rather than sent whole to be
 *                   rejected. A smaller position in the right name beats no
 *                   position, and a rejection at 10:00:03 cannot be retried
 *                   in time.
 *
 * Returns the quantity and, when it changed, why — because "12 shares" and
 * "12 shares, you asked for 40" are different things to read at the moment an
 * order goes out.
 */
function fitQuantity({ quantity, price, date = null, cfg = settings() }) {
  const asked = Math.floor(Number(quantity) || 0);
  if (!(asked > 0)) return { quantity: 0, asked: 0, reason: 'no shares to send' };
  if (!(Number(price) > 0)) {
    return { quantity: 0, asked, reason: 'no price to size against' };
  }

  let qty = asked;
  const notes = [];

  if (cfg.maxOrderValue) {
    const byOrder = Math.floor(cfg.maxOrderValue / price);
    if (byOrder < qty) {
      notes.push(`capped at $${cfg.maxOrderValue} per order (${byOrder} shares)`);
      qty = byOrder;
    }
  }

  const left = remaining(date, cfg);
  if (left !== null) {
    const byPower = Math.floor(left / price);
    if (byPower < qty) {
      notes.push(`reduced to fit $${left.toFixed(0)} of buying power left `
        + `(${byPower} shares)`);
      qty = byPower;
    }
  }

  // Floored again after every cap. Each division above can only produce an
  // integer, but this is the assertion that the thing leaving here is one.
  qty = Math.max(0, Math.floor(qty));

  return {
    quantity: qty,
    asked,
    reason: qty === 0
      ? (notes[0] || 'nothing fits the remaining buying power')
      : (notes.join('; ') || null),
  };
}

/** LONG opens with a buy, SHORT with a sell. The bridge takes no other verbs. */
function actionFor(signal) {
  const s = String(signal || '').toUpperCase();
  if (s === 'LONG' || s === 'BUY') return 'buy';
  if (s === 'SHORT' || s === 'SELL') return 'sell';
  return null;
}

// ── sending ────────────────────────────────────────────────────────────────

/**
 * POST one signal. Exactly the three documented fields, and nothing else.
 *
 * Deliberately not retried. This is a market entry at a fixed minute: a second
 * attempt seconds later is a different price, and an attempt that races a
 * first one that actually succeeded is a double position. A failure is
 * reported, not repaired.
 */
async function post(url, body, timeoutMs = 8000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const text = await res.text().catch(() => '');
    let json = null;
    try { json = JSON.parse(text); } catch { /* not every error is JSON */ }
    return {
      ok: res.ok,
      httpStatus: res.status,
      // 'filled' | 'accepted' | 'placed' on success; 'ValidationError' and
      // friends on failure. Carried through rather than flattened to a boolean,
      // because filled and accepted are different mornings.
      status: json && json.status ? String(json.status) : null,
      orderId: json && json.id ? String(json.id) : null,
      // The average fill price. The one number that says what the trade
      // actually cost, as opposed to the price it was ranked at.
      fillPrice: json && Number.isFinite(Number(json.price)) ? Number(json.price) : null,
      message: json && json.message ? String(json.message) : null,
      body: text.slice(0, 400),
    };
  } finally {
    clearTimeout(t);
  }
}

/*
 * Is this the broker saying the account cannot afford it?
 *
 * Matched on the documented shape — a ValidationError whose message is the
 * broker's own — plus the wording those messages use. Deliberately narrow: this
 * is the ONLY answer that earns a retry, because a 400 means nothing was placed
 * and the same is not true of a timeout, where a retry can double a position.
 */
const POWER_RE = /oversold|overbought|buying power|insufficient|not enough|exceeds|margin/i;

function isBuyingPowerRejection(res) {
  if (!res || res.ok) return false;
  if (res.httpStatus !== 400) return false;
  return POWER_RE.test(res.message || res.body || '');
}

/**
 * Place the entry for one of a setup's picks.
 *
 * Every path returns a result and records a line — including every path that
 * sends nothing. An order that was not placed and an order that was placed are
 * both facts about the morning, and the one thing that must never happen is
 * not being able to tell which it was.
 */
async function placeOrder({ symbol, signal, quantity, price, stop = null,
                            target = null, date, source = null,
                            cfg = settings() }) {
  const base = {
    at: Date.now(), date, symbol, signal, price, stop, target, source,
    asked: Math.floor(Number(quantity) || 0),
  };

  if (!cfg.enabled) return { ...base, sent: false, skipped: 'orders are switched off' };
  if (!cfg.armed) {
    const fit = fitQuantity({ quantity, price, date, cfg });
    // Not armed is the normal, safe state, and it still says what it WOULD
    // have done — that is what makes arming it later a decision rather than a
    // leap.
    const out = { ...base, quantity: fit.quantity, sent: false,
      skipped: 'not armed — this is what would have been sent',
      would: { symbol, quantity: fit.quantity, action: actionFor(signal) } };
    record(out);
    return out;
  }

  const action = actionFor(signal);
  if (!action) {
    const out = { ...base, sent: false, error: `cannot turn ${signal} into buy or sell` };
    record(out); return out;
  }
  if (action === 'sell' && !cfg.allowShort) {
    const out = { ...base, sent: false, skipped: 'shorting is switched off' };
    record(out); return out;
  }
  if (!cfg.webhookUrl) {
    const out = { ...base, sent: false, error: 'no webhook URL configured' };
    record(out); return out;
  }

  const fit = fitQuantity({ quantity, price, date, cfg });
  if (fit.quantity < 1) {
    const out = { ...base, quantity: 0, sent: false,
      skipped: `no order: ${fit.reason}` };
    record(out); return out;
  }

  /*
   * The body. Built in one place so what goes on the wire can be read here.
   *
   * quantity_type 'fixed' is the documented default and is sent explicitly:
   * the alternative is 'cash', where the same number means dollars, and a
   * default that changes underneath would turn 40 shares into $40 of stock.
   */
  const order = qty => {
    const b = {
      symbol: String(symbol).toUpperCase(),
      action,
      quantity: qty,
      quantity_type: 'fixed',
    };
    // The stop is the risk model; the target is what makes it 2R. Both are
    // decided at the same instant as the entry, so they travel with it.
    if (cfg.bracket && Number(stop) > 0) b.stop_loss_price = Number(stop);
    if (cfg.bracket && Number(target) > 0) b.take_profit_price = Number(target);
    return b;
  };

  /*
   * Send, and reduce once if the BROKER — not this side's tally — says the
   * account cannot afford it.
   *
   * Halving rather than computing: the broker did not say how much it was
   * short by, and a guess dressed as arithmetic reads as certainty. Bounded at
   * three attempts and a floor of one share, so a persistently rejecting
   * account produces three refusals and a clear message rather than a loop at
   * the busiest second of the morning.
   */
  const attempts = [];
  let qty = fit.quantity;
  let res = null;

  for (let i = 0; i < 3 && qty >= 1; i += 1) {
    const body = order(qty);
    // The assertion, immediately before the wire. Every path above floors, so
    // this can only fire if one of them is ever changed.
    if (!Number.isInteger(body.quantity) || body.quantity < 1) {
      const out = { ...base, sent: false,
        error: `refused a non-whole quantity (${body.quantity})` };
      record(out); return out;
    }

    try {
      res = await post(cfg.webhookUrl, body);
    } catch (err) {
      // A network failure is NOT retried: the request may have arrived, and a
      // second one would be a second position. Reported, not repaired.
      const out = { ...base, quantity: qty, action, sent: false, attempts,
        error: `could not reach SignalStack: ${err.message} — check the broker `
          + 'before assuming nothing was placed' };
      record(out); return out;
    }

    attempts.push({ quantity: qty, httpStatus: res.httpStatus,
      status: res.status, message: res.message });

    if (res.ok) break;
    if (!(cfg.retryOnBuyingPower && isBuyingPowerRejection(res))) break;
    qty = Math.floor(qty / 2);
  }

  const out = {
    ...base,
    quantity: res && res.ok ? qty : (attempts[attempts.length - 1] || {}).quantity || qty,
    action,
    bracket: cfg.bracket && (Number(stop) > 0 || Number(target) > 0),
    // `sent` means SignalStack accepted it. `status` says whether the broker
    // FILLED it or merely accepted it — different mornings, and collapsing them
    // is how an unfilled order becomes an imaginary position.
    sent: !!(res && res.ok),
    status: res ? res.status : null,
    httpStatus: res ? res.httpStatus : null,
    orderId: res ? res.orderId : null,
    // What it actually cost, when the broker says. The gap between this and
    // `price` is the slippage between the bar that was ranked and the fill.
    fillPrice: res ? res.fillPrice : null,
    reduced: [
      fit.quantity !== fit.asked ? fit.reason : null,
      attempts.length > 1
        ? `broker refused ${attempts[0].quantity} (${attempts[0].message || 'no buying power'}) — `
          + `reduced to ${qty}`
        : null,
    ].filter(Boolean).join('; ') || null,
    attempts: attempts.length > 1 ? attempts : undefined,
    message: res ? res.message : null,
    error: res && res.ok ? null
      : `${(res && res.status) || 'no answer'}: ${(res && res.message) || 'order refused'}`,
  };
  record(out);
  return out;
}

/**
 * Send a one-share test, to the test hook when there is one.
 *
 * The only way to find out that a URL is wrong, an account is disconnected or a
 * symbol is unsupported is to send something. Doing that for the first time at
 * 10:00:02 with a real position is not a plan.
 */
async function test({ symbol = 'AAPL', useTestHook = true } = {}) {
  const cfg = settings();
  const url = (useTestHook && cfg.testWebhookUrl) || cfg.webhookUrl;
  if (!url) throw new Error('no webhook URL configured');
  const body = {
    symbol: String(symbol).toUpperCase(), action: 'buy',
    quantity: 1, quantity_type: 'fixed',
  };
  const res = await post(url, body);
  const out = {
    at: Date.now(), date: null, symbol: body.symbol, quantity: 1, action: 'buy',
    source: 'manual test', hook: useTestHook && cfg.testWebhookUrl ? 'test' : 'live',
    sent: res.ok, status: res.status, httpStatus: res.httpStatus,
    orderId: res.orderId, fillPrice: res.fillPrice, message: res.message,
  };
  record(out);
  return { ...out, requestBody: body };
}

module.exports = {
  FILE, LEDGER, HOOK_RE,
  settings, publicSettings, save, mask,
  orders, committed, remaining, fitQuantity, actionFor, placeOrder, test,
};
