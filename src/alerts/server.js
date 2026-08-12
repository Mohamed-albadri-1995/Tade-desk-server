/*
 * The alerts service — its own process, its own port, like every other tool.
 *
 * It does NOT evaluate. The nine screeners do that on their own scans, because
 * they already hold the cards: price, the pre-market levels, the moving
 * averages, all re-quoted every five minutes. A tenth process re-fetching the
 * same data to compare the same numbers would be a second source of truth about
 * what "crossed" means, and the two would eventually disagree.
 *
 * So this owns the parts that are genuinely its own:
 *
 *   the rules      — written here, read by all nine
 *   the feed       — every tool's fires, merged
 *   the noise      — sound, a visible banner, a browser notification if the
 *                    origin allows one
 *
 * No database and no TOOL_ID. Everything it touches is a shared file beside the
 * databases, which is why it can run without being a screener.
 *
 *   ALERTS_PORT=3090 node src/alerts/server.js
 */

const express = require('express');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const app = express();

// The screener suite and the chart tool are on other ports, so anything they
// might read from here is cross-origin by construction. Read-only endpoints.
app.use((req, res, next) => {
  if (req.method === 'GET') res.set('Access-Control-Allow-Origin', '*');
  next();
});

app.use('/api/alerts', require('../routes/alerts'));

/*
 * The setups, so the page knows when a decision is due.
 *
 * It needs this for one reason that matters: a setup fires within seconds of a
 * fixed minute and the trade is entered at market immediately, so the page
 * polls every three seconds around that minute instead of every sixty. Without
 * knowing the time it would either poll fast all day or deliver a time-critical
 * alert up to a minute late.
 *
 * Served by asking qp rather than a tool, because this process has no database
 * and does not need one to read a list of strategies. It cannot RUN a setup —
 * that needs the owning tool's card list — so no run endpoints here.
 */
app.get('/api/setups', async (req, res) => {
  try {
    const catalog = require('../setups/catalog');
    const universe = require('../setups/universe');
    const list = await catalog.list();
    res.json({
      ok: true,
      // Empty is a real answer and a different one from an error: it means qp
      // has no strategy that both names its tools and has an entry window.
      setups: list.map(s => ({
        id: s.id, name: s.name, tools: s.tools,
        decisionTime: s.decisionTime, universeScanAt: s.universeScanAt || null,
        describe: s.describe, caution: s.caution, liveFeed: s.liveFeed || null,
        sides: s.sides, strategies: s.strategies, strategyIds: s.strategyIds,
        topN: (s.rank || {}).topN || 0,
        rankMetric: (s.rank || {}).metric || null,
        rankDirection: (s.rank || {}).direction || null,
        universe: universe.describe(s.universe),
        universeRules: (s.universe && s.universe.rules) || [],
        // Sent back so the editor reopens on what was saved. Without it the
        // control always read "all", and re-saving silently turned an OR
        // filter into an AND one — a different filter, quietly.
        universeLogic: (s.universe && s.universe.logic) || 'AND',
        enabled: s.enabled,
        // Whether THIS setup places orders — separate from the broker being
        // armed, which is permission for the box rather than for a strategy.
        autoTrade: s.autoTrade === true,
        maxTradesPerDay: s.maxTradesPerDay || null,
        riskPerTrade: s.riskPerTrade || null,
        maxPositionPct: s.maxPositionPct || null,
        // Whether it can produce a clean alert and a clean order at all.
        readiness: s.readiness || null,
        // Empty unless a long/short pair failed to become one setup.
        pairing: s.pairing || [],
      })),
      fields: Object.entries(universe.FIELDS).map(([k, v]) => ({ value: k, label: v.label, kind: v.kind })),
      operators: universe.OPERATORS,
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

/*
 * The parts the screener owns: the card-field filter and how many to take.
 *
 * Not the strategy, not the tools, not the time — those are the qp strategy's
 * and editing them here would put two copies out of step. This endpoint exists
 * precisely because bias, score and catalyst are things qp cannot see.
 */
app.post('/api/setups/:id/settings', express.json(), (req, res) => {
  try {
    const saved = require('../setups/prefs').saveSettings(req.params.id, req.body || {});
    res.json({ ok: true, id: req.params.id, settings: saved });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

// Switching one off is a shared file, so this process can do it even though it
// cannot run a setup — running needs the owning tool's card list.
app.post('/api/setups/:id/enabled', express.json(), async (req, res) => {
  try {
    const setup = await require('../setups/catalog').get(req.params.id);
    if (!setup) return res.status(404).json({ ok: false, error: 'No such setup' });
    const enabled = require('../setups/prefs').setEnabled(setup.id, req.body?.enabled);
    res.json({ ok: true, id: setup.id, enabled });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

/*
 * Every strategy in qp, assigned or not — the picker's list.
 *
 * A strategy becomes a setup by naming its tools, and until it does it appears
 * nowhere: not in the setups list, which is the point, and so not anywhere you
 * could assign it either. That left the one remaining step — "this strategy
 * should run on T2's cards" — as a trip to another tool on another port to type
 * a tool id into a text box, which is exactly the copying this was meant to end.
 *
 * So the list is served whole, with what each strategy still needs in order to
 * run, and the assignment happens where the alerts are read.
 */
app.get('/api/strategies', async (req, res) => {
  try {
    const catalog = require('../setups/catalog');
    const list = await require('../setups/qpClient').strategies();
    res.json({
      ok: true,
      strategies: list.map(s => {
        const at = catalog.hhmm((s.risk || {}).window_start);
        return {
          id: s.id,
          name: s.name,
          base: catalog.baseName(s.name),
          side: s.side || null,
          tools: Array.isArray(s.tools) ? s.tools : [],
          decisionTime: at,
          // Why it is not a setup yet, in the words the page can show. An
          // unassigned strategy and one with no entry window are different
          // problems with different fixes, and only one of them is fixable here.
          missing: [
            ...(Array.isArray(s.tools) && s.tools.length ? [] : ['tools']),
            ...(at ? [] : ['entry window']),
          ],
        };
      }),
    });
  } catch (err) {
    // Distinct from an empty list: qp being down is not the same answer as qp
    // holding no strategies, and the page must not offer to fix the wrong one.
    res.status(502).json({ ok: false, error: err.message });
  }
});

/*
 * Assign a strategy's tools — the one write this side makes to qp.
 *
 * Narrow on purpose. The rules, the window and the side stay the builder's;
 * this changes which screeners run it, which is the decision that belongs where
 * the cards are. qp validates the ids against the live tool list, so a typo is
 * refused rather than quietly producing a setup no tool ever runs.
 */
app.post('/api/strategies/:id/tools', express.json(), async (req, res) => {
  try {
    const tools = Array.isArray(req.body?.tools) ? req.body.tools : [];
    const saved = await require('../setups/qpClient').setTools(req.params.id, tools);
    res.json({ ok: true, id: req.params.id, tools: (saved && saved.tools) || [] });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

/*
 * The broker connection — SignalStack, to Trade The Pool.
 *
 * The URL is never returned. Anyone holding it can place orders in the account,
 * so the page gets a masked version, enough to tell two hooks apart and useless
 * to anyone reading over a shoulder.
 */
const broker = require('../broker/signalstack');

app.get('/api/broker', (req, res) => {
  const { toETDate } = require('../utils/time');
  const day = toETDate(Date.now());
  const cfg = broker.settings();
  res.json({
    ok: true,
    broker: broker.publicSettings(),
    // This side's own tally, labelled as an estimate everywhere it appears.
    committedToday: broker.committed(day),
    // What the box believes it still has open, so "will anything be left at the
    // bell" is answerable before the bell.
    openSymbols: broker.openSymbols(day),
    remaining: broker.remaining(day, cfg),
    // With whatever SignalStack later said became of each one, so "accepted,
    // never heard from again" is visible rather than read as "filled".
    orders: broker.reconciled(day).sort((a, b) => (b.at || 0) - (a.at || 0)),
    /*
     * The URL to paste into SignalStack's "Call webhook" box, built from the
     * address this page was actually loaded from — the box needs a public URL,
     * and the one in the browser is the only one this process can be sure
     * reaches it. Shown whole because it has to be copied; it is a credential,
     * so it is shown only over a secure origin.
     */
    callbackUrl: req.secure || req.get('x-forwarded-proto') === 'https'
      ? broker.callbackUrl(`https://${req.get('host')}`)
      : null,
  });
});

app.post('/api/broker', express.json(), (req, res) => {
  try {
    res.json({ ok: true, broker: broker.save(req.body || {}) });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

/*
 * The order that would actually be sent — the JSON, and why it is not what the
 * risk calculator said.
 *
 * The calculator answers "how many shares does my risk allow". That is not the
 * same number as the one that leaves this box: buying power already spent, the
 * per-order ceiling, the day's caps and whole-share flooring all sit between
 * them, and any of them can make it smaller or zero. Reading the first number
 * and believing it is the second is the mistake this exists to prevent.
 *
 * It calls the SAME function the live path calls, stopped one step short of the
 * network. A preview that recomputed any of it separately would eventually
 * recompute it wrongly — and being wrong here is worse than having no preview,
 * because a preview is believed.
 */
app.post('/api/broker/preview', express.json(), (req, res) => {
  try {
    const { toETDate } = require('../utils/time');
    const risk = require('../setups/risk');
    const b = req.body || {};
    const entry = Number(b.entry);
    const stop = Number(b.stop);
    if (!(entry > 0) || !(stop > 0)) {
      return res.status(400).json({ ok: false, error: 'entry and stop must be prices' });
    }
    const side = String(b.side || '').toUpperCase() === 'SHORT' ? 'SHORT' : 'LONG';
    const riskPerShare = Math.abs(entry - stop);

    // The share count comes from the same risk.sizeFor the setups use, so the
    // chain here is identical to the one a fire goes through.
    const size = risk.sizeFor({ entry, riskPerShare });
    const preview = broker.previewOrder({
      symbol: String(b.symbol || '').toUpperCase(),
      signal: side,
      quantity: size ? size.shares : 0,
      price: entry,
      stop,
      target: Number(b.target) > 0 ? Number(b.target) : null,
      date: toETDate(Date.now()),
      setupId: b.setupId || null,
    });
    res.json({ ok: true, side, entry, stop, riskPerShare, size, preview });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

/*
 * Place one by hand, through every guard the automatic path uses.
 *
 * For the trade the setups did not signal. It is not a shortcut around the
 * safeguards — it is the same planOrder, so the buying power, the caps, the
 * whole-share rule and the bracket all apply exactly as they would at 10:00.
 * Refused unless armed, because a manual order is still a real one.
 */
app.post('/api/broker/order', express.json(), async (req, res) => {
  try {
    const { toETDate } = require('../utils/time');
    const risk = require('../setups/risk');
    const b = req.body || {};
    const entry = Number(b.entry);
    const stop = Number(b.stop);
    const symbol = String(b.symbol || '').trim().toUpperCase();
    if (!symbol) return res.status(400).json({ ok: false, error: 'a symbol is required' });
    if (!(entry > 0) || !(stop > 0)) {
      return res.status(400).json({ ok: false, error: 'entry and stop must be prices' });
    }
    const side = String(b.side || '').toUpperCase() === 'SHORT' ? 'SHORT' : 'LONG';
    // The same check the calculator makes: a long stopping above its entry is
    // either the wrong stop or the wrong side, and either way not an order.
    if ((side === 'LONG') !== (stop < entry)) {
      return res.status(400).json({
        ok: false,
        error: `a ${side.toLowerCase()} cannot have its stop at ${stop} with the entry at ${entry}`,
      });
    }
    if (!broker.settings().armed) {
      return res.status(400).json({ ok: false, error: 'the broker is not armed' });
    }

    const size = risk.sizeFor({ entry, riskPerShare: Math.abs(entry - stop) });
    if (!size || !(size.shares > 0)) {
      return res.status(400).json({
        ok: false,
        error: (size && size.reason) || 'set account size and risk per trade first',
      });
    }
    /*
     * WHERE IT CAME FROM, when the caller says.
     *
     * A hand-sent order that came off an alert is not the same event as one
     * typed into the calculator, and the difference matters twice: the per-setup
     * daily cap only counts orders it can attribute, and a week from now the
     * only question about this trade will be which setup produced it. Defaults
     * unchanged, so the calculator behaves exactly as before.
     */
    const setupId = String(b.setupId || '').trim() || 'manual';
    const source = String(b.source || '').trim()
      || (setupId === 'manual' ? 'placed by hand' : 'reviewed, then sent by hand');
    res.json({ ok: true, order: await broker.placeOrder({
      symbol, signal: side, quantity: size.shares, price: entry,
      stop, target: Number(b.target) > 0 ? Number(b.target) : null,
      date: toETDate(Date.now()), source, setupId,
    }) });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

/*
 * Send one share, to the test hook when one is configured.
 *
 * The only way to learn that a URL is wrong, an account is disconnected or a
 * symbol is unsupported is to send something. Finding that out at 10:00:02 with
 * a real position on the line is not a plan.
 */
/*
 * SignalStack calling US, when an order has been processed.
 *
 * This is the half the reply to the POST cannot give. That reply says what was
 * true in the instant — usually 'accepted'. Filled at a different price, partly
 * filled, rejected by the broker a second later: that arrives here or nowhere,
 * and without it the ledger records intentions and calls them outcomes.
 *
 * THE TOKEN IN THE PATH IS THE ONLY LOCK. SignalStack posts to a plain URL and
 * sends no key of its own, so the URL has to be unguessable — hence a random
 * token, compared in constant time, and a 404 rather than a 403 on a miss so
 * the endpoint does not confirm its own existence to a scanner.
 *
 * It always answers 200 to a valid token, even when it cannot make sense of the
 * body. A sender that gets an error will retry or disable the notification, and
 * the raw body is stored either way — an unread callback must never look like
 * an order that simply went quiet.
 */
app.post('/api/broker/callback/:token', express.json({ limit: '64kb' }), async (req, res) => {
  if (!broker.tokenMatches(req.params.token)) {
    return res.status(404).json({ ok: false });
  }
  try {
    const entry = broker.receiveCallback(req.body);
    console.log(`[Broker] callback: ${entry.symbol || '?'} ${entry.status || 'unknown'}`
      + `${entry.fillPrice ? ` @ ${entry.fillPrice}` : ''}`
      + `${entry.matched ? '' : ' (no matching order on this side)'}`);

    /*
     * Wake the phone only for bad news. A fill confirms what the alert already
     * said and does not need a second buzz; a rejection arriving after the
     * alert said the order went in is the one thing that can turn a position
     * you believe you hold into one you do not.
     */
    if (broker.callbackIsBadNews(entry)) {
      const store = require('./store');
      const { toETDate } = require('../utils/time');
      const day = entry.date || toETDate(Date.now());
      store.publishFires([{
        ruleId: 'broker', rule: 'Broker', ticker: entry.symbol || null,
        toolId: 'ALERTS', date: day, at: Date.now(),
        kind: 'broker', level: 'error',
        detail: `Order ${entry.status || 'problem'} at the broker`
          + `${entry.symbol ? ` for ${entry.symbol}` : ''}`
          + `${entry.message ? ` — ${entry.message}` : ''}`
          + '. You may NOT have the position the alert said you did.',
      }], day);
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('[Broker] callback failed:', err.message);
    res.json({ ok: true });            // see the note above
  }
});

app.post('/api/broker/test', express.json(), async (req, res) => {
  try {
    res.json({ ok: true, result: await broker.test({
      symbol: req.body?.symbol || 'AAPL',
      useTestHook: req.body?.useTestHook !== false,
    }) });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

// Where a tool lives, so the page can deep-link a fire back to its card.
app.get('/api/tools', (req, res) => {
  try {
    const reg = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools.config.json'), 'utf8'));
    res.json({ ok: true, tools: reg.tools || [], apps: reg.apps || [] });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

/*
 * Push: notifications that arrive with the page closed.
 *
 * Everything else on that page needs an open tab. A setup fires at a fixed
 * minute and the trade is taken on sight, so "only while you are looking" is
 * not a delivery mechanism — it is the failure this closes. See push.js.
 */
const push = require('./push');

// The key a browser needs to create a subscription. Public by definition; the
// private half never leaves the box.
app.get('/api/push/key', (req, res) => {
  try {
    res.json({ ok: true, publicKey: push.publicKey() });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/push/subscribe', express.json(), (req, res) => {
  try {
    const count = push.subscribe(req.body?.subscription, req.body?.label);
    res.json({ ok: true, subscribers: count });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

app.post('/api/push/unsubscribe', express.json(), (req, res) => {
  res.json({ ok: true, removed: push.unsubscribe(req.body?.endpoint) });
});

/*
 * Send one now.
 *
 * Not a nicety. A subscription can look perfect on this side and still be dead
 * — the browser retired it, the phone's battery settings hold it, the keypair
 * changed — and every one of those failures is invisible until the morning it
 * matters. This is how you find out on a Sunday instead of at 10:00:02.
 */
app.post('/api/push/test', express.json(), async (req, res) => {
  try {
    res.json({ ok: true, ...(await push.notifyAll()) });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/health', (req, res) => {
  const store = require('./store');
  res.json({
    ok: true, app: 'ALERTS', name: 'Alerts', ts: Date.now(),
    rules: store.listRules().length,
    // Carried so "why did my phone stay quiet" has an answer that does not
    // need a login: zero here is the whole explanation.
    pushSubscribers: push.list().length,
  });
});

app.use(express.static(path.join(ROOT, 'public'), { index: false }));
app.get('/{*path}', (req, res) => res.sendFile(path.join(ROOT, 'public', 'alerts.html')));

const PORT = Number(process.env.ALERTS_PORT || 3090);
// Same guard as the screener: requiring this file in a test must not take a
// port or leave a handle open behind the assertions.
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`[Alerts] service on port ${PORT}`);
    console.log(`[Alerts]   rules=${require('./store').RULES_FILE}`);
    // Started with the server, not on demand: the whole point is that it is
    // running when nobody has the page open.
    require('./watcher').start();
    // Closing what was opened is not optional in an account that cannot hold
    // overnight, so it starts with the server rather than on demand.
    require('./flattener').start();
  });
}

module.exports = app;
