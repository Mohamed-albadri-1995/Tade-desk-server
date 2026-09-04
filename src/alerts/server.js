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
        /*
         * WHICH ACCOUNTS RUN IT, read from the accounts rather than stored
         * here. A setup owns no part of the money decision any more: the
         * account lists its setups and declares its mode, and this is that
         * same fact turned round for display. Nothing writes back through it.
         */
        accounts: require('../broker/signalstack').accountsFor(s.id).map(c => ({
          id: c.destinationId, name: c.destinationName, mode: c.mode,
        })),
        maxTradesPerDay: s.maxTradesPerDay || null,
        riskPerTrade: s.riskPerTrade || null,
        // ...or as a percentage. Absent here, the page shows a setup sized
        // at 0.5% as having no risk figure at all.
        riskPct: s.riskPct || null,
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
/*
 * WHICH FEED EVERYTHING DEFAULTS TO — read and set, proxied to qp.
 *
 * qp owns the answer, so this does not keep a second copy of it. Proxied
 * rather than called from the browser because the page is served from 3090 and
 * qp is on 8765: a direct call is cross-origin, and adding CORS to a service
 * that can move money to fix a dropdown is the wrong trade.
 *
 * WHY IT IS A SETTING AT ALL. It used to be inferred — polygon whenever a
 * POLYGON_API_KEY existed — and a key being present does not mean the plan
 * behind it includes the data being asked for. Every 1-minute request 403'd
 * with "your plan doesn't include this data timeframe" while the platform
 * reported polygon as its best feed, so charts and backtests failed on the one
 * feed it had chosen for them.
 */
app.get('/api/feed', async (req, res) => {
  try {
    const qp = require('../setups/qpClient');
    const r = await fetch(`${qp.baseUrl()}/api/health`, { signal: AbortSignal.timeout(4000) });
    const d = await r.json();
    res.json({ ok: true, feeds: d.feeds || {}, defaultFeed: d.default_feed || null,
               chosen: !!d.default_chosen });
  } catch (err) {
    res.json({ ok: false, error: `qp did not answer: ${err.message}` });
  }
});

app.post('/api/feed', express.json(), async (req, res) => {
  try {
    const qp = require('../setups/qpClient');
    const r = await fetch(`${qp.baseUrl()}/api/settings/default-feed`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ feed: (req.body || {}).feed }),
      signal: AbortSignal.timeout(5000),
    });
    const d = await r.json();
    if (!d.ok) throw new Error(d.error || 'qp refused it');
    res.json({ ok: true, feeds: d.feeds || {}, defaultFeed: d.default_feed,
               chosen: !!d.default_chosen });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

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

/*
 * WHAT THE ACCOUNT ACTUALLY PAID, for the journal.
 *
 * The journal records what a trade was MEANT to be — the price the decision
 * used. This is what Alpaca says the money did: every fill, grouped per name,
 * with the average each way and the realised result once a position is
 * round-tripped.
 *
 * A GET so the journal page can read it cross-port; GETs here already carry
 * Access-Control-Allow-Origin. Alpaca only — TTP5k is behind TraderEvolution
 * and has no position feed, and the response says so rather than presenting
 * half a desk as the whole of it.
 */
app.get('/api/broker/fills', async (req, res) => {
  try {
    const { toETDate } = require('../utils/time');
    const day = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date || '')
      ? req.query.date : toETDate(Date.now());
    const reconcile = require('../broker/reconcile');
    const out = await reconcile.fillsFor(day);
    res.json({ ...out, date: day, scope: 'alpaca',
               unverified: reconcile.alpacaDestinations().length
                 ? undefined : 'no Alpaca account is configured' });
  } catch (err) {
    // 200 with ok:false — a journal page that got a 500 would show nothing and
    // say nothing, which reads as "no trades" rather than as "could not ask".
    res.json({ ok: false, error: err.message });
  }
});

/*
 * WHICH SETUP PUT EACH NAME ON, for the journal to tag itself with.
 *
 * The journal's setup field is filled by hand, and it is what per-setup
 * expectancy is computed from — so an untagged day is a day that cannot be
 * measured, and tagging from memory a week later is how a trade gets filed
 * under the wrong strategy. The desk already knows: it chose the setup, sized
 * it, sent it and wrote the row. Nothing had ever asked it.
 *
 * The ids are the SAME ids the journal's own setup list carries: that list is
 * proxied from /api/setups on this app, so a journal trade ends up tagged with
 * the setup that actually fired, under the id the backtests use. Anything else
 * and per-setup expectancy would measure a different set of names while looking
 * identical.
 *
 * NOTHING IS WRITTEN HERE. This says what the desk did; the journal decides
 * whether to accept it, and only ever for a field that is still empty.
 */
/*
 * DID THE ORDER ACTUALLY LAND — asked of Alpaca, not of the ledger.
 *
 * The ledger records what this side ATTEMPTED and what SignalStack replied.
 * SignalStack replying 200 means SignalStack accepted it, not that the broker
 * ever got it, and the two are the last four words of this module's own
 * opening note: "SENT, AND ALPACA HAS NO RECORD — SignalStack accepted it and
 * the broker never got it. The alert said the trade was on."
 *
 * `reconcile.confirmed()` has answered this correctly since it was written —
 * per destination, each group matched only against fills fetched with THAT
 * account's credentials, so one account's print can never confirm another's
 * order. NOTHING CALLED IT. A function that is right and unreferenced is a
 * function that has never been right about anything, and the desk placed
 * orders all day without ever asking the broker whether they existed.
 *
 * Reported as: "the Algo desk must get feedback from alpaca for orders
 * confirmation."
 *
 * READ-ONLY, and on demand. It sends nothing and changes nothing — it reads
 * the day's rows and the day's fills and says which ones match. A confirmation
 * that could act would need to be right about a great deal more than this is.
 */
app.get('/api/broker/confirm', async (req, res) => {
  try {
    const { toETDate } = require('../utils/time');
    const day = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date || '')
      ? req.query.date : toETDate(Date.now());
    const reconcile = require('../broker/reconcile');
    const out = await reconcile.confirmed(day);
    const rows = out.rows || [];
    /*
     * THE COUNT THAT MATTERS IS THE UNMATCHED ONE. "18 of 20 confirmed" is a
     * pass mark; "2 orders this desk believes it sent have no fill at Alpaca"
     * is the sentence worth waking up for, so it is named here rather than
     * left to whoever reads the array.
     *
     * ONLY ORDERS THAT COULD BE CONFIRMED ARE COUNTED. TTP5k sits behind
     * TraderEvolution with no fill feed, so a TTP order has no print to match
     * and never will — counting it as unmatched would report a permanent
     * failure on an account that is working, every single day, and the number
     * would stop being read.
     */
    const alpacaIds = new Set(reconcile.alpacaDestinations());
    const askable = rows.filter(r => r.sent && alpacaIds.has(r.destination));
    // `confirmedBy` distinguishes the two ways a row can be confirmed: the
    // SignalStack callback said so, or Alpaca's own fills did. Only the second
    // is what this endpoint was asked for.
    const byAlpaca = askable.filter(r => r.confirmedBy === 'alpaca');
    const unmatched = askable.filter(r => !r.confirmed);
    res.json({
      ...out, date: day, scope: 'alpaca',
      sent: askable.length,
      confirmed: byAlpaca.length,
      // Confirmed by the callback and NOT found in the fills. Not a failure on
      // its own — a callback is evidence — but it is a weaker kind, and the
      // difference is the whole reason to ask Alpaca directly.
      callbackOnly: askable.filter(r => r.confirmed && r.confirmedBy !== 'alpaca').length,
      unmatched: unmatched.map(r => ({ symbol: r.symbol, action: r.action,
                                       destination: r.destination || null,
                                       at: r.at || null })),
      // Orders this endpoint cannot speak for, so a partial answer is legible.
      notAskable: rows.filter(r => r.sent && !alpacaIds.has(r.destination)).length,
    });
  } catch (err) {
    // 200 with ok:false — see /api/broker/fills. A 500 here would read on the
    // page as "no orders", which is the opposite of what it means.
    res.json({ ok: false, error: err.message });
  }
});

app.get('/api/broker/setups', async (req, res) => {
  try {
    const { toETDate } = require('../utils/time');
    const day = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date || '')
      ? req.query.date : toETDate(Date.now());
    const bySymbol = broker.setupBySymbol(day);
    /*
     * The name, joined on best effort. qp may be down, and a tag with an id and
     * no display name still tags correctly — the id is what is stored. So a
     * failure here costs the label, never the answer.
     */
    const names = {};
    if (Object.keys(bySymbol).length) {
      try {
        for (const s of await require('../setups/catalog').list()) names[s.id] = s.name;
      } catch { /* the label only. The id is what gets stored. */ }
    }
    res.json({
      ok: true, date: day, scope: 'this desk only',
      symbols: Object.values(bySymbol).map(g => ({
        ...g, setupName: g.setupId ? (names[g.setupId] || g.setupId) : null,
      })),
    });
  } catch (err) {
    // 200 with ok:false — see /api/broker/fills. A page that got a 500 shows
    // nothing and says nothing, which reads as "no trades".
    res.json({ ok: false, error: err.message });
  }
});

/*
 * THE ACCOUNT'S OWN TRADES, paired out of its fills, for the journal to import.
 *
 * The journal's only ways in were a pasted CSV and typing, so a day the desk
 * traded automatically produced no journal entry at all. Its status line said
 * "Alpaca — connected, 3 names filled today" above a page reading "0 trades",
 * which is the whole problem in one screen.
 *
 * A FILL IS NOT A TRADE — Alpaca reports prints, a journal holds round trips —
 * so the pairing is done here, once, where it can be tested, rather than in the
 * page. See src/broker/journalTrades.js for what that costs to get right.
 *
 * `days` rather than a pair of dates, because the question is always "the last
 * N sessions" and two dates is two chances to get a boundary wrong. Bounded:
 * activities are paged and a year of them is not a page.
 */
app.get('/api/broker/journal-trades', async (req, res) => {
  try {
    const { toETDate } = require('../utils/time');
    const days = Math.min(90, Math.max(1, Number(req.query.days) || 1));
    const from = /^\d{4}-\d{2}-\d{2}$/.test(req.query.from || '')
      ? req.query.from
      : toETDate(Date.now() - (days - 1) * 86400000);
    // 04:00 ET covers the pre-market, so nothing placed early is missed.
    const after = new Date(`${from}T04:00:00-04:00`).toISOString();

    /*
     * ONE ACCOUNT AT A TIME, EACH WITH ITS OWN KEYS.
     *
     * Pooling two accounts' fills and pairing them into round trips would build
     * trades that never happened: a buy in account A closed by a sell in
     * account B is one imaginary round trip and two real positions left open.
     * So each account is fetched and paired separately, and every trade carries
     * the account that made it.
     */
    const alpaca = require('../alpaca/account');
    const reconcile = require('../broker/reconcile');
    const { tradesFrom } = require('../broker/journalTrades');

    const scope = reconcile.credentialScope();
    const readable = scope.readable;
    if (!readable.length) {
      return res.json({ ok: false, scope: 'alpaca',
                        error: scope.reason || 'no readable Alpaca account' });
    }

    const trades = [];
    const problems = scope.blind.length ? [scope.reason] : [];
    let fillCount = 0;
    for (const id of readable) {
      const { creds, error } = reconcile.credsForDest(id);
      if (error) { problems.push(error); continue; }
      const r = await alpaca.fills({ after, account: creds });
      if (!r.ok) { problems.push(`${id}: ${r.error}`); continue; }
      fillCount += r.fills.length;
      /*
       * A LONE ACCOUNT IS NOT LABELLED. With one account the journal's rows
       * have always read 'Alpaca', and stamping an internal destination id on
       * them would rewrite every existing trade's identity for no gain.
       */
      trades.push(...tradesFrom(r.fills, readable.length > 1 ? id : null));
    }

    /*
     * WHICH SETUP TOOK IT, joined on while we are here. The journal's setup tag
     * is what per-setup expectancy is computed from, and a trade imported
     * untagged is one somebody has to remember about a week later.
     */
    const byDate = {};
    for (const t of trades) {
      if (!byDate[t.date]) byDate[t.date] = broker.setupBySymbol(t.date);
      const g = byDate[t.date][t.ticker];
      if (g && !g.ambiguous) t.setupId = g.setupId;
    }

    res.json({ ok: problems.length === 0, from, days, scope: 'alpaca',
               // Which accounts this covers, so a partial answer and a complete
               // one do not look the same.
               accounts: readable,
               ...(problems.length ? { error: problems.join(' · ') } : {}),
               fills: fillCount, trades });
  } catch (err) {
    // 200 with ok:false — see /api/broker/fills.
    res.json({ ok: false, error: err.message });
  }
});

app.get('/api/broker', async (req, res) => {
  const { toETDate } = require('../utils/time');
  const day = toETDate(Date.now());
  const cfg = broker.settings();
  /*
   * WHAT THE BROKER SAYS, beside what this side believes.
   *
   * `openSymbols` reads the LEDGER — sent minus closed — so it cannot see a
   * stop or a target that filled at the broker. It over-reports by design,
   * which is right for the 15:50 flatten and wrong for a number on a screen.
   * The page was showing a committed-dollars figure from one source and an
   * open-positions figure from another, and only one of them had ever been
   * checked against the account.
   *
   * Never blocks the response: `heldNow` is cached, short-timeout, and returns
   * a REASON rather than an empty list when it cannot ask. "You hold nothing"
   * and "I could not find out" must not render the same.
   */
  let held = { ok: false, verifiable: false, reason: 'not asked', positions: null };
  try { held = await require('../broker/reconcile').heldNow(); }
  catch (err) { held = { ok: false, verifiable: true, reason: err.message, positions: null }; }

  res.json({
    ok: true,
    broker: broker.publicSettings(),
    // This side's own tally, labelled as an estimate everywhere it appears.
    committedToday: broker.committed(day),
    // What the box believes it still has open, so "will anything be left at the
    // bell" is answerable before the bell.
    openSymbols: broker.openSymbols(day),
    // …and what the account itself reports, which is the one that is true.
    held,
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
 * WHICH ACCOUNT a hand-sent order goes to.
 *
 * One rule for the preview and the send, so the two cannot disagree — which
 * would mean reviewing an order against one balance and placing it against
 * another. In order of how explicit it is:
 *
 *   the page named one       used, unless that account is alert-only
 *   the fire came from a     the account that runs that setup by hand, when
 *   setup                    exactly one does
 *   neither                  the only account that can receive orders at all
 *
 * `choices` always goes back so the picker can list every account without the
 * page having to know which ones are switched on.
 */
function destinationFor(b = {}) {
  const choices = broker.accountsFor(null, ['manual', 'auto']).map(c => ({
    id: c.destinationId, name: c.destinationName, dialect: c.dialect, mode: c.mode,
    // Whether this account normally runs the setup the order came from. The
    // picker offers all of them either way — sending one somewhere it does not
    // normally go is a decision a person may make — but it should not look the
    // same as the account that was set up for it.
    runsIt: !!(b.setupId && (c.setups || []).includes(String(b.setupId))),
  }));
  const named = String(b.destination || '').trim();
  if (named) return { ...broker.manualCfg(named), choices };

  const setupId = String(b.setupId || '').trim();
  if (setupId && setupId !== 'manual') {
    const mine = broker.accountsFor(setupId, ['manual', 'auto']);
    if (mine.length === 1) return { cfg: mine[0], error: null, choices };
    if (mine.length > 1) {
      return { cfg: null, choices, error: `${mine.length} accounts run this setup `
        + `(${mine.map(c => c.destinationName).join(', ')}) — pick one` };
    }
  }
  if (choices.length === 1) {
    return { ...broker.manualCfg(choices[0].id), choices };
  }
  return { cfg: null, choices, error: choices.length
    ? `pick an account — there are ${choices.length}`
    : 'no broker account can receive an order — add one, or take one off '
      + '"alert only", on the Settings tab' };
}

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

    /*
     * WHICH account this would go to.
     *
     * Named outright when the page says so, and otherwise resolved the same
     * way an automatic order is — so a preview and the 09:36 order that follows
     * it cannot land in different accounts. `destinations` goes back with it
     * because the page has to offer the choice, and it is the server that knows
     * which ones are live.
     */
    const cfg = destinationFor(b);
    /*
     * The share count comes from the same risk.sizeFor the setups use, so the
     * chain here is identical to the one a fire goes through — and it is sized
     * FOR THE CHOSEN ACCOUNT. The same trade is a different number of shares in
     * a $5,000 account and a $20,000 one; a preview that showed the desk's
     * number and then sent a different one would be the worst kind of preview.
     */
    /*
     * SIZED AT THE STANDARD, THEN SCALED — the same two steps, in the same
     * order, as a setup firing at 09:36. A preview that derived the number any
     * other way would be a preview of a different order.
     */
    const size = risk.scaleTo(risk.sizeFor({ entry, riskPerShare }), cfg.cfg);
    const preview = broker.previewOrder({
      symbol: String(b.symbol || '').toUpperCase(),
      signal: side,
      quantity: size ? size.shares : 0,
      price: entry,
      stop,
      target: Number(b.target) > 0 ? Number(b.target) : null,
      date: toETDate(Date.now()),
      setupId: b.setupId || null,
      ...(cfg.cfg ? { cfg: cfg.cfg } : {}),
    });
    if (cfg.error) {
      return res.json({ ok: true, side, entry, stop, riskPerShare, size,
        preview: { blocked: 'no-destination', reason: cfg.error },
        destinations: cfg.choices });
    }
    preview.destination = cfg.cfg.destinationId;
    preview.destinationName = cfg.cfg.destinationName;
    res.json({ ok: true, side, entry, stop, riskPerShare, size, preview,
      destinations: cfg.choices });
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

    // Resolved before sizing, because the account decides the share count.
    const dest = destinationFor(b);
    if (dest.error) return res.status(400).json({ ok: false, error: dest.error });
    const size = risk.scaleTo(
      risk.sizeFor({ entry, riskPerShare: Math.abs(entry - stop) }), dest.cfg);
    if (!size || !(size.shares > 0)) {
      return res.status(400).json({
        ok: false,
        error: (size && size.reason)
          || 'set the standard account size and risk per trade first',
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
    res.json({ ok: true, order: {
      ...await broker.placeOrder({
        symbol, signal: side, quantity: size.shares, price: entry,
        stop, target: Number(b.target) > 0 ? Number(b.target) : null,
        date: toETDate(Date.now()), source, setupId, cfg: dest.cfg,
      }),
      destination: dest.cfg.destinationId,
      broker: dest.cfg.destinationName,
    } });
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
      // Each account has to be testable on its own: a hook that is wrong is
      // wrong per account, and a test that only ever reached the first one
      // would leave the second untested while looking like it had passed.
      destination: req.body?.destination || null,
    }) });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

/*
 * THE PREFLIGHT: which legs of the chain are proven, and which have never been
 * tested.
 *
 * `Test 1 share` posts one AAPL share to one account through its TEST hook. It
 * proves that hook and nothing else — no scanner, no card list, no feed, no qp
 * decision, no sizing, no routing — and its ledger row is dateless, so neither
 * confirm nor the journal can ever see it. A green result there is one leg of
 * seven, and the honest reading of the other six is "unknown".
 *
 * So this answers all seven, and marks the ones it could not tell as UNTESTED
 * rather than passed. Read-only: it places no order and is safe mid-session.
 *
 * NEVER 500 — the same rule as the session log. This is the endpoint someone
 * opens BECAUSE something is wrong.
 */
app.get('/api/preflight', async (req, res) => {
  try {
    const { toETDate } = require('../utils/time');
    const day = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date || '')
      ? req.query.date : toETDate(Date.now());
    res.json(await require('./preflight').check({ day }));
  } catch (err) {
    res.json({ ok: false, error: err.message, legs: [],
               passed: 0, failed: 0, untested: 0 });
  }
});

/*
 * GET /api/setups/:id/rehearse — run one setup's whole chain, right now.
 *
 * PROXIED, because this process cannot run a setup. It has no database and no
 * card list; the universe a setup ranks belongs to the tool that found it. So
 * the desk asks the owning tool, on its own port, and hands back what it says.
 *
 * WHY THE PAGE DOES NOT ASK THE TOOL DIRECTLY: a different port is a different
 * origin, and the tools only allow cross-origin reads on a short fixed list of
 * paths. One server-side hop keeps that list closed.
 *
 * A SETUP WITH NO TOOL IS UNTESTED, NOT PASSED. It comes back with every leg
 * null and a sentence saying why — a rehearsal that quietly reported "fine"
 * for a setup nothing can run would be the exact failure this is built against.
 */
app.get('/api/setups/:id/rehearse', async (req, res) => {
  const blank = (note) => ({
    ok: false, rehearsal: true, setupId: req.params.id, at: Date.now(),
    legs: [], passed: 0, failed: 0, untested: 0, verdict: null, note,
  });
  try {
    const setup = await require('../setups/catalog').get(req.params.id);
    if (!setup) return res.status(404).json(blank('No such setup.'));
    const owners = setup.tools || [];
    if (!owners.length) {
      return res.json(blank(`${setup.name} names no tool, so no card list can be `
        + 'ranked and there is nothing to rehearse. Assign it to a tool in qp.'));
    }
    const reg = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools.config.json'), 'utf8'));
    const want = String(req.query.tool || owners[0]);
    const tool = (reg.tools || []).find(t => t.id === want);
    if (!tool) {
      return res.json(blank(`${setup.name} belongs to ${want}, which is not in `
        + 'tools.config.json — there is no port to ask.'));
    }
    if (tool.enabled === false) {
      return res.json(blank(`${setup.name} belongs to ${tool.id}, which is switched `
        + 'off. A sleeping tool collects no cards, so the setup has nothing to rank.'));
    }
    /*
     * A LONG TIMEOUT ON PURPOSE. qp gets two attempts of eighteen seconds
     * inside the runner, and a cold platform uses most of them. Cutting this
     * off at the usual four seconds would report "did not answer" for a
     * decision that was on its way — which is the wrong answer twice over.
     */
    const r = await fetch(`http://127.0.0.1:${tool.port}/api/setups/`
      + `${encodeURIComponent(setup.id)}/rehearse`,
    { signal: AbortSignal.timeout(90000) });
    if (!r.ok) return res.json(blank(`${tool.id} answered ${r.status}.`));
    const out = await r.json();
    res.json({ ...out, tool: tool.id, toolName: tool.name });
  } catch (err) {
    res.json(blank(`Could not reach the tool that owns this setup: ${err.message}`));
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
 * THE SESSION LOG: what the desk did, including what it decided not to do.
 *
 * The alert feed on this page answers "what fired". It cannot answer "what
 * did not, and why" — a thing that did not fire produces no alert — and the
 * reasons are exactly where a strategy quietly stops being the one that was
 * tested: the filter took the name out, the pick fired on a bar it could not
 * act on, the latch had already used it, the account had no size for it, the
 * broker refused it.
 *
 * Two shapes come back, and they are the two halves of a day:
 *
 *     runs    one per decision  — the funnel from cards to orders
 *     passes  one per sweep     — where the stops were, what closed
 *
 * `summary` is the whole day per setup, which is the view that answers "did
 * the desk do what I set it up to do" without reading four hundred rows.
 */
const sessionLog = require('../setups/sessionLog');

app.get('/api/session-log', (req, res) => {
  // NEVER 500. This is the page someone opens BECAUSE something went wrong,
  // and a reader that fails when the day was bad is a reader that is never
  // there when it is needed.
  try {
    const { toETDate } = require('../utils/time');
    const date = String(req.query.date || '') || toETDate(Date.now());
    const setupId = String(req.query.setup || '') || null;
    const kind = String(req.query.kind || '');
    const limit = Math.min(Math.max(Number(req.query.limit) || 400, 1), 5000);
    const out = { ok: true, date, summary: sessionLog.summaryOf(date) };
    if (kind !== 'pass') {
      // NEWEST FIRST. The file is append-only and oldest-first, which is the
      // right order to write and the wrong one to open: what just happened is
      // what is being looked for.
      out.runs = sessionLog.runsOn(date, setupId).reverse().slice(0, limit);
    }
    if (kind !== 'run') {
      out.passes = sessionLog.passesOn(date).reverse().slice(0, limit);
      out.symbols = sessionLog.symbolsOn(date);
    }
    res.json(out);
  } catch (err) {
    res.json({ ok: false, error: err.message, runs: [], passes: [], summary: {} });
  }
});

/*
 * One position's day, collapsed to the changes.
 *
 * 390 near-identical rows hide the shape of a day as thoroughly as having no
 * file at all, so consecutive passes that say the same thing are one line.
 */
app.get('/api/session-log/track', (req, res) => {
  try {
    const { toETDate } = require('../utils/time');
    const date = String(req.query.date || '') || toETDate(Date.now());
    const symbol = String(req.query.symbol || '');
    if (!symbol) return res.json({ ok: false, error: 'symbol is required', track: [] });
    res.json({ ok: true, date, symbol, track: sessionLog.trackOf(date, symbol) });
  } catch (err) {
    res.json({ ok: false, error: err.message, track: [] });
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
    /*
     * The half of a strategy a broker cannot hold — an exit RULE and a stop
     * that moves. Here rather than in the nine tool processes for the same
     * reason the flattener is: `close` takes no quantity, so two processes
     * deciding to flatten one symbol is one flat position and one accidental
     * reversal.
     */
    require('../setups/manager').start();
  });
}

module.exports = app;
