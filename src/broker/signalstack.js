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
 * WHERE AN ORDER GOES.
 *
 * There was one hook, so "the broker" and "the account" were the same thing and
 * neither needed naming. With two — a prop-firm account and an Alpaca account —
 * they come apart in every direction that matters: different hooks, different
 * balances, different day counts, and a body that is not quite the same shape.
 * A setup may want one, the other, both, or neither.
 *
 * A DESTINATION is one account reached through one hook. Everything that is a
 * property of the account lives on it — the hook, the buying power, the daily
 * cap, the per-order ceiling. Everything that is a property of the BOX stays
 * account-wide: armed, shorting allowed, brackets, the flatten time. Arming is
 * still one decision, because "may this machine place orders at all" is not a
 * question you want to answer twice.
 *
 * `dialect` is what the body looks like on arrival. SignalStack normalises most
 * of it, but not all: Alpaca accepts `class` and `duration` and Trade The Pool
 * does not, and sending a field a broker does not know is a rejected order at
 * the one moment nobody is watching.
 */
const DIALECTS = {
  /*
   * Trade The Pool — what this has always sent, unchanged. Named so the
   * default is a choice rather than an accident.
   */
  ttp: {
    label: 'Trade The Pool',
    body: (b) => b,
  },
  /*
   * Alpaca. `class` says which market — SignalStack's docs require it for cash
   * and percent-of-equity orders and accept it always, and being explicit costs
   * nothing while guessing costs an order. `duration: day` matches what the
   * strategies assume: everything is flattened at 15:50, so an order that
   * survived the session would be a position nothing here is managing.
   */
  alpaca: {
    label: 'Alpaca',
    body: (b) => ({ ...b, class: 'stock', duration: 'day' }),
  },
};

/** The id used for a hook configured before destinations existed. */
const LEGACY_ID = 'ttp';

/*
 * The stored destinations, with the old single-hook shape read as one.
 *
 * Migration by READING rather than by rewriting the file: a broker config that
 * silently changed shape on first load would be a bad thing to discover halfway
 * through a morning, and this way an older build still reads it too.
 */
function destinations(s = read()) {
  const num = v => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : null;
  };
  const rows = Array.isArray(s.destinations) ? s.destinations : [];
  const out = rows
    .filter(d => d && d.id)
    .map(d => ({
      id: String(d.id),
      name: String(d.name || DIALECTS[d.dialect] && DIALECTS[d.dialect].label || d.id),
      dialect: DIALECTS[d.dialect] ? d.dialect : 'ttp',
      webhookUrl: d.webhookUrl || null,
      testWebhookUrl: d.testWebhookUrl || null,
      buyingPower: num(d.buyingPower),
      maxOrderValue: num(d.maxOrderValue),
      maxTradesPerDay: num(d.maxTradesPerDay),
      enabled: d.enabled !== false,
    }));
  if (out.length) return out;
  // Nothing migrated yet: the single hook, if there is one, IS a destination.
  if (!s.webhookUrl && !s.testWebhookUrl) return [];
  return [{
    id: LEGACY_ID,
    name: DIALECTS.ttp.label,
    dialect: 'ttp',
    webhookUrl: s.webhookUrl || null,
    testWebhookUrl: s.testWebhookUrl || null,
    buyingPower: num(s.buyingPower),
    maxOrderValue: num(s.maxOrderValue),
    maxTradesPerDay: num(s.maxTradesPerDay),
    enabled: true,
  }];
}

/*
 * One destination as a cfg — the same shape planOrder, previewOrder and
 * placeOrder already take.
 *
 * This is why two brokers did not become two code paths. Every guard, every
 * cap, every validation runs exactly as it did; it just runs against this
 * account's hook and this account's balance.
 */
function destinationCfg(id, s = read()) {
  const base = settings(s);
  const d = destinations(s).find(x => x.id === id);
  if (!d) return null;
  return {
    ...base,
    destinationId: d.id,
    destinationName: d.name,
    dialect: d.dialect,
    webhookUrl: d.webhookUrl,
    testWebhookUrl: d.testWebhookUrl,
    buyingPower: d.buyingPower,
    maxOrderValue: d.maxOrderValue,
    maxTradesPerDay: d.maxTradesPerDay,
    enabled: base.enabled && d.enabled,
  };
}

/*
 * WHERE A SETUP'S ORDERS GO — and no guessing when there is a choice.
 *
 * A setup names its destinations by id. This turns that list into cfgs, or
 * says why it cannot, and the saying-why is the point: an order that goes to
 * the wrong account is worse than an order that does not go, and an order sent
 * nowhere while the alert reads "ORDER ACCEPTED" is worse than both.
 *
 * Named ids are honoured exactly. An id that does not exist is an ERROR, never
 * a silent omission — a setup routed to a broker that was deleted last week
 * would otherwise go on alerting as if it were trading.
 *
 * An EMPTY list means "not said". With one account configured there is nothing
 * to decide and it is used. With two, there is no such thing as the obvious
 * one, so nothing is sent and the alert says which two it was choosing between.
 * This is the same rule as the ranking metric: unset means unset.
 */
function route(ids = [], s = read()) {
  const all = destinations(s);
  const live = all.filter(d => d.enabled && d.webhookUrl);
  const named = (Array.isArray(ids) ? ids : []).map(String).filter(Boolean);

  if (!named.length) {
    if (!live.length) {
      return { cfgs: [], error: all.length
        ? 'no broker is switched on — every destination is disabled or has no hook'
        : 'no broker is configured' };
    }
    if (live.length > 1) {
      return { cfgs: [], error: 'this setup does not say which broker to use, and '
        + `there are ${live.length} to choose from (${live.map(d => d.name).join(', ')}). `
        + 'Pick its brokers on the Setups tab' };
    }
    return { cfgs: [destinationCfg(live[0].id, s)], error: null };
  }

  const missing = named.filter(id => !all.some(d => d.id === id));
  if (missing.length) {
    return { cfgs: [], error: `this setup is routed to ${missing.join(', ')}, `
      + `which ${missing.length > 1 ? 'are' : 'is'} not configured` };
  }
  const off = named.filter(id => !live.some(d => d.id === id));
  if (off.length) {
    return { cfgs: [], error: `${off.join(', ')} ${off.length > 1 ? 'are' : 'is'} `
      + 'switched off or has no hook' };
  }
  // Deduplicated, because the same account twice is the same trade twice.
  const seen = new Set();
  const cfgs = [];
  for (const id of named) {
    if (seen.has(id)) continue;
    seen.add(id);
    cfgs.push(destinationCfg(id, s));
  }
  return { cfgs, error: null };
}

/*
 * Everything off by default, and `armed` separate from `enabled`.
 *
 * enabled means "this is configured"; armed means "send real orders". They are
 * two switches because the dangerous one should not be the one you flip while
 * setting the safe one up, and because a bad morning should be stoppable
 * without deleting the configuration.
 */
function settings(pre = null) {
  const s = pre || read();
  const num = v => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : null;
  };
  return {
    enabled: s.enabled === true,
    armed: s.armed === true,
    // Where orders can go. Read through the migration, so a config written
    // before destinations existed reports its single hook as one of them.
    destinations: destinations(s),
    webhookUrl: s.webhookUrl || null,
    testWebhookUrl: s.testWebhookUrl || null,
    // What the broker says you can buy with. Entered, not read — see the note
    // at the top.
    buyingPower: num(s.buyingPower),
    // A ceiling on any single order, independent of buying power. The setup
    // sizes by risk, and a very tight stop produces a very large position; this
    // is the line past which no single name is worth that concentration.
    maxOrderValue: num(s.maxOrderValue),
    /*
     * The most orders this box will send in one session, whatever fires.
     *
     * A cap on the DAY rather than on any one order, and the guard that a
     * per-order size limit cannot be: a strategy misfiring, a second strategy
     * assigned by mistake, or simply a morning with more signals than usual all
     * produce correctly-sized orders that together are not a day anyone chose.
     * Counted from the ledger, so a restart does not reset it.
     */
    maxTradesPerDay: num(s.maxTradesPerDay),
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
    /*
     * FLATTEN EVERYTHING AT THIS MINUTE, ET.
     *
     * A strategy can leave part of a position with no exit rule the broker can
     * hold. "Take half at 2R and let the rest run" sends a runner with a stop
     * and no target: the backtest closes it at the end of the session, and the
     * broker does not — it sits there overnight, in an account that is not
     * allowed to hold overnight.
     *
     * So the box closes what it opened. 15:50 by default, ten minutes before
     * the bell, which is the same cutoff the backtests use.
     */
    flatten: s.flatten !== false,
    flattenAt: /^([01]\d|2[0-3]):[0-5]\d$/.test(String(s.flattenAt || ''))
      ? String(s.flattenAt) : '15:50',
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
    /*
     * EVERY hook masked, including the ones inside destinations.
     *
     * Adding destinations to settings() put the raw URLs back on this object,
     * and this function is what the page reads. A hook IS the ability to place
     * orders in the account behind it; on screen it can be photographed, and in
     * a chat window it has been published. The existing test caught it, which
     * is the only reason this line exists rather than a leak.
     */
    destinations: (s.destinations || []).map(d => ({
      ...d,
      webhookUrl: mask(d.webhookUrl),
      testWebhookUrl: mask(d.testWebhookUrl),
      hasWebhook: !!d.webhookUrl,
      hasTestWebhook: !!d.testWebhookUrl,
    })),
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

  for (const key of ['buyingPower', 'maxOrderValue', 'maxTradesPerDay']) {
    if (!(key in patch)) continue;
    const v = patch[key];
    if (v === '' || v === null) { delete next[key]; continue; }
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) throw new Error(`${key} must be a positive number`);
    next[key] = n;
  }

  /*
   * The destinations, replaced whole rather than merged.
   *
   * A partial update would make "remove the second broker" impossible to
   * express — the absence of a key reads as "leave it alone" everywhere else in
   * this function, and here it has to be able to mean "it is gone". The caller
   * sends the list it wants.
   *
   * Every hook is checked, for the same reason the single one was: a typo does
   * not fail loudly, it fails by placing no order and looking like a quiet
   * morning. An unknown dialect is refused rather than defaulted — sending
   * Alpaca's fields to a broker that rejects them is an order lost at the one
   * moment nobody is watching.
   */
  if ('destinations' in patch) {
    const rows = Array.isArray(patch.destinations) ? patch.destinations : [];
    const seen = new Set();
    /*
     * What is already stored, by id — so a hook can survive a save that does
     * not mention it.
     *
     * The page never sees a hook; publicSettings masks it, deliberately, since
     * a hook IS the ability to place orders in the account behind it. That
     * makes an edit of anything ELSE on a destination — its buying power, its
     * daily cap, its name — a form that cannot send the hook back. Without
     * this, raising a balance would silently disconnect the account.
     *
     * Omitted means keep. An explicit empty string still means clear, so
     * removing a hook is possible and is a thing you have to actually do.
     */
    const stored = new Map(destinations().map(d => [d.id, d]));
    next.destinations = rows.map((d, i) => {
      const id = String((d && d.id) || '').trim().toLowerCase();
      if (!/^[a-z0-9_-]{2,20}$/.test(id)) {
        throw new Error(`destination ${i + 1} needs a short id (letters, digits, - or _)`);
      }
      if (seen.has(id)) throw new Error(`two destinations share the id "${id}"`);
      seen.add(id);
      if (!DIALECTS[d.dialect]) {
        throw new Error(`destination "${id}": unknown broker type "${d.dialect}" — `
          + `one of ${Object.keys(DIALECTS).join(', ')}`);
      }
      const out = { id, dialect: d.dialect, name: String(d.name || '').trim() || id,
                    enabled: d.enabled !== false };
      const was = stored.get(id);
      for (const key of ['webhookUrl', 'testWebhookUrl']) {
        const v = d[key];
        if (v === undefined) {
          if (was && was[key]) out[key] = was[key];   // not mentioned — keep it
          continue;
        }
        if (v === '' || v === null) continue;          // said to be gone
        const url = String(v).trim();
        if (!HOOK_RE.test(url)) {
          throw new Error(`destination "${id}": that is not a SignalStack hook URL`);
        }
        out[key] = url;
      }
      for (const key of ['buyingPower', 'maxOrderValue', 'maxTradesPerDay']) {
        const v = d[key];
        if (v === '' || v === null || v === undefined) continue;
        const n = Number(v);
        if (!Number.isFinite(n) || n <= 0) {
          throw new Error(`destination "${id}": ${key} must be a positive number`);
        }
        out[key] = n;
      }
      return out;
    });
  }

  if ('allowShort' in patch) next.allowShort = patch.allowShort !== false;
  if ('flatten' in patch) next.flatten = patch.flatten !== false;
  if ('flattenAt' in patch) {
    const v = String(patch.flattenAt || '').trim();
    if (!v) delete next.flattenAt;
    else if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(v)) {
      throw new Error('flattenAt must look like 15:50');
    } else next.flattenAt = v;
  }
  if ('bracket' in patch) next.bracket = patch.bracket !== false;
  if ('retryOnBuyingPower' in patch) {
    next.retryOnBuyingPower = patch.retryOnBuyingPower !== false;
  }
  if ('enabled' in patch) next.enabled = patch.enabled === true;
  if ('armed' in patch) {
    /*
     * Arming without somewhere to send to would be a switch that reads "live"
     * and does nothing — the worst state for this particular switch.
     *
     * Asked of the DESTINATIONS rather than the old single hook, because with
     * two accounts "the webhook URL" is not a thing that exists. One live
     * destination is enough to arm; the ones that are not ready are named, so
     * arming with Alpaca half-configured tells you which half.
     */
    if (patch.armed === true) {
      const live = destinations(next).filter(d => d.enabled && d.webhookUrl);
      if (!live.length) {
        throw new Error('set a webhook URL on at least one broker before arming');
      }
      const broke = live.filter(d => !d.buyingPower).map(d => d.name);
      if (broke.length === live.length) {
        throw new Error('set the buying power before arming — without it there is '
          + 'nothing to size against and an order could be any size');
      }
      if (broke.length) {
        throw new Error(`${broke.join(', ')} has no buying power set — either give `
          + 'it one or switch it off, or a setup routed there will place nothing');
      }
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
/*
 * What has been spent today — on ONE destination.
 *
 * Two accounts must not share a balance. Before destinations there was one, so
 * one total was the whole truth; with two, a shared figure would let a $5,000
 * Alpaca order eat the prop-firm account's buying power, and the second broker
 * would refuse a trade it could easily afford.
 *
 * Entries written before destinations existed carry no id and belong to the
 * hook that was configured then — read as the legacy one, so today's count does
 * not restart mid-session on the day this ships.
 */
function committed(date, destination = null) {
  return orders(date)
    .filter(o => o.sent)
    .filter(o => !destination || (o.destination || LEGACY_ID) === destination)
    .reduce((sum, o) => sum + (o.quantity * o.price || 0), 0);
}

/**
 * How many orders actually went out today — all of them, or one setup's.
 *
 * Only SENT ones. A refusal placed no trade, and counting it would spend the
 * day's allowance on something that never happened.
 */
function tradesToday(date, setupId = null, destination = null) {
  return orders(date).filter(o => o.sent && o.kind !== 'callback'
    && (!setupId || o.setupId === setupId)
    && (!destination || (o.destination || LEGACY_ID) === destination)).length;
}

function remaining(date, cfg = settings()) {
  if (!cfg.buyingPower) return null;
  // This destination's balance, spent by this destination's orders.
  return Math.max(0, cfg.buyingPower - committed(date, cfg.destinationId || null));
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

/**
 * Split a position across a strategy's scale-out legs, in whole shares.
 *
 * SignalStack places one bracket per order and has no notion of scaling out, so
 * a strategy that banks a third at 1R and a third at 2R becomes THREE orders:
 * each takes its share of the size and carries its own take_profit_price, and
 * they share the stop. That is also how it would be done by hand.
 *
 * The remainder goes to the LAST leg — the runner if there is one, otherwise
 * the final target. Rounding 40 shares into thirds gives 13, 13, 13 and loses
 * one; giving the odd share to the part that rides furthest is the choice that
 * matches the intent, and losing it silently is the one that does not.
 *
 * A leg whose target has no price — one anchored to an indicator, which is
 * wherever that line sits on the bar — cannot be a resting order. It is folded
 * into the runner and reported, rather than sent without a target.
 */
function splitLegs(quantity, plan) {
  const total = Math.floor(Number(quantity) || 0);
  const legs = (plan && Array.isArray(plan.legs)) ? plan.legs : [];
  if (total < 1) return { parts: [], unplaceable: [] };

  const placeable = legs.filter(l => Number(l.price) > 0);
  const unplaceable = legs.filter(l => !(Number(l.price) > 0));
  // Everything the legs do not book rides the stop, plus anything whose target
  // could not be priced.
  const runnerFraction = Math.max(0, Number((plan && plan.runner) || 0))
    + unplaceable.reduce((n, l) => n + Number(l.fraction || 0), 0);

  const parts = [];
  let used = 0;
  for (const leg of placeable) {
    const qty = Math.floor(total * Number(leg.fraction || 0));
    if (qty < 1) continue;              // a leg too small to be a whole share
    parts.push({ quantity: qty, target: Number(leg.price),
                 rMultiple: leg.r_multiple, fraction: leg.fraction,
                 // PER LEG. The protocol lets two parts have their stops in
                 // different places — "2 SL / 2 TP" — so the stop travels with
                 // the leg rather than being assumed shared.
                 stop: leg.stop != null ? Number(leg.stop) : null,
                 trail: leg.trail || null });
    used += qty;
  }

  const left = total - used;
  if (left > 0) {
    if (runnerFraction > 0 || !parts.length) {
      // The runner: no target, rides the stop.
      parts.push({ quantity: left, target: null, rMultiple: null, runner: true });
    } else {
      // No runner — the odd shares join the furthest target rather than being
      // dropped, which would quietly place fewer shares than were sized.
      parts[parts.length - 1].quantity += left;
    }
  }
  /*
   * THE INVARIANT. Every share that was sized is ordered, and no more.
   *
   * This is the whole point of the protocol: the fractions add to one on the
   * qp side, and the shares add to the sized quantity here. Off by one in
   * either direction is a position that is not the one the risk settings
   * chose, and it looks exactly like one that is.
   */
  const placed = parts.reduce((n, p) => n + p.quantity, 0);
  if (placed !== total) {
    return { parts: [], unplaceable,
      error: `split ${total} shares into ${placed} — refusing to send a `
        + 'position that is not the one that was sized' };
  }
  return { parts, unplaceable };
}

/*
 * Prices go on the wire at two decimals, and the stop rounds the safe way.
 *
 * A target at 31.7925 is a sub-penny price. Brokers reject those, and a
 * rejection at 10:00:03 cannot be fixed in time — the R-multiples the strategy
 * works in produce them constantly, so this is not an edge case.
 *
 * The DIRECTION of the rounding is a risk decision, not a formatting one. The
 * share count was computed from the exact stop, so widening the stop by a
 * fraction of a cent makes the position risk more than the amount that was
 * chosen. The stop therefore rounds TOWARDS the entry — never past it — and the
 * position risks a hair less than asked rather than a hair more. Targets round
 * to nearest, where nothing is at stake either way.
 */
function tick(n) {
  return Math.round(Number(n) * 100) / 100;
}

function stopTick(stop, action) {
  const n = Number(stop);
  // buy: the stop is below the entry, so UP is towards it. sell: the reverse.
  const v = action === 'buy' ? Math.ceil(n * 100) / 100 : Math.floor(n * 100) / 100;
  return Math.round(v * 100) / 100;      // kills 27.680000000000003
}

/**
 * Everything that must be true of a body before it is allowed on the wire.
 *
 * This is the last gate, and it exists because the two shapes this sends are
 * built by different paths — one bracket for a single stop and target, several
 * for a scale-out — and a mistake in either produces a body that is still valid
 * JSON. SignalStack would take it and the broker would do something with it.
 *
 * Every check here is a rejection or a wrong position, not a style preference.
 */
function validateBody(body, { side, entry } = {}) {
  const errors = [];
  const isNum = v => typeof v === 'number' && Number.isFinite(v);

  if (!body || typeof body !== 'object') return ['no body'];
  if (!body.symbol || !/^[A-Z][A-Z0-9.\-]*$/.test(body.symbol)) {
    errors.push(`symbol ${JSON.stringify(body.symbol)} is not a ticker`);
  }
  if (body.action !== 'buy' && body.action !== 'sell') {
    errors.push(`action ${JSON.stringify(body.action)} must be buy or sell`);
  }
  // The one that cannot be got wrong: a fraction is rejected or truncated
  // somewhere downstream, and either way the position is not the sized one.
  if (!Number.isInteger(body.quantity) || body.quantity < 1) {
    errors.push(`quantity ${JSON.stringify(body.quantity)} must be a whole number of shares`);
  }
  if (body.quantity_type !== 'fixed') {
    // 'cash' would read the same number as dollars.
    errors.push("quantity_type must be 'fixed' — 'cash' would mean dollars");
  }

  for (const k of ['stop_loss_price', 'take_profit_price',
                   'stop_loss_price_distance', 'stop_loss_price_percent']) {
    if (k in body && !isNum(body[k])) errors.push(`${k} is not a number`);
    if (isNum(body[k]) && body[k] <= 0) errors.push(`${k} must be above zero`);
    if (isNum(body[k]) && k.endsWith('_price')
        && Math.round(body[k] * 100) !== body[k] * 100) {
      errors.push(`${k} ${body[k]} is a sub-penny price`);
    }
  }

  // Two stops is not a stop.
  if ('stop_loss_price' in body
      && ('stop_loss_price_percent' in body || 'stop_loss_price_distance' in body)) {
    errors.push('a fixed stop and a trailing stop cannot both be sent');
  }

  /*
   * The side check. A long whose stop sits above its entry is not a tight stop,
   * it is an instant exit — and a target on the wrong side is an order that
   * fills immediately at a loss. Both are valid JSON and neither is catchable
   * anywhere later.
   */
  if (isNum(Number(entry)) && Number(entry) > 0) {
    const e = Number(entry);
    if (isNum(body.stop_loss_price)) {
      const wrong = body.action === 'buy' ? body.stop_loss_price >= e
                                          : body.stop_loss_price <= e;
      if (wrong) {
        errors.push(`a ${body.action} cannot have its stop at ${body.stop_loss_price} `
          + `with the entry at ${e}`);
      }
    }
    if (isNum(body.take_profit_price)) {
      const wrong = body.action === 'buy' ? body.take_profit_price <= e
                                          : body.take_profit_price >= e;
      if (wrong) {
        errors.push(`a ${body.action} cannot have its target at ${body.take_profit_price} `
          + `with the entry at ${e}`);
      }
    }
  }
  return errors;
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
/**
 * Decide the order without sending it.
 *
 * EVERY gate lives here and nowhere else, so what a preview shows and what
 * actually leaves the box cannot be two different answers. That was the real
 * risk: the risk calculator says 18 shares, the buying power left says 12, the
 * day's cap says none at all — and a preview that reproduced any of that
 * separately would eventually reproduce it wrongly, which is worse than having
 * no preview, because it would be believed.
 *
 * Returns either `{ blocked, reason }` or `{ body, action, fit }`, where `body`
 * is the exact JSON that would go on the wire.
 */
function planOrder({ symbol, signal, quantity, price, stop = null, target = null,
                     date, setupId = null, maxPerDay = null, plan = null,
                     cfg = settings() }) {
  if (!cfg.enabled) return { blocked: 'off', reason: 'orders are switched off' };

  const action = actionFor(signal);
  if (!action) {
    return { blocked: 'side', reason: `cannot turn ${signal} into buy or sell` };
  }
  if (action === 'sell' && !cfg.allowShort) {
    return { blocked: 'short', reason: 'shorting is switched off' };
  }
  if (!cfg.webhookUrl) {
    return { blocked: 'unconfigured', reason: 'no webhook URL configured' };
  }

  /*
   * The two caps. The day's cap for the account and the day's cap for this
   * strategy are different questions — "how much am I willing to trade at all"
   * and "how much of that is this one idea allowed" — so hitting either says
   * WHICH, or the message sends you looking in the wrong settings.
   */
  if (cfg.maxTradesPerDay
      && tradesToday(date, null, cfg.destinationId || null) >= cfg.maxTradesPerDay) {
    return { blocked: 'account-cap',
      reason: `the day's limit of ${cfg.maxTradesPerDay} order(s) for the account is already used` };
  }
  if (maxPerDay && setupId && tradesToday(date, setupId) >= maxPerDay) {
    return { blocked: 'setup-cap',
      reason: `this setup's limit of ${maxPerDay} order(s) a day is already used` };
  }

  const fit = fitQuantity({ quantity, price, date, cfg });
  if (fit.quantity < 1) {
    return { blocked: 'size', reason: fit.reason || 'nothing fits', fit };
  }

  /*
   * The body. quantity_type 'fixed' is the documented default and is sent
   * explicitly: the alternative is 'cash', where the same number means dollars,
   * and a default that changed underneath would turn 40 shares into $40 of
   * stock.
   */
  const body = {
    symbol: String(symbol).toUpperCase(),
    action,
    quantity: fit.quantity,
    quantity_type: 'fixed',
  };
  // The stop is the risk model; the target is what makes it 2R. Both are
  // decided at the same instant as the entry, so they travel with it.
  if (cfg.bracket && Number(stop) > 0) body.stop_loss_price = stopTick(stop, action);
  if (cfg.bracket && Number(target) > 0) body.take_profit_price = tick(target);

  /*
   * A TRAILING stop, when the strategy's is one and it can be said as a
   * distance. SignalStack documents stop_loss_price_distance and
   * stop_loss_price_percent for exactly this, so a strategy tested with a 1.5%
   * trail is placed with a 1.5% trail rather than with a fixed stop that only
   * looks similar on the first bar.
   *
   * A stop anchored to an INDICATOR is not sent as a trail at all — it is
   * wherever that line sits on each bar, no broker can follow it, and a
   * plausible-looking distance would put the stop somewhere the backtest never
   * had one. It goes out as the frozen level with a warning attached.
   */
  const trail = plan && plan.trail;
  if (cfg.bracket && trail && Number(trail.value) > 0) {
    if (trail.kind === 'pct') body.stop_loss_price_percent = tick(trail.value);
    else body.stop_loss_price_distance = tick(trail.value);
    delete body.stop_loss_price;
  }

  /*
   * The scale-out. One order per leg, each with its own target, all sharing the
   * stop — SignalStack places one bracket per order and has no scale-out of its
   * own, so this is what a tested "third at 1R, third at 2R, let the rest run"
   * has to become.
   */
  const split = splitLegs(fit.quantity, plan);
  if (split.error) return { blocked: 'split', reason: split.error };

  const shape = (DIALECTS[cfg.dialect] || DIALECTS.ttp).body;
  const orders = (plan && plan.legs && plan.legs.length > 1)
    ? split.parts.map(part => {
      const b = { ...body, quantity: part.quantity };
      if (part.target && cfg.bracket) b.take_profit_price = tick(part.target);
      // The runner has no target and must not inherit the previous leg's.
      else delete b.take_profit_price;
      // This leg's own stop, when the protocol gave it one.
      if (cfg.bracket && Number(part.stop) > 0) {
        b.stop_loss_price = stopTick(part.stop, action);
        delete b.stop_loss_price_percent;
        delete b.stop_loss_price_distance;
      }
      if (cfg.bracket && part.trail && Number(part.trail.value) > 0) {
        if (part.trail.kind === 'pct') b.stop_loss_price_percent = tick(part.trail.value);
        else b.stop_loss_price_distance = tick(part.trail.value);
        delete b.stop_loss_price;
      }
      return b;
    })
    : [body];

  /*
   * The last gate, applied to EVERY body including each leg of a scale-out.
   *
   * Both shapes are built by different paths and a mistake in either is still
   * valid JSON — SignalStack would accept it and the broker would act on it. A
   * body that fails here is not sent at all: an order refused by this side
   * loses one trade, an order placed on the wrong side of its stop loses more
   * than that.
   */
  for (const b of orders) {
    const errors = validateBody(b, { side: signal, entry: price });
    if (errors.length) {
      return { blocked: 'invalid', reason: `refused to send: ${errors.join('; ')}` };
    }
  }

  /*
   * The broker's own dialect, applied LAST — after validation, never before.
   *
   * validateBody was written against the canonical fields and is the guard that
   * stops an order going out on the wrong side of its stop. Shaping first would
   * hand it a body it was not written for and quietly weaken it; shaping after
   * means every destination is checked identically and only then translated.
   * A dialect may add fields. It may not change what was checked.
   */
  const shaped = orders.map(b => shape(b));

  return { body: shaped[0], orders: shaped, action, fit,
           legs: split.parts, unplaceable: split.unplaceable };
}

/**
 * What would be sent, right now, and why it is not what was asked for.
 *
 * The same function the live path uses, stopped one step early. Nothing is
 * recorded and nothing leaves the box.
 */
function previewOrder(args) {
  const cfg = args.cfg || settings();
  const plan = planOrder({ ...args, cfg });
  const asked = Math.floor(Number(args.quantity) || 0);
  return {
    asked,
    // Armed is reported but does NOT block the preview: the whole point is to
    // see the real numbers before arming.
    armed: cfg.armed,
    blocked: plan.blocked || null,
    reason: plan.reason || (plan.fit && plan.fit.reason) || null,
    quantity: plan.body ? plan.body.quantity : ((plan.fit && plan.fit.quantity) || 0),
    body: plan.body || null,
    bracket: !!(plan.body && (plan.body.stop_loss_price || plan.body.take_profit_price)),
    remaining: remaining(args.date, cfg),
    tradesUsed: tradesToday(args.date, null, cfg.destinationId || null),
    maxTradesPerDay: cfg.maxTradesPerDay,
    setupTradesUsed: args.setupId
      ? tradesToday(args.date, args.setupId, cfg.destinationId || null) : null,
    destination: cfg.destinationId || null,
    destinationName: cfg.destinationName || null,
  };
}

async function placeOrder({ symbol, signal, quantity, price, stop = null,
                            target = null, date, source = null, setupId = null,
                            maxPerDay = null, plan: exitPlan = null,
                            cfg = settings() }) {
  const base = {
    at: Date.now(), date, symbol, signal, price, stop, target, source,
    // Recorded so the per-setup cap can be counted from the ledger rather than
    // from anything held in memory — a restart at 10:00 must not hand a setup
    // its whole allowance back.
    setupId,
    // WHICH account this went to. The buying power and the daily cap are read
    // back from these lines, so an order that did not say where it went would
    // be spent out of every account at once.
    destination: cfg.destinationId || null,
    asked: Math.floor(Number(quantity) || 0),
  };

  const plan = planOrder({ symbol, signal, quantity, price, stop, target, date,
                           setupId, maxPerDay, plan: exitPlan, cfg });

  if (!cfg.armed) {
    // Not armed is the normal, safe state, and it still says what it WOULD have
    // done — that is what makes arming it later a decision rather than a leap.
    const out = { ...base, quantity: plan.body ? plan.body.quantity : 0, sent: false,
      skipped: plan.blocked
        ? `not armed, and also: ${plan.reason}`
        : 'not armed — this is what would have been sent',
      would: plan.body || null };
    record(out);
    return out;
  }

  if (plan.blocked) {
    const out = { ...base, quantity: (plan.fit && plan.fit.quantity) || 0, sent: false,
      [plan.blocked === 'side' || plan.blocked === 'unconfigured' ? 'error' : 'skipped']:
        plan.reason };
    record(out); return out;
  }

  const { body: planned, action, fit } = plan;

  /*
   * A SCALE-OUT goes out as several orders, and counts as ONE trade.
   *
   * Several because SignalStack places one bracket per order and has no
   * scale-out of its own; one trade because the day's caps are about how many
   * POSITIONS were taken, and letting a three-leg strategy spend three of them
   * would make a cap of four mean "one and a bit trades".
   *
   * No halve-and-retry here, unlike the single-order path. Halving one leg of a
   * tested scale-out does not make it smaller, it makes it a different shape —
   * so a refusal stops the rest and is reported with exactly what did go in.
   */
  if (plan.orders && plan.orders.length > 1) {
    const results = [];
    for (const body of plan.orders) {
      if (!Number.isInteger(body.quantity) || body.quantity < 1) continue;
      let r;
      try {
        r = await post(cfg.webhookUrl, body);
      } catch (err) {
        results.push({ quantity: body.quantity, sent: false, error: err.message });
        break;                        // see the note above about retries
      }
      results.push({ quantity: body.quantity, target: body.take_profit_price || null,
                     sent: r.ok, status: r.status, orderId: r.orderId,
                     fillPrice: r.fillPrice, message: r.message });
      if (!r.ok) break;
    }
    const done = results.filter(r => r.sent);
    const out = {
      ...base,
      action,
      quantity: done.reduce((n, r) => n + r.quantity, 0),
      bracket: cfg.bracket,
      scaleOut: results.length,
      legs: results,
      // The first leg's id, so a callback about it finds this row. The others
      // are on the legs, and reconciliation reads both.
      orderId: (done[0] || {}).orderId || null,
      fillPrice: (done[0] || {}).fillPrice || null,
      status: (done[0] || {}).status || null,
      sent: done.length > 0,
      partial: done.length > 0 && done.length < results.length,
      unplaceable: (plan.unplaceable || []).length || undefined,
      reduced: fit.quantity !== fit.asked ? fit.reason : null,
      error: done.length === results.length ? null
        : `only ${done.length} of ${plan.orders.length} legs went in — `
          + `${(results.find(r => !r.sent) || {}).message || 'refused'}`,
    };
    record(out);
    return out;
  }

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
  let qty = planned.quantity;
  let res = null;

  for (let i = 0; i < 3 && qty >= 1; i += 1) {
    const body = { ...planned, quantity: qty };
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

// ── closing what was opened ────────────────────────────────────────────────

/**
 * Which symbols this box has an open position in, by its own reckoning.
 *
 * From the ledger: everything it sent today, minus everything it has already
 * closed today. It cannot see a position closed by its own stop or target, or
 * one closed by hand — so this OVER-reports, deliberately. Sending `close` for
 * a symbol that is already flat is a no-op at the broker; missing one that is
 * still open is an overnight position in an account that may not hold one.
 */
function openSymbols(date) {
  const rows = orders(date);
  const opened = [];
  const closed = new Set();
  for (const o of rows) {
    if (o.kind === 'callback') continue;
    if (o.kind === 'flatten') { if (o.sent) closed.add(o.symbol); continue; }
    if (o.sent && o.symbol && !opened.includes(o.symbol)) opened.push(o.symbol);
  }
  return opened.filter(sym => !closed.has(sym));
}

/**
 * Close a whole position. `close` takes no quantity — see the docs.
 *
 * The whole symbol, not a leg: at the cutoff what matters is being flat, and
 * closing leg by leg would leave a resting target able to fill against a
 * position that no longer exists.
 */
async function closePosition(symbol, date, cfg = settings()) {
  const base = { at: Date.now(), date, symbol, kind: 'flatten', action: 'close',
                 source: 'end of session' };
  if (!cfg.armed || !cfg.webhookUrl) {
    const out = { ...base, sent: false, skipped: 'not armed' };
    record(out); return out;
  }
  const body = { symbol: String(symbol).toUpperCase(), action: 'close' };
  let res;
  try {
    res = await post(cfg.webhookUrl, body);
  } catch (err) {
    // Not retried, for the same reason an entry is not: it may have arrived.
    const out = { ...base, sent: false,
      error: `could not reach SignalStack: ${err.message} — CHECK THE BROKER, `
        + 'this position may still be open' };
    record(out); return out;
  }
  const out = { ...base, sent: res.ok, status: res.status, httpStatus: res.httpStatus,
                orderId: res.orderId, message: res.message,
                error: res.ok ? null : `${res.status || res.httpStatus}: ${res.message || 'refused'}` };
  record(out);
  return out;
}

/** Close everything opened today. Returns one result per symbol. */
async function flattenAll(date, cfg = settings()) {
  const symbols = openSymbols(date);
  const out = [];
  for (const sym of symbols) out.push(await closePosition(sym, date, cfg));
  return out;
}

/**
 * Send a one-share test, to the test hook when there is one.
 *
 * The only way to find out that a URL is wrong, an account is disconnected or a
 * symbol is unsupported is to send something. Doing that for the first time at
 * 10:00:02 with a real position is not a plan.
 */
async function test({ symbol = 'AAPL', useTestHook = true, destination = null } = {}) {
  /*
   * One share, at ONE named account.
   *
   * The whole point of this button is to find out that a URL is wrong, an
   * account is disconnected or a symbol is unsupported — before 09:36. With
   * two accounts that has to be asked of each of them separately, and a test
   * that silently only ever checked the first would leave the second one
   * untested while looking like it had passed.
   */
  const cfg = destination ? destinationCfg(destination) : (route([]).cfgs[0] || settings());
  if (!cfg) throw new Error(`no broker called ${destination}`);
  const url = (useTestHook && cfg.testWebhookUrl) || cfg.webhookUrl;
  if (!url) throw new Error('no webhook URL configured');
  const shape = (DIALECTS[cfg.dialect] || DIALECTS.ttp).body;
  const body = shape({
    symbol: String(symbol).toUpperCase(), action: 'buy',
    quantity: 1, quantity_type: 'fixed',
  });
  const res = await post(url, body);
  const out = {
    at: Date.now(), date: null, symbol: body.symbol, quantity: 1, action: 'buy',
    source: 'manual test', hook: useTestHook && cfg.testWebhookUrl ? 'test' : 'live',
    destination: cfg.destinationId || null, broker: cfg.destinationName || null,
    sent: res.ok, status: res.status, httpStatus: res.httpStatus,
    orderId: res.orderId, fillPrice: res.fillPrice, message: res.message,
  };
  record(out);
  return { ...out, requestBody: body };
}

// ── what happens to the order afterwards ───────────────────────────────────

/*
 * SignalStack can call a URL when an order is PROCESSED, and that is the half
 * the reply to the POST cannot give.
 *
 * The immediate reply says what was known in that instant: usually 'accepted',
 * sometimes 'filled'. What happened next — filled at a different price, partly
 * filled, rejected by the broker a second later, cancelled — arrives here or
 * nowhere. Without it the ledger records intentions and calls them outcomes.
 *
 * THE URL IS THE CREDENTIAL. SignalStack sends a POST to a plain URL with no
 * key of its own, so the only thing standing between this endpoint and anyone
 * on the internet is that the URL is unguessable. Hence a random token in the
 * path, generated once, kept in the same gitignored file as the hook.
 *
 * THE PAYLOAD SHAPE IS NOT PINNED. The documented ORDER response is
 * {id, status, price}; the notification's own body is not documented in what we
 * have. So the fields are read by the several names they plausibly carry, the
 * RAW body is always stored, and an unrecognised shape is recorded rather than
 * dropped — an unread callback must never look like an order that went quiet.
 */
function callbackToken() {
  const s = read();
  if (s.callbackToken) return s.callbackToken;
  const token = require('crypto').randomBytes(24).toString('base64url');
  write({ ...s, callbackToken: token, updatedAt: Date.now() });
  return token;
}

/** The URL to paste into SignalStack's "Call webhook" box. */
function callbackUrl(origin) {
  return `${String(origin || '').replace(/\/$/, '')}/api/broker/callback/${callbackToken()}`;
}

/** Constant-time, so a wrong token cannot be found one character at a time. */
function tokenMatches(given) {
  const crypto = require('crypto');
  const a = Buffer.from(String(given || ''));
  const b = Buffer.from(callbackToken());
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const pick = (obj, names) => {
  for (const n of names) {
    if (obj && obj[n] !== undefined && obj[n] !== null && obj[n] !== '') return obj[n];
  }
  return null;
};

/**
 * Record what SignalStack says became of an order.
 *
 * Appended rather than merged into the original line: the ledger is append-only
 * on purpose, so what was believed at 10:00:03 stays readable next to what
 * turned out to be true at 10:00:09. Rewriting history is how the record stops
 * being evidence.
 *
 * Returns what it made of it, including `matched: false` when the id belongs to
 * no order this side placed — which is a real event worth seeing rather than an
 * error worth hiding, since orders can be placed elsewhere on the same account.
 */
function receiveCallback(payload) {
  const p = (payload && typeof payload === 'object') ? payload : {};
  const orderId = pick(p, ['id', 'order_id', 'orderId', 'client_id', 'clientId']);
  const status = pick(p, ['status', 'order_status', 'state']);
  const priceRaw = pick(p, ['price', 'fill_price', 'filled_avg_price', 'average_price']);
  const price = Number.isFinite(Number(priceRaw)) ? Number(priceRaw) : null;

  const mine = orderId
    ? orders().find(o => o.orderId && String(o.orderId) === String(orderId))
    : null;

  const entry = {
    at: Date.now(),
    kind: 'callback',
    date: mine ? mine.date : null,
    orderId: orderId ? String(orderId) : null,
    symbol: pick(p, ['symbol', 'ticker']) || (mine ? mine.symbol : null),
    status: status ? String(status) : null,
    statusDescription: pick(p, ['status_description', 'statusDescription']),
    message: pick(p, ['message', 'error']),
    fillPrice: price,
    quantity: Number(pick(p, ['quantity', 'qty', 'filled_qty'])) || null,
    matched: !!mine,
    // Always kept whole. The shape is not documented, so the only safe reading
    // of a field this does not know about is "store it and look later".
    raw: p,
  };
  record(entry);
  return entry;
}

/*
 * Which of it is bad news.
 *
 * A processed order that filled is a confirmation and does not need to buzz a
 * phone — the alert already did that. A rejection, a cancellation or an error
 * arriving AFTER the alert said the order went in is the case this exists for:
 * it is the only thing that can turn a position you believe you hold into one
 * you do not.
 */
const BAD_STATUS = /reject|cancel|error|fail|expired/i;

function callbackIsBadNews(entry) {
  if (!entry) return false;
  return BAD_STATUS.test(`${entry.status || ''} ${entry.message || ''}`);
}

/** Orders with whatever the callbacks later said about them. */
function reconciled(date = null) {
  // Read whole, then split: a callback can arrive after midnight ET for an
  // order placed before it, and filtering by date first would orphan it.
  const all = orders();
  const placed = all.filter(o => o.kind !== 'callback' && (!date || o.date === date));
  const backs = all.filter(o => o.kind === 'callback');
  return placed.map(o => {
    const later = backs
      .filter(c => c.orderId && o.orderId && c.orderId === String(o.orderId))
      .sort((a, b) => (a.at || 0) - (b.at || 0));
    const last = later[later.length - 1] || null;
    return {
      ...o,
      // The final word when there is one, and visibly the immediate reply when
      // there is not — "accepted, never heard from again" is information.
      finalStatus: last ? last.status : null,
      finalPrice: last && last.fillPrice != null ? last.fillPrice : null,
      confirmed: !!last,
      callbacks: later.length,
    };
  });
}

module.exports = {
  FILE, LEDGER, HOOK_RE,
  settings, publicSettings, save, mask,
  // Where orders can go, and one of them as a cfg the order path already takes.
  destinations, destinationCfg, route, DIALECTS, LEGACY_ID,
  orders, committed, remaining, tradesToday, fitQuantity, actionFor, splitLegs,
  validateBody, tick, stopTick,
  planOrder, previewOrder, placeOrder, test,
  openSymbols, closePosition, flattenAll,
  callbackToken, callbackUrl, tokenMatches, receiveCallback, callbackIsBadNews,
  reconciled,
};
