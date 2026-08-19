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

/** What an account may do. Ordered least to most dangerous. */
const MODES = ['alert', 'manual', 'auto'];

/** The id used for a hook configured before destinations existed. */
const LEGACY_ID = 'ttp';

/*
 * The smallest reward, as a multiple of the risk, that is allowed out of the
 * door. See the note in validateBody: this is a floor on arithmetic that has
 * plainly gone wrong — a target a tenth of the stop distance away — not an
 * opinion about what a good target is. Every strategy here aims at 1R or more.
 */
const MIN_TARGET_R = 0.1;

/*
 * The smallest position worth taking, in shares.
 *
 * Three, because that is the fewest that can be split three ways — the widest
 * shape anything here runs. Below it an account is not taking a smaller version
 * of the trade, it is taking a different one with fewer ways out, and the
 * per-order fee stops being rounding.
 *
 * A DEFAULT, not a constant: an account can set its own `minShares`, and 1
 * switches it off for a desk that really does want single-share fills.
 */
const MIN_SHARES = 3;

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
      // The smallest position this account will take. Unset means the desk default.
      minShares: num(d.minShares),
      /*
       * THIS ACCOUNT'S CAPITAL, as a MULTIPLE of the standard account.
       *
       * The standard account in data/risk.json is a reference and nothing
       * more — no order is ever placed against it. Real accounts are described
       * relative to it: "twice the standard", "half of it". That is how the
       * relationship is actually held in mind, and it means changing the
       * reference moves every account with it instead of leaving five numbers
       * to be re-typed one at a time.
       *
       * `scale` multiplies the standard's account size AND its risk per trade,
       * so the percentage risked is identical across accounts of different
       * sizes — which is the property that makes two accounts one strategy
       * rather than two.
       *
       * The absolute fields override the scaled figure when an account is not
       * a clean multiple of anything. Absent everywhere means the standard's.
       */
      /*
       * WHAT FRACTION OF THE STANDARD ACCOUNT THIS ONE IS.
       *
       * A $5,000 account against a $100,000 standard is 0.05. That single
       * number is the whole of this account's money management: the signal is
       * sized once against the standard, and every account takes its own
       * fraction of that share count. `scale` is the old name, read so a
       * config written before this still means what it meant.
       */
      ratio: num(d.ratio) || num(d.scale),
      accountSize: num(d.accountSize),
      riskPerTrade: num(d.riskPerTrade),
      maxPositionPct: num(d.maxPositionPct),
      /*
       * WHAT THIS ACCOUNT IS ALLOWED TO DO — one switch, on the account.
       *
       *   alert   nothing is ever sent here; the setup still alerts
       *   manual  it appears in the send picker, and goes only when tapped
       *   auto    a setup in its list places an order by itself at 09:36
       *
       * This used to be `autoTrade` on the SETUP, which was the wrong object
       * to hang it on: the same strategy can be one you watch by hand in the
       * prop account and let run in the paper account, and a flag on the
       * strategy cannot say that. Nothing about money lives on a setup now.
       */
      mode: ['alert', 'manual', 'auto'].includes(d.mode) ? d.mode : 'alert',
      /*
       * WHICH SETUPS RUN HERE. The account owns the list, in one direction, so
       * there is one place to look and one place to change it.
       */
      setups: Array.isArray(d.setups) ? d.setups.map(String) : [],
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
    minShares: num(s.minShares),
    // Nothing of its own: the single account IS the standard, which is what
    // data/risk.json has always described.
    ratio: null,
    accountSize: null,
    riskPerTrade: null,
    maxPositionPct: null,
    /*
     * MANUAL, never auto, and never less than it had.
     *
     * A config written before modes existed placed orders when two things were
     * true: the box was armed and a setup carried autoTrade. That second flag
     * is gone, so migrating this to 'auto' would hand every setup a permission
     * only some of them had. 'manual' keeps the hook usable — it is in the send
     * picker from the first minute — and stops anything firing by itself until
     * an account says so on the Settings tab.
     *
     * The stopping is not silent: a setup an account claims but does not run on
     * auto says exactly that on the alert.
     */
    mode: 'manual',
    setups: [],
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
    // This account's floor, or the desk's when it has none of its own.
    minShares: d.minShares != null ? d.minShares : base.minShares,
    // Carried through so risk.scaleTo() can take this account's fraction.
    ratio: d.ratio,
    accountSize: d.accountSize,
    riskPerTrade: d.riskPerTrade,
    maxPositionPct: d.maxPositionPct,
    mode: d.mode,
    setups: d.setups,
    enabled: base.enabled && d.enabled,
  };
}

/*
 * WHICH ACCOUNTS RUN THIS SETUP, and in which mode.
 *
 * One direction only. An account lists the setups it runs and says what it is
 * allowed to do with them; a setup knows nothing about brokers. The reverse —
 * a setup naming its brokers while the account named its capital — meant two
 * places to look for one decision, and they could disagree.
 *
 *   mode 'auto'    a fire places an order here by itself
 *   mode 'manual'  it appears in the send picker and waits to be tapped
 *   mode 'alert'   nothing is ever sent here
 *
 * `wanted` filters by mode. Called with none, every account that runs the
 * setup comes back whatever its mode, which is what a picker wants to list.
 */
function accountsFor(setupId, wanted = null, s = read()) {
  const modes = wanted ? [].concat(wanted) : ['alert', 'manual', 'auto'];
  return destinations(s)
    .filter(d => d.enabled && d.webhookUrl)
    .filter(d => modes.includes(d.mode))
    .filter(d => !setupId || d.setups.includes(String(setupId)))
    .map(d => destinationCfg(d.id, s));
}

/*
 * The accounts a fire should be ordered into, or the reason there are none.
 *
 * A reason rather than an empty list, because a setup that quietly stopped
 * trading looks exactly like a setup having a quiet week — and the reason is
 * always one of a small number of fixable things, so it is worth naming.
 */
function autoRoute(setupId, s = read()) {
  const cfgs = accountsFor(setupId, 'auto', s);
  if (cfgs.length) return { cfgs, error: null };
  const all = destinations(s);
  if (!all.length) return { cfgs: [], error: 'no broker account is configured' };
  const live = all.filter(d => d.enabled && d.webhookUrl);
  if (!live.length) {
    return { cfgs: [], error: 'every broker account is switched off or has no hook' };
  }
  const listed = live.filter(d => d.setups.includes(String(setupId)));
  if (!listed.length) {
    return { cfgs: [], error: 'no account runs this setup — add it to one on the '
      + 'Settings tab' };
  }
  return { cfgs: [], error: `${listed.map(d => `${d.name} (${d.mode} only)`).join(', ')}`
    + ' — no account has it on full auto' };
}

/*
 * One named account as a cfg, for a hand-sent order.
 *
 * Deliberately does NOT check that the account runs this setup: the picker
 * offers every account, because "send this one somewhere it does not normally
 * go" is a decision a person is allowed to make with their thumb on the
 * button. It does check the mode, because an alert-only account said it never
 * wants orders and that is not a per-tap decision.
 */
function manualCfg(id, s = read()) {
  const d = destinations(s).find(x => x.id === id);
  if (!d) return { cfg: null, error: `no account called ${id}` };
  if (!d.enabled || !d.webhookUrl) {
    return { cfg: null, error: `${d.name} is switched off or has no hook` };
  }
  if (d.mode === 'alert') {
    return { cfg: null, error: `${d.name} is set to alert only — change its mode `
      + 'on the Settings tab if you want to send orders there' };
  }
  return { cfg: destinationCfg(id, s), error: null };
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
    /*
     * The desk-wide floor on a position, in shares. See MIN_SHARES: under it an
     * account cannot hold the strategy's shape, so it sits the trade out rather
     * than placing a different one.
     */
    minShares: num(s.minShares) == null ? MIN_SHARES : num(s.minShares),
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

  for (const key of ['buyingPower', 'maxOrderValue', 'maxTradesPerDay', 'minShares']) {
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
      const was = stored.get(id);
      if (!DIALECTS[d.dialect]) {
        throw new Error(`destination "${id}": unknown broker type "${d.dialect}" — `
          + `one of ${Object.keys(DIALECTS).join(', ')}`);
      }
      const out = { id, dialect: d.dialect, name: String(d.name || '').trim() || id,
                    enabled: d.enabled !== false };
      /*
       * The mode is refused rather than defaulted when it is not one of the
       * three. A typo silently becoming 'auto' would be an account placing
       * orders nobody asked it to; silently becoming 'alert' would be an
       * account that looks armed and sends nothing. Neither is acceptable.
       */
      if (d.mode !== undefined) {
        if (!MODES.includes(d.mode)) {
          throw new Error(`account "${id}": mode must be one of ${MODES.join(', ')}`);
        }
        out.mode = d.mode;
      } else if (was) out.mode = was.mode;
      if (d.setups !== undefined) {
        out.setups = [...new Set((Array.isArray(d.setups) ? d.setups : [])
          .map(x => String(x).trim()).filter(Boolean))];
      } else if (was) out.setups = was.setups;
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
      const rawRatio = d.ratio !== undefined ? d.ratio : d.scale;
      if (rawRatio !== undefined && rawRatio !== '' && rawRatio !== null) {
        const n = Number(rawRatio);
        /*
         * Bounded on both sides. Above 10 is not a multiplier, it is a typo,
         * and it would be a ten-fold position before anything downstream
         * questioned it. Below 0.0001 every trade floors to zero shares, which
         * is an account configured to do nothing while looking configured.
         */
        if (!Number.isFinite(n) || n < 0.0001 || n > 10) {
          throw new Error(`account "${id}": size must be between 0.0001 and 10 `
            + 'times the standard account');
        }
        out.ratio = n;
      } else if (rawRatio === undefined && was && was.ratio) out.ratio = was.ratio;
      for (const key of ['buyingPower', 'maxOrderValue', 'maxTradesPerDay',
                         'minShares', 'accountSize', 'riskPerTrade', 'maxPositionPct']) {
        const v = d[key];
        if (v === '' || v === null || v === undefined) continue;
        const n = Number(v);
        if (!Number.isFinite(n) || n <= 0) {
          throw new Error(`destination "${id}": ${key} must be a positive number`);
        }
        out[key] = n;
      }
      // Caught here rather than at 09:36, where it would come back as a broker
      // rejection with no explanation attached.
      if (out.riskPerTrade && out.accountSize && out.riskPerTrade > out.accountSize) {
        throw new Error(`destination "${id}": risk per trade cannot exceed the account size`);
      }
      if (out.maxPositionPct && out.maxPositionPct > 100) {
        throw new Error(`destination "${id}": max position cannot be more than 100% of the account`);
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
        throw new Error('add a broker account with a webhook URL before arming');
      }
      const sending = live.filter(d => d.mode !== 'alert');
      if (!sending.length) {
        throw new Error('every account is set to alert only — arming would switch '
          + 'on a machine with nothing to switch on');
      }
      const broke = sending.filter(d => !d.buyingPower).map(d => d.name);
      if (broke.length) {
        throw new Error(`${broke.join(', ')} has no buying power set — either give `
          + 'it one or set it to alert only, or an order sent there will be refused');
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

/**
 * How many distinct NAMES this setup has taken today, across every account.
 *
 * The unit the per-setup cap is written in. A position held in two accounts is
 * one position — it is one idea, taken once, funded twice — and a three-leg
 * scale-out is one position too. Counting ledger rows instead made the cap
 * mean "rows", which is a number the person setting it has no way to predict:
 * it changes when an account is added and when a strategy grows a leg.
 *
 * Sent entries only, for the same reason as everywhere else: a refusal took no
 * position, and counting it would spend the day's allowance on a trade that
 * never happened.
 */
function namesToday(date, setupId) {
  const names = new Set();
  if (!setupId) return names;
  for (const o of orders(date)) {
    if (!o.sent || o.kind === 'callback' || o.kind === 'flatten') continue;
    if (o.setupId !== setupId || !o.symbol) continue;
    names.add(String(o.symbol).toUpperCase());
  }
  return names;
}

function positionsToday(date, setupId) { return namesToday(date, setupId).size; }

/**
 * Has this setup already put THIS NAME on today, in this account?
 *
 * The one question that separates a second signal from a repeat of the first.
 * Read from the ledger rather than from the alert feed or from memory: the
 * ledger line and the wire request are written by the same call, so it is the
 * only answer that survives a crash between them, and a restart.
 *
 * Sent orders only — a refusal opened nothing, and treating it as a position
 * would silently retire the name for the rest of the day. Entries only:
 * callbacks are the broker talking back, and a flatten is the exit.
 */
function sentAlready(date, setupId, symbol, destination = null) {
  if (!setupId || !symbol) return false;
  const want = String(symbol).toUpperCase();
  return orders(date).some(o => o.sent
    && o.kind !== 'callback' && o.kind !== 'flatten'
    && o.setupId === setupId
    && String(o.symbol || '').toUpperCase() === want
    && (!destination || (o.destination || LEGACY_ID) === destination));
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
      /*
       * A TARGET TOO CLOSE TO THE ENTRY.
       *
       * The rule above catches a target on the wrong side. It does not catch a
       * target one cent away on the RIGHT side, and that is what an
       * indicator-anchored take-profit produces when price has already run to
       * the line it is anchored to. A real one:
       *
       *   NE · buy 119 · stop 44.90 · target 45.21
       *   -> From Alpaca: take_profit.limit_price must be >= base_price + 0.01
       *
       * Rejected by the broker, hours later, by email. Two things are wrong
       * with it and only one is Alpaca's rule. The cent of clearance is theirs;
       * the real problem is a trade risking thirty cents to make one, which is
       * not the strategy that was tested — it is the strategy after the move
       * already happened.
       *
       * So: a cent of clearance for the broker, and a floor relative to the
       * STOP DISTANCE for the trade. MIN_TARGET_R is a tenth of the risk, which
       * no strategy here intends and which cannot pay a commission. It is a
       * floor on obvious breakage, not a view on what a good target is.
       */
      const gap = Math.abs(body.take_profit_price - e);
      if (gap < 0.02) {
        errors.push(`the target ${body.take_profit_price} is ${gap.toFixed(4)} from the `
          + `entry ${e} — the broker needs at least a cent of clearance and the `
          + 'price will have moved past it before the order lands');
      } else if (isNum(body.stop_loss_price)) {
        const risk = Math.abs(e - body.stop_loss_price);
        if (risk > 0 && gap < risk * MIN_TARGET_R) {
          errors.push(`the target ${body.take_profit_price} is ${(gap / risk).toFixed(2)}R `
            + `from the entry ${e} (stop ${body.stop_loss_price}) — below the `
            + `${MIN_TARGET_R}R floor. Risking ${risk.toFixed(2)} to make `
            + `${gap.toFixed(2)} is not the trade that was tested`);
        }
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
  /*
   * ONE ENTRY PER SETUP, PER NAME, PER DAY — held on the LEDGER.
   *
   * There was already a latch for this, in the runner: a watch setup drops any
   * name it has already alerted on today. It reads the alert feed, so it is
   * only as good as the alert getting written — and the alert is written AFTER
   * the order is sent. Anything that threw in between sent an order and left no
   * latch, so the next bar sent another, and the bar after that another. That
   * is not hypothetical: describePick() threw on a strategy with no take-profit
   * and the same name went out again every minute until it was noticed, at the
   * per-order fee each time.
   *
   * So the guard belongs where the ORDER is, not where the alert is. The ledger
   * line is written by the same call that sends, which makes it the only record
   * that cannot disagree with what the broker got.
   *
   * Per DESTINATION, because two accounts trading one signal is two orders on
   * purpose — the account cap above is scoped the same way for the same reason.
   *
   * A scale-out is unaffected: its legs go out inside ONE placeOrder call,
   * which passes here once and writes one ledger line.
   *
   * Only entries. `close`/flatten carry no setupId and are recorded as
   * kind:'flatten', so an exit is never mistaken for a repeat of the entry it
   * is closing.
   */
  if (setupId && sentAlready(date, setupId, symbol, cfg.destinationId || null)) {
    return { blocked: 'repeat',
      reason: `${String(symbol).toUpperCase()} was already traded by this setup today` };
  }

  /*
   * THE SETUP'S CAP COUNTS POSITIONS, NOT LEDGER LINES.
   *
   * "How many trades is this one idea allowed today" is a question about
   * POSITIONS. It was answered by counting rows in the ledger, and a row is
   * written per ACCOUNT — so with two accounts every signal spent two of the
   * allowance and a cap of 2 meant one trade.
   *
   * It cost a real signal. OR + VWAP took CBRS at 09:36 into both accounts,
   * which used the whole cap, and BRUN forty seconds later was refused with
   * "this setup's limit of 2 order(s) a day is already used" — a message that
   * is true about rows and false about trades, and sends you to the wrong
   * setting to fix it.
   *
   * The scale-out half of this was already right: three legs go out inside one
   * placeOrder call and write one row. The account half was not. Counting
   * DISTINCT SYMBOLS makes the cap mean the same thing however many accounts
   * are wired up and however many ways out the strategy has.
   *
   * After the repeat guard, deliberately: a second signal on a name this setup
   * already holds is a repeat, and saying "your daily limit is used" about it
   * would point at the wrong setting again.
   */
  if (maxPerDay && setupId) {
    const held = namesToday(date, setupId);
    /*
     * A name already taken never counts against the cap a second time.
     *
     * Without this the fix reproduced the bug it was written for, one step
     * later: CBRS goes into the first account and is counted, BRUN goes into
     * the first account and is counted, and then BRUN'S SECOND ACCOUNT is
     * refused for being the third position — when it is the second half of the
     * second position. The desk would quietly trade every signal in one account
     * and the last one in neither.
     *
     * Reaching here with the name already held can only be the other account of
     * a signal in flight: a repeat in the SAME account was stopped by the guard
     * above, which runs first precisely so this test means what it says.
     */
    if (!held.has(String(symbol).toUpperCase()) && held.size >= maxPerDay) {
      return { blocked: 'setup-cap',
        reason: `this setup's limit of ${maxPerDay} position(s) a day is already used` };
    }
  }

  const fit = fitQuantity({ quantity, price, date, cfg });
  if (fit.quantity < 1) {
    return { blocked: 'size', reason: fit.reason || 'nothing fits', fit };
  }

  /*
   * A FLOOR ON THE POSITION — under it, this account sits the trade out.
   *
   * A position of one or two shares is not a small version of the trade. It is
   * a different trade:
   *
   *   · it cannot scale out. Splitting 1 share across three legs gives one leg
   *     everything and drops the other two, so the account runs a strategy with
   *     one way out instead of three — and nothing about it looks wrong
   *   · the per-order fee is a fixed amount, so on one share it is most of the
   *     move the strategy is trying to catch
   *   · a whole-share floor turns 1.4 into 1, which is a 29% sizing error the
   *     risk settings never asked for
   *
   * TTP5k at ratio 0.05 took ONE share of a $238 stock and placed a
   * single-exit version of a two-leg strategy. That is what this stops.
   *
   * Per account, because the sizing is per account: the same signal can be
   * ninety shares in one and one in the other, and only the second should sit
   * it out. Checked AFTER fitQuantity, so it counts what would really be sent
   * rather than what was asked for — a 90-share order cut to 2 by buying power
   * is exactly the case this exists for.
   */
  const floor = cfg.minShares == null ? MIN_SHARES : cfg.minShares;
  if (floor > 1 && fit.quantity < floor) {
    return { blocked: 'min-size', fit,
      reason: `${fit.quantity} share(s) is under this account's minimum of ${floor}`
        + ' — too small to hold the strategy\'s shape, so nothing was sent' };
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
  /*
   * SPLIT WHENEVER THE SPLIT PRODUCED MORE THAN ONE ORDER.
   *
   * This asked `plan.legs.length > 1`, which is a guess about the shape rather
   * than a reading of it, and it was wrong for the commonest shape of all: one
   * target plus a runner. `OR + VWAP 09:35` takes half off at 2R and lets half
   * ride the stop — one leg, one runner — so the condition was false and the
   * WHOLE position went out as a single bracket with the 2R target on it. The
   * runner was silently removed from the trade: a strategy tested as "half at
   * 2R, half to the close" was placed as "all at 2R", which is a different
   * strategy with a different expectancy.
   *
   * `splitLegs` already knew — it returns the runner as its own part. Reading
   * its answer instead of re-deriving one from the leg count means every shape
   * works the same way, including shapes nobody has built yet.
   *
   * The same reasoning covers a SINGLE order: when the strategy declared an
   * exit plan, that plan is the authority for every order it produces, not
   * just for the ones that happen to number more than one. A strategy that is
   * 100% runner — a stop and no target at all — has one part, and reading the
   * `target` argument instead of the part put a 2R target on a position whose
   * whole design is that it does not have one.
   */
  const orders = (split.parts.length > 1
                  || (plan && Array.isArray(plan.legs) && split.parts.length))
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
                            decisionBar = null, cfg = settings() }) {
  const base = {
    at: Date.now(), date, symbol, signal, price, stop, target, source,
    /*
     * WHICH BAR DECIDED IT — '09:35', not the second the POST left.
     *
     * Anything that manages this position afterwards has to line up with the
     * simulation's entry bar, and the send time is the wrong anchor: it lands
     * a minute or so later, which is a whole bar on a 1m strategy. One bar out
     * seeds a ratchet from the wrong level and can skip the exact bar a cross
     * fired on.
     */
    decisionBar,
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

  // Carried from the borrow check below onto every row this call writes, so a
  // check that could not run is visible on the alert rather than only in a log.
  let unchecked = null;
  let hardToBorrow = false;

  /*
   * ASK ALPACA WHETHER IT WILL SHORT THIS, BEFORE SENDING.
   *
   * Alpaca accepts the POST and refuses hours later by email —
   *
   *     From Alpaca: asset "STKH" cannot be sold short
   *
   * — by which time the alert says sent, no position exists, and the only
   * record of the failure is in an inbox. Most of what these screeners find is
   * a small cap with no borrow, so for shorts this is the common case.
   *
   * Alpaca only. Trade The Pool is a prop desk that shorts what it lists, and
   * asking Alpaca about an account it does not hold would answer the wrong
   * question. An unanswerable check never blocks — see checkShortable.
   */
  if (action === 'sell' && cfg.dialect === 'alpaca') {
    const borrow = await require('../alpaca/client').checkShortable(symbol);
    if (!borrow.ok) {
      const out = { ...base, quantity: 0, sent: false, skipped: borrow.reason };
      record(out); return out;
    }
    /*
     * A CHECK THAT DID NOT RUN IS CARRIED ONTO THE ORDER, not just logged.
     *
     * It still sends — blocking every short because Alpaca did not answer is a
     * worse failure than the rejection this prevents. But a protective check
     * that silently did not happen looks exactly like one that passed, and the
     * only trace was a console line in a PM2 log nobody reads. It took a live
     * rejection and an afternoon to work out which of the two had occurred.
     *
     * On the row, so the alert and the ledger both say it.
     */
    if (!borrow.checked) {
      unchecked = borrow.reason || 'no answer from Alpaca';
      console.warn(`[Broker] could not check whether ${symbol} is shortable `
        + `(${borrow.reason}) — sending anyway, the broker decides`);
    } else if (borrow.easyToBorrow === false) {
      hardToBorrow = true;
      console.warn(`[Broker] ${symbol} is shortable but NOT easy to borrow — `
        + 'the fill may need a locate');
    }
  }

  /*
   * THE INTENT, WRITTEN BEFORE ANYTHING GOES ON THE WIRE.
   *
   * Until now the ledger row was written AFTER the whole call finished, which
   * left one gap that nothing could close: between the first POST and that
   * write, an order can exist at the broker with no record of it anywhere on
   * this side. A crash there — a restart, a reboot, an OOM at 09:35 — and the
   * position is real and invisible.
   *
   * That is not a small gap, because the ledger is also what the repeat guard
   * reads. `sentAlready` asks the ledger whether this setup has already taken
   * this name, so a crash mid-send does not merely lose a record: it re-arms
   * the setup for a name it may already hold, and the next pass takes it again.
   *
   * The intent row is inert to everything that counts — it carries no `sent`,
   * so committed(), tradesToday(), namesToday(), sentAlready(), openSymbols()
   * and setupBySymbol() all skip it exactly as they skip a refusal. What it
   * gives is `orphanIntents()`: an intent with no outcome behind it is a call
   * that started and never finished, which is the one state worth waking
   * somebody for.
   */
  const intentId = `i${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  base.intentId = intentId;
  record({
    ...base,
    kind: 'intent',
    action,
    bracket: cfg.bracket,
    // What was ABOUT to be sent, leg by leg. After a crash this is the only
    // description of the position that may now exist at the broker.
    legs: (plan.orders && plan.orders.length ? plan.orders : [planned])
      .filter(Boolean)
      .map(b => ({ quantity: b.quantity, target: b.take_profit_price || null,
                   stop: b.stop_loss_price || null })),
  });

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
      borrowUnchecked: unchecked,
      hardToBorrow: hardToBorrow || undefined,
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
    borrowUnchecked: unchecked,
    hardToBorrow: hardToBorrow || undefined,
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
 * Which setup put each name on, on a given day.
 *
 * WHY IT EXISTS. The journal tags every trade with a setup by hand, and that
 * tag is what per-setup expectancy is computed from — so a day of untagged
 * trades is a day that cannot be measured, and tagging from memory a week later
 * is how a trade ends up filed under the wrong strategy. The desk already knows:
 * it chose the setup, sized it, and wrote the row.
 *
 * ONLY WHAT WENT OUT. Entries, sent, not flattens and not the broker talking
 * back. A refusal placed nothing and must not tag anything.
 *
 * AMBIGUITY IS REPORTED, NEVER RESOLVED. If two setups both took the same name
 * on the same day, no answer here is better than a coin toss: a wrong tag is
 * worse than no tag, because it is invisible and it moves a losing trade into
 * another strategy's record. Both ids come back with `ambiguous` set, and the
 * caller is expected to leave the field alone and say why.
 */
function setupBySymbol(date) {
  const out = {};
  for (const o of orders(date)) {
    if (!o.sent || o.kind === 'flatten' || o.kind === 'callback') continue;
    if (!o.symbol || !o.setupId) continue;
    const sym = String(o.symbol).toUpperCase();
    const was = out[sym];
    if (!was) {
      out[sym] = {
        symbol: sym,
        setupId: o.setupId,
        setupIds: [o.setupId],
        side: String(o.signal || '').toUpperCase() === 'SHORT' ? 'short' : 'long',
        // The EARLIEST send is the entry. A later row for the same name is
        // another account's half of the same signal, or a second leg.
        at: o.at || null,
        ambiguous: false,
      };
      continue;
    }
    if (!was.setupIds.includes(o.setupId)) {
      was.setupIds.push(o.setupId);
      was.ambiguous = true;
      was.setupId = null;                 // no guess is better than a wrong one
    }
    if ((o.at || 0) < (was.at || Infinity)) was.at = o.at;
  }
  return out;
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
  // Named, or the only account there is. Never a silent first-of-many: a test
  // that quietly only ever checked one account leaves the other untested while
  // reading as a pass.
  const live = destinations().filter(d => d.enabled && d.webhookUrl);
  const cfg = destination ? destinationCfg(destination)
    : (live.length === 1 ? destinationCfg(live[0].id) : null);
  if (!cfg) {
    throw new Error(destination ? `no broker called ${destination}`
      : (live.length ? 'say which account to test — there are '
          + `${live.length} (${live.map(d => d.name).join(', ')})`
        : 'no broker account is configured'));
  }
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

/**
 * The difference between the price a trade was priced at and the one it got.
 *
 * `null` when either side is missing — a number invented from a missing fill
 * would be indistinguishable from a perfect one, which is the worst possible
 * answer to "how much is this costing me".
 */
function slipOf(o, callback) {
  const paid = callback && callback.fillPrice != null ? Number(callback.fillPrice) : null;
  const want = o && o.price != null ? Number(o.price) : null;
  if (!Number.isFinite(paid) || !Number.isFinite(want) || want === 0) {
    return { slip: null, slipPct: null };
  }
  // Positive = worse than the decision assumed, whichever way the trade faces.
  const raw = paid - want;
  const signed = String(o.action || '').toLowerCase() === 'sell' ? -raw : raw;
  return {
    slip: Math.round(signed * 10000) / 10000,
    slipPct: Math.round((signed / want) * 1e6) / 1e4,
  };
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

/**
 * Calls that started and never finished.
 *
 * An intent is written before the first POST and the outcome after the last
 * one, both carrying the same id. A row that has the first and not the second
 * means the process died between them — and an order may exist at the broker
 * that nothing on this side knows about. It is also the state in which the
 * repeat guard is wrong, because it reads `sent` and there is no `sent` row.
 *
 * Almost always empty. When it is not, it is the most important thing in the
 * day and everything else can wait.
 */
function orphanIntents(date = null) {
  const rows = orders(date);
  const finished = new Set();
  for (const o of rows) {
    if (o.kind === 'intent' || !o.intentId) continue;
    finished.add(o.intentId);
  }
  return rows.filter(o => o.kind === 'intent' && !finished.has(o.intentId));
}

/** Orders with whatever the callbacks later said about them. */
function reconciled(date = null) {
  // Read whole, then split: a callback can arrive after midnight ET for an
  // order placed before it, and filtering by date first would orphan it.
  const all = orders();
  // Intents are not orders. Each one has an outcome row beside it carrying the
  // same id, and counting both would report every trade twice.
  const placed = all.filter(o => o.kind !== 'callback' && o.kind !== 'intent'
                                 && (!date || o.date === date));
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
      /*
       * WHAT THE DECISION ASSUMED versus WHAT IT GOT.
       *
       * Everything about a trade is derived from `price` — the close of the bar
       * the strategy decided on. The order then goes to market a minute or so
       * later, so R, both targets and the share count are all measured from a
       * price that was never traded. qp's own docstring calls the fill model
       * this uses "optimistic by ~one spread"; the gap has simply never been
       * measured, and an unmeasured cost is not a small one, it is an unknown
       * one.
       *
       * SIGNED AGAINST THE POSITION, not against the number line: paying 5.42
       * for a long you priced at 5.39 is three cents WORSE, and selling a short
       * at 5.42 that you priced at 5.39 is three cents BETTER. An unsigned
       * difference would report those two identically.
       */
      ...slipOf(o, last),
    };
  });
}

module.exports = {
  FILE, LEDGER, HOOK_RE, MIN_SHARES,
  settings, publicSettings, save, mask,
  // Where orders can go, and one of them as a cfg the order path already takes.
  destinations, destinationCfg, accountsFor, autoRoute, manualCfg,
  DIALECTS, LEGACY_ID, MODES,
  orders, committed, remaining, tradesToday, sentAlready, positionsToday,
  fitQuantity, actionFor, splitLegs,
  validateBody, tick, stopTick,
  planOrder, previewOrder, placeOrder, test,
  openSymbols, setupBySymbol, closePosition, flattenAll, orphanIntents,
  slipOf,
  callbackToken, callbackUrl, tokenMatches, receiveCallback, callbackIsBadNews,
  reconciled,
};
