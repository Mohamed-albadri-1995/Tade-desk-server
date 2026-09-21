/*
 * Journal add-ons, injected at serve time by the launcher.
 *
 * The journal page lives on branch claude/test-9d4txv — a codebase with no
 * shared history with this repo. Forking a 1,079-line file to change two
 * things would put two versions of it in circulation and guarantee they drift.
 * So the original stays authoritative and untouched, and everything added
 * lives here, in one file, applied over the top.
 *
 * Two things:
 *
 * 1. DELETE THAT ACTUALLY DELETES. The page's own handler is
 *    `if (!confirm(...)) return; await fetch(...)` with no check on the reply.
 *    That has two silent failure modes and this had hit at least one of them:
 *    confirm() is blocked or dismissed on some mobile browsers, and a failed
 *    request looks exactly like a successful one because nothing reads the
 *    status. Replaced with a two-tap confirm (no browser dialog) that reports
 *    what happened. Verified separately that the API itself is correct:
 *    DELETE /api/journal/trades/:id returns 200 and removes the row.
 *
 * 2. A CHART BUTTON. qp already renders exactly the sheet wanted — the print
 *    view, indicators and all — and now marks entry and exit on it. So the
 *    button is a link, not a second charting stack.
 *
 * 3. WHAT THE ACCOUNT ACTUALLY PAID. The journal records what a trade was MEANT
 *    to be: the price the strategy decided on, typed or imported. Alpaca knows
 *    what the money did. The two differ by the minute between the decision
 *    bar's close and the market order, and by whatever the spread took — a gap
 *    nobody had measured, because nothing had ever put the two numbers next to
 *    each other.
 *
 *    So each card gets one line: the real average fill each way, and the
 *    realised result once the position is round-tripped. It is shown only when
 *    Alpaca has a fill for that name on that date, and it never overwrites what
 *    the journal recorded — a card that disagrees is the interesting one, and
 *    replacing the number would hide exactly the thing worth seeing.
 *
 *    ALPACA ONLY. TTP5k is behind TraderEvolution with no position feed, so a
 *    card traded there shows nothing rather than showing zero.
 *
 * 4. A STATUS LINE, because 3 was invisible. The fill line is drawn only when
 *    Alpaca has a fill for that name on that date, which is right — a "0" on a
 *    card nobody traded is a number nobody made. But on a day with no fills it
 *    means the page looks EXACTLY as it did before any of this existed, and
 *    "connected, nothing to show" is indistinguishable from "broken". That was
 *    reported as "I am not seeing any connection to Alpaca in this tool", and
 *    it was a fair reading of what the page showed.
 *
 *    So the trades list now carries one line saying whether the desk answered,
 *    whether Alpaca answered it, and how many names it has for today. Silence
 *    stays silent per CARD; the CONNECTION says so out loud.
 *
 * 5. THE SETUP FIELD, FILLED BY THE DESK THAT PLACED THE ORDER. The journal's
 *    setup tag is what per-setup expectancy is computed from, and it was typed
 *    by hand — so an untagged day is a day that cannot be measured, and tagging
 *    from memory a week later is how a trade gets filed under the wrong
 *    strategy. The desk chose the setup, sized it, sent it and wrote the row.
 *
 *    Three rules, and they are the whole design:
 *
 *      it only ever fills a field that is EMPTY. A tag chosen by a person is
 *      never touched, and a trade opened by hand stays untagged for a person to
 *      tag — which is the case this must not break.
 *
 *      it only fills when the DESK SENT AN ORDER for that name on that date. No
 *      inference from the ticker, no nearest match.
 *
 *      two setups on one name on one day is AMBIGUOUS and it stops. A wrong tag
 *      is worse than no tag: it is invisible, and it moves a losing trade into
 *      another strategy's record.
 */
(function () {
  'use strict';

  var QP_PORT = 8765;                 // the chart platform, same host
  var ALERTS_PORT = 3090;             // the desk, which is what talks to Alpaca
  var CONTAINER = 'jnl-cards-container';

  /* ── the real fills, per date ─────────────────────────────────────────
   * Cached per date because the card list re-renders on every keystroke in
   * the ticker filter, and a fetch per render would be a request per letter.
   * A failure is cached too, as an empty map: retrying it on every render
   * would turn one unreachable desk into a request storm.
   */
  var fillsByDate = {};

  /*
   * THE ACCOUNTS THE DESK HAS, not the ones today's trades happen to mention.
   *
   * Asked once and cached. Fetched in the background: the filter must draw
   * immediately from what the trades show, and grow when the answer arrives —
   * a control that waits on a request is a control that is missing whenever
   * the alerts process is restarting.
   *
   * A FAILED REQUEST LEAVES THE LIST EMPTY, which falls back to the accounts
   * present in the trades. Never an error rendered as "this desk has one
   * account", which would remove the filter for a reason that has nothing to
   * do with accounts.
   */
  /*
   * KEYED ON THE ID, LABELLED WITH THE NAME — and getting that backwards is
   * what put four buttons on a two-account desk, half of them inert.
   *
   * "the filters are double and they don't even work". Both halves, and the
   * same cause. This read `x.name || x.id`, so the desk contributed
   * "Alpaca100ktest" and "alpaca100k935" while the trades contributed
   * "alpaca1" and "alpaca2" — src/alerts/server.js:483 stamps the ID onto
   * every row (`tradesFrom(r.fills, id)`). The two lists have no member in
   * common, so the merge below could not collapse them: two accounts, four
   * buttons, and the two named ones matched no trade at all and emptied the
   * page when pressed.
   *
   * So the id is what is compared and the name is what is read. They are
   * different jobs and one string cannot do both.
   */
  var acctsKnown = [];              // [{ id, name }]
  function acctSig(list) {
    return list.map(function (a) { return a.id + '|' + a.name; }).join(',');
  }
  function byAcct(a, b) { return a.id < b.id ? -1 : (a.id > b.id ? 1 : 0); }
  function loadAccountsKnown() {
    var url = location.protocol + '//' + location.hostname + ':' + ALERTS_PORT
      // GET /api/broker — verified against src/alerts/server.js:510, which
      // answers { ok, broker: publicSettings(), … }. The first version of this
      // called /api/broker/settings, a route that does not exist: a guessed
      // endpoint fails silently here, because the catch below treats any
      // failure as "no accounts known" and the filter quietly narrows back to
      // whatever the trades show.
      + '/api/broker';
    fetch(url).then(function (r) { return r.json(); }).then(function (d) {
      var rows = (((d || {}).broker || {}).destinations || [])
        .map(function (x) {
          // NO ID, NO BUTTON. A destination the trades cannot be matched
          // against is a filter that can only ever show nothing.
          if (!x || !x.id) return null;
          return { id: String(x.id), name: String(x.name || x.id) };
        }).filter(Boolean);
      if (!rows.length) return;
      var before = acctSig(acctsKnown);
      acctsKnown = rows.sort(byAcct);
      if (acctSig(acctsKnown) !== before) {
        try { mergeAccountsIntoFilter(); } catch (e) { /* the page's own list still works */ }
      }
    }).catch(function () { /* leave it empty — the trades still answer */ });
  }
  function accountsKnown() { return acctsKnown.slice(); }

  function fillsFor(date) {
    if (fillsByDate[date]) return fillsByDate[date];
    var url = location.protocol + '//' + location.hostname + ':' + ALERTS_PORT
      + '/api/broker/fills?date=' + encodeURIComponent(date);
    fillsByDate[date] = fetch(url)
      .then(function (r) { return r.json(); })
      .then(function (d) {
        /*
         * A LIST PER SYMBOL, NOT ONE ENTRY.
         *
         * The desk now returns one group per (symbol, ACCOUNT) — the same
         * ticker bought in two accounts is two positions with two entry
         * prices, and averaging them would print a number neither account
         * paid. `map[g.symbol] = g` kept whichever arrived last and silently
         * dropped the other account's fill.
         */
        var map = {};
        if (d && d.ok) {
          (d.symbols || []).forEach(function (g) {
            (map[g.symbol] = map[g.symbol] || []).push(g);
          });
        }
        return map;
      })
      .catch(function () { return {}; });
    return fillsByDate[date];
  }

  function money(n) {
    return (n >= 0 ? '+' : '') + Number(n).toFixed(2);
  }

  function deskUrl(path) {
    return location.protocol + '//' + location.hostname + ':' + ALERTS_PORT + path;
  }

  /* ── which setup put each name on, per date ───────────────────────────
   * Same caching rule as the fills, and for the same reason: the list
   * re-renders on every keystroke in the ticker filter.
   */
  var setupsByDate = {};

  function deskSetupsFor(date) {
    if (setupsByDate[date]) return setupsByDate[date];
    setupsByDate[date] = fetch(deskUrl('/api/broker/setups?date=' + encodeURIComponent(date)))
      .then(function (r) { return r.json(); })
      .then(function (d) {
        var map = {};
        if (d && d.ok) (d.symbols || []).forEach(function (g) { map[g.symbol] = g; });
        return map;
      })
      .catch(function () { return {}; });
    return setupsByDate[date];
  }

  /* ── is any of this actually connected? ───────────────────────────────
   * One line above the trades list. It exists because the per-card line is
   * drawn only when there is a fill to draw, so a day with none looks exactly
   * like a page with no add-ons at all — and that is the state this was
   * reported in.
   *
   * It probes TODAY, once per page load, which is the only date whose answer
   * says something about the CONNECTION rather than about history.
   */
  /* ── the way back to everything else ──────────────────────────────────
   *
   * The header's "← Dashboard" is href="/", which on THIS port is the journal
   * itself. It has always been a link to the page you are already on. The
   * landing page with the nine tools is on 3000, and the journal was reachable
   * from it but not the other way round.
   */
  var LANDING_PORT = 3000;

  function fixDashboardLink() {
    var a = document.querySelector('a[href="/"]');
    if (!a || a.dataset.jnlFixed) return;
    a.dataset.jnlFixed = '1';
    /*
     * The bar below replaces this link, and does it better: four programs
     * instead of one, in the same place as on every other page. It is REMOVED
     * rather than left beside the bar, because two ways home in one header is
     * the clutter the bar exists to end — but only once the bar is actually
     * drawn, so a browser where that failed keeps the only exit it has.
     */
    var bar = document.getElementById('deskbar');
    if (bar && bar.querySelector('.dk-app')) { a.remove(); return; }
    a.href = location.protocol + '//' + location.hostname + ':' + LANDING_PORT + '/';
    a.textContent = '← Trade Desk';
  }

  /*
   * ── THE APP BAR ──────────────────────────────────────────────────────
   *
   * The journal was the last program with no way out of it. Every other page
   * on this desk carries the same strip naming all four, with the current one
   * marked — see deskAppBar in public/desk.js, which the launcher serves at
   * /desk.js, and the sliced rules it serves at /deskbar.css.
   *
   * `self: false`: this is its own process on its own port, so "/" here is the
   * journal and home has to be built from the registry, not assumed.
   *
   * IT IS NOT DRAWN TWICE. This page re-renders its container on every filter
   * change and decorate() runs again each time; an id check is what keeps one
   * bar rather than one per redraw.
   */
  function appBar() {
    if (document.getElementById('deskbar')) return;
    if (typeof deskAppBar !== 'function') return;   // /desk.js did not load
    var nav = document.createElement('nav');
    nav.className = 'dk-bar';
    nav.id = 'deskbar';
    nav.setAttribute('aria-label', 'programs');
    // Above everything the page draws, including its own title row.
    document.body.insertBefore(nav, document.body.firstChild);
    deskAppBar('JOURNAL', { self: false });
  }

  /* ── pulling the account's own trades in ──────────────────────────────
   *
   * The journal's only ways in were a pasted CSV and typing, so a day the desk
   * traded automatically produced no journal entry at all — the status line
   * below said "connected, 3 names filled today" above a page reading
   * "0 trades".
   *
   * The desk pairs Alpaca's fills into round trips; this asks for them and
   * hands them to the journal. Idempotent at both ends, so pressing it twice
   * is not two copies of a day.
   */
  function importButton() {
    var host = document.getElementById(CONTAINER);
    if (!host || !host.parentNode) return;
    if (document.getElementById('jnl-import-alpaca')) return;

    var wrap = document.createElement('div');
    wrap.id = 'jnl-import-alpaca';
    wrap.style.cssText = 'display:flex;align-items:center;gap:8px;margin:0 0 8px';

    var btn = document.createElement('button');
    btn.textContent = 'Import from Alpaca';
    btn.style.cssText = 'font-size:11px;padding:4px 10px;background:#0c2a4a;'
      + 'color:#7dd3fc;border:1px solid #1e3a5f;border-radius:5px;cursor:pointer';

    var days = document.createElement('select');
    days.style.cssText = 'font-size:11px;padding:3px 6px;background:#0f172a;'
      + 'color:#94a3b8;border:1px solid #334155;border-radius:5px';
    [['1', 'today'], ['5', 'last 5 days'], ['30', 'last 30 days'],
     ['90', 'last 90 days']].forEach(function (o) {
      var opt = document.createElement('option');
      opt.value = o[0]; opt.textContent = o[1];
      days.appendChild(opt);
    });

    var msg = document.createElement('span');
    msg.style.cssText = 'font-size:11px;color:#64748b';

    btn.addEventListener('click', function () {
      btn.disabled = true;
      msg.style.color = '#64748b';
      msg.textContent = 'asking the desk…';
      fetch(deskUrl('/api/broker/journal-trades?days=' + encodeURIComponent(days.value)))
        .then(function (r) { return r.json(); })
        .then(function (d) {
          if (!d || !d.ok) throw new Error((d && d.error) || 'the desk said no');
          if (!d.trades.length) {
            msg.textContent = 'no Alpaca trades in that window.';
            return null;
          }
          msg.textContent = 'importing ' + d.trades.length + '…';
          return fetch('/api/journal/import-alpaca', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ trades: d.trades }),
          }).then(function (r) { return r.json(); });
        })
        .then(function (out) {
          if (!out) return;
          msg.style.color = '#22c55e';
          msg.textContent = out.added + ' added, ' + out.updated + ' updated'
            + (out.skipped ? ', ' + out.skipped + ' already final' : '');
          /*
           * The list is rendered from an array loaded at page start, so a new
           * row is invisible until that is reloaded. loadAll() is the journal's
           * own reload and rebuilds every tab from the database.
           */
          if (typeof window.loadAll === 'function') window.loadAll();
        })
        .catch(function (err) {
          msg.style.color = '#ef4444';
          msg.textContent = 'could not import: ' + (err && err.message || err);
        })
        .finally(function () { btn.disabled = false; });
    });

    wrap.appendChild(btn);
    wrap.appendChild(days);
    wrap.appendChild(msg);
    // Above the list, like the status line, so the card render cannot wipe it.
    host.parentNode.insertBefore(wrap, host);
  }

  function statusLine() {
    var el = document.getElementById('jnl-desk-status');
    if (el) return;
    var host = document.getElementById(CONTAINER);
    if (!host || !host.parentNode) return;

    el = document.createElement('div');
    el.id = 'jnl-desk-status';
    el.style.cssText = 'font-size:11px;color:#64748b;margin:0 0 8px;padding:6px 9px;'
      + 'background:#0f172a;border:1px solid #1e293b;border-radius:6px';
    el.textContent = 'Alpaca — asking the desk…';
    // BEFORE the container, not inside it: the list replaces its own innerHTML
    // on every render, and anything inside would be wiped and redrawn.
    host.parentNode.insertBefore(el, host);

    function set(text, colour) {
      el.textContent = 'Alpaca — ' + text;
      el.style.color = colour || '#64748b';
    }

    fetch(deskUrl('/api/broker/fills'))
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (!d || !d.ok) {
          // The desk answered and could not ask Alpaca. That is a different
          // fault from an unreachable desk and it names itself.
          return set('the desk answered but the account did not: '
            + ((d && d.error) || 'no reason given'), '#f59e0b');
        }
        if (d.unverified) return set(d.unverified + '.', '#f59e0b');
        // DISTINCT NAMES, not groups: one ticker held in two accounts is two
        // groups and one name, and "2 names filled" on a day one stock traded
        // reads as a busier day than it was.
        var seen = {};
        (d.symbols || []).forEach(function (g) { seen[g.symbol] = 1; });
        var n = Object.keys(seen).length;
        set(n
          ? 'connected · ' + n + ' name(s) filled on ' + d.date
            + '. Cards for those names carry the real fill price.'
          : 'connected · no fills on ' + d.date + ' yet. A card gets a fill line'
            + ' on the days its name actually traded in this account.',
          n ? '#22c55e' : '#64748b');
      })
      .catch(function (err) {
        set('the desk did not answer on port ' + ALERTS_PORT + ' ('
          + (err && err.message ? err.message : 'no reason given')
          + '). Nothing on these cards comes from the broker.', '#ef4444');
      });
  }

  /* One line, appended to a card, saying what the account really did.
   *
   * `desk` is the desk's own ledger row for this name on this day, when there
   * is one — see plannedOf().
   */
  function fillLine(g, t, desk) {
    var el = document.createElement('div');
    el.className = 'jnl-fill-line';
    el.style.cssText = 'font-size:11px;color:#94a3b8;margin-top:4px;'
      + 'border-top:1px dashed #334155;padding-top:4px';

    var bits = [];
    if (g.avgBuy != null) bits.push('bought ' + g.bought + ' @ ' + g.avgBuy);
    if (g.avgSell != null) bits.push('sold ' + g.sold + ' @ ' + g.avgSell);
    if (g.closed) bits.push('realised ' + money(g.realised));
    else bits.push('STILL OPEN at Alpaca');

    /*
     * THE COMPARISON, AND THE PRICE IT HAS TO BE AGAINST.
     *
     * This read `t.entryPrice` — the JOURNAL's entry — and the journal's entry
     * is computed FROM the Alpaca fill (src/broker/journalTrades.js:
     * entryCost / entryQty). So for every trade the desk placed it compared
     * the fill against itself and printed
     *
     *     vs 174.21 planned: +0.00
     *
     * on every card, every day, whatever happened. The one mismatch this desk
     * accepts between live and a backtest is execution delay, and this is the
     * only thing that measures it.
     *
     * The planned price is the DESK's: pick.plan.entry, the decision bar's
     * close, written to the ledger when the order was sent and now carried out
     * by /api/broker/setups. 2026-09-15: BLSH decided at 36.03, filled at
     * 35.86 — seventeen cents, which this used to call zero.
     *
     * A HAND-TYPED TRADE STILL USES ITS OWN. There the journal's entry really
     * is what was intended, typed by a person before the fill existed, so the
     * comparison is real. `origin` says which, because two numbers with the
     * same label and different provenance is how this went wrong.
     */
    var planned = desk && desk.planned > 0 ? Number(desk.planned) : null;
    var want = planned != null ? planned : Number(t.entryPrice);
    var origin = planned != null ? 'decided' : 'planned';
    var got = Number(g.avgBuy != null && t.side !== 'short' ? g.avgBuy : g.avgSell);
    if (want > 0 && got > 0) {
      var raw = got - want;
      var slip = t.side === 'short' ? -raw : raw;      // + is worse, either way
      var line = 'vs ' + want + ' ' + origin
        + (desk && desk.decisionBar ? ' on ' + desk.decisionBar : '')
        + ': ' + money(slip);
      /*
       * IN R, WHEN THE STOP IS KNOWN. Seventeen cents is meaningless until you
       * know the stop was twenty-four away — that is two thirds of the risk on
       * the trade, and the same seventeen cents on a $2 stop is nothing.
       */
      var stop = desk && desk.plannedStop > 0 ? Number(desk.plannedStop) : null;
      if (stop != null && Math.abs(want - stop) > 1e-9) {
        line += ' (' + (slip / Math.abs(want - stop)).toFixed(2) + 'R)';
      }
      bits.push(line);
    }

    /*
     * WHICH ACCOUNT PAID IT. Only when the desk said — a single-account desk
     * has nothing to disambiguate and a label there is noise. With two, a
     * fill price with no account on it is a number you cannot check.
     */
    el.textContent = 'Alpaca' + (g.account ? ' (' + g.account + ')' : '')
      + ' — ' + bits.join(' · ');
    return el;
  }

  /* ── the chart link ───────────────────────────────────────────────────
   * Times: the page holds entryTs/exitTs in MILLISECONDS (it builds them with
   * Date.parse), while chart bars are keyed in SECONDS. Getting this wrong
   * puts the arrows in 1970, off the left edge, where they read as "no marks
   * were drawn" rather than as a bug.
   */
  function chartUrl(t) {
    var sec = function (ms) { return ms ? Math.round(ms / 1000) : null; };
    var trade = {
      symbol: t.ticker, date: t.date, side: t.side,
      entry: t.entryPrice, exit: t.exitPrice,
      entry_ts: sec(t.entryTs), exit_ts: sec(t.exitTs),
    };
    var qs = new URLSearchParams({
      pairs: t.ticker + ',' + t.date,
      tf: '1m', feed: 'polygon',
      days_before: '0', days_after: '0',
      cols: '1', height: '520',
      trades: JSON.stringify([trade]),
    });
    return 'http://' + location.hostname + ':' + QP_PORT
         + '/api/pairs/print?' + qs.toString();
  }

  /* ── the setup tag, filled by the desk that placed the order ──────────
   *
   * Attempted at most once per trade per page load, and the mark goes down
   * BEFORE the request rather than after: the list re-renders on every
   * keystroke in the ticker filter, and a mark written on success would let a
   * slow PATCH be issued once per letter typed.
   */
  var tagged = {};

  function optionFor(sel, id) {
    for (var i = 0; i < sel.options.length; i++) {
      if (sel.options[i].value === id) return sel.options[i];
    }
    return null;
  }

  /*
   * The page renders each card from its own copy of the trade, so the tag has
   * to land on the objects as well as on the control — otherwise the next
   * render, which is the next keystroke, draws it untagged again and this runs
   * a second time. loadAll() would do it properly and also destroy and rebuild
   * the whole list under our feet, on a timer we do not control.
   */
  function markTagged(id, setupId, setupName) {
    [window.__trades, window.__allTrades].forEach(function (arr) {
      (arr || []).forEach(function (t) {
        if (t.id !== id) return;
        t.setup_id = setupId;
        if ('setup' in t) t.setup = setupName || setupId;
      });
    });
  }

  function note(sel, text, colour) {
    if (sel.parentNode.querySelector('.jnl-setup-note')) return;
    var s = document.createElement('span');
    s.className = 'jnl-setup-note';
    s.style.cssText = 'font-size:9px;color:' + (colour || '#64748b') + ';white-space:nowrap';
    s.textContent = text;
    sel.parentNode.appendChild(s);
  }

  function autoTag(host) {
    host.querySelectorAll('.jnl-setup-sel').forEach(function (sel) {
      var id = sel.getAttribute('data-id');
      // NEVER OVERWRITE. A tag already chosen — by a person or by an earlier
      // pass of this — is the answer, and this has nothing to add to it.
      if (!id || sel.value || tagged[id]) return;
      var t = findTrade(id);
      if (!t || !t.ticker || !t.date) return;

      deskSetupsFor(t.date).then(function (map) {
        var g = map[String(t.ticker).toUpperCase()];
        // The desk sent nothing for that name that day: a trade taken by hand,
        // or one from before any of this. Left for a person, silently.
        if (!g) return;

        if (g.ambiguous) {
          return note(sel, 'two setups took this name that day — tag it yourself', '#f59e0b');
        }
        /*
         * The id has to be one the journal can actually display. Its list comes
         * from the same /api/setups this desk serves, so a miss means the setup
         * was renamed or removed since the order went out — and storing an id
         * with no option would show "— untagged —" over a tagged row for ever.
         */
        if (!optionFor(sel, g.setupId)) {
          return note(sel, 'the desk says ' + g.setupId + ', which is not in this list', '#f59e0b');
        }
        // It may have been chosen, or tagged, while the request was in flight.
        if (sel.value || tagged[id]) return;
        tagged[id] = true;

        fetch('/api/journal/trades/' + encodeURIComponent(id), {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ setup_id: g.setupId }),
        }).then(function (r) {
          if (!r.ok) throw new Error('the journal said ' + r.status);
          sel.value = g.setupId;
          markTagged(id, g.setupId, g.setupName);
          note(sel, 'from the desk', '#22c55e');
        }).catch(function (err) {
          // Let it be tried again on the next render rather than losing the tag
          // silently — and say which one failed.
          tagged[id] = false;
          note(sel, 'could not tag: ' + (err && err.message || err), '#ef4444');
        });
      });
    });
  }

  function findTrade(id) {
    var all = (window.__trades || []).concat(window.__allTrades || []);
    for (var i = 0; i < all.length; i++) if (all[i].id === id) return all[i];
    return null;
  }

  /* ── delete, without a browser dialog ─────────────────────────────────
   * Capture phase and stopImmediatePropagation, so the page's own confirm()
   * handler never runs. Rebinding is not an option — its listener is
   * anonymous and cannot be removed.
   */
  function onDeleteClick(ev) {
    var btn = ev.target.closest && ev.target.closest('.jnl-del-btn');
    if (!btn) return;
    ev.preventDefault();
    ev.stopImmediatePropagation();

    if (btn.dataset.arm !== '1') {          // first tap: arm it
      btn.dataset.arm = '1';
      btn.dataset.was = btn.textContent;
      btn.textContent = 'delete?';
      btn.style.color = '#ef4444';
      btn.style.borderColor = '#ef4444';
      setTimeout(function () {              // disarm if it was a stray tap
        if (btn.dataset.arm === '1') {
          btn.dataset.arm = '';
          btn.textContent = btn.dataset.was || '🗑';
          btn.style.color = ''; btn.style.borderColor = '';
        }
      }, 4000);
      return;
    }

    var id = btn.getAttribute('data-id');
    btn.textContent = '…';
    fetch('/api/journal/trades/' + encodeURIComponent(id), { method: 'DELETE' })
      .then(function (r) {
        if (!r.ok) throw new Error('server said ' + r.status);
        return typeof window.loadAll === 'function' ? window.loadAll() : location.reload();
      })
      .catch(function (err) {
        // The failure the original swallowed. Say it, and leave the row alone.
        btn.textContent = 'failed';
        btn.title = String(err && err.message || err);
        btn.style.color = '#f59e0b';
      });
  }
  /* ── ONE ACCOUNT, OR ALL OF THEM — AND THE PAGE ALREADY HAD IT ────────
   *
   * This file used to add a row of account buttons above the trades list.
   * Deleted, because the page has its own account filter and always did:
   *
   *     public/journal.html:101   <select id="filter-account">
   *
   * It is populated from every trade's `account`, and on change it calls
   * applyScope() + renderAll() — so it filters the CALENDAR, the stats, the
   * risk tab and the setups tab as well as the cards. The bar added here
   * filtered only the cards on one tab, by hiding them.
   *
   * So the desk had two account filters stacked in the same header, one of
   * them weaker, and the report was exactly that: "the filters are double and
   * they don't even work". Two controls for one question is the bug; making
   * the second one correct would only have made it a tidier bug.
   *
   * WHY IT WAS ADDED AT ALL, so it does not come back. The complaint was "I
   * can't filter using accounts in the main existing filters" — and that was
   * true, but not because the control was missing. Trades carried no account:
   * src/alerts/server.js stamps one only when the desk can read more than one
   * account (`readable.length > 1 ? id : null`), so with a single readable
   * account every row said nothing and the dropdown had one entry. The empty
   * control was a DATA problem wearing a UI problem's clothes, and the fix
   * belonged where the data is written.
   *
   * WHAT IS KEPT is accountsKnown(): the accounts the DESK has, from
   * /api/broker. The page's dropdown is built from trades on screen, so an
   * account that has not traded today is missing from it — and that is exactly
   * the morning you want to look: 2026-09-08, every order to alpaca2 refused
   * for buying power, one account with rows and two accounts to tell apart.
   * Those are merged INTO the page's own select below, rather than beside it.
   */

  /*
   * Every account the desk has, added to the page's own account filter.
   *
   * ADDED, NEVER REBUILT. The page fills that select itself on every load and
   * keeps the current selection; replacing its innerHTML here would be a
   * second writer to one control, and the two would disagree the first time a
   * trade arrived. So this only appends the ids the select is missing, and
   * labels them with the desk's name for the account.
   */
  function mergeAccountsIntoFilter() {
    var sel = document.getElementById('filter-account');
    if (!sel) return;
    var known = accountsKnown();
    if (known.length < 2) return;        // nothing to tell apart
    var have = {};
    Array.prototype.slice.call(sel.options).forEach(function (o) {
      have[o.value] = o;
    });
    known.forEach(function (a) {
      /*
       * THE ID IS THE VALUE, because that is what every trade carries
       * (src/alerts/server.js: tradesFrom(r.fills, id)) and what the page
       * compares against. The NAME is only the label. Keying on the name is
       * what produced four buttons for two accounts, half of them inert.
       */
      var label = a.name === a.id ? a.id : a.name + ' \u00b7 ' + a.id;
      if (have[a.id]) {
        // Already there, built from a trade — give it the readable name.
        if (have[a.id].textContent !== label) have[a.id].textContent = label;
        return;
      }
      var o = document.createElement('option');
      o.value = a.id;
      o.textContent = label;
      sel.appendChild(o);
    });
  }

  /* ── the button, added to every card ──────────────────────────────────
   * A MutationObserver rather than a one-off pass: the list re-renders on
   * every filter, sort and delete, and each render replaces the innerHTML —
   * anything added once would survive exactly until the first keystroke in
   * the ticker filter.
   */
  function decorate() {
    var host = document.getElementById(CONTAINER);
    if (!host) return;
    host.querySelectorAll('.jnl-del-btn').forEach(function (del) {
      if (del.previousElementSibling
          && del.previousElementSibling.classList.contains('jnl-chart-btn')) return;
      var t = findTrade(del.getAttribute('data-id'));
      if (!t || !t.ticker || !t.date) return;
      var a = document.createElement('a');
      a.className = 'jnl-chart-btn';
      a.href = chartUrl(t);
      a.target = '_blank';
      a.rel = 'noopener';
      a.textContent = '📈';
      a.title = t.ticker + ' ' + t.date + ' — entry to exit, with indicators';
      a.style.cssText = 'font-size:11px;padding:2px 7px;background:#1e293b;'
        + 'color:#94a3b8;border:1px solid #334155;border-radius:5px;'
        + 'text-decoration:none;line-height:1.6';
      del.parentNode.insertBefore(a, del);
    });

    /*
     * The fill line. Added per card and keyed off the card's own date, because
     * the list can show several days at once and one day's fills say nothing
     * about another's.
     */
    host.querySelectorAll('.jnl-del-btn').forEach(function (del) {
      var t = findTrade(del.getAttribute('data-id'));
      if (!t || !t.ticker || !t.date) return;
      var card = del.closest('.jnl-card') || del.parentNode.parentNode;
      if (!card || card.querySelector('.jnl-fill-line')) return;
      card.setAttribute('data-fills-pending', '1');
      fillsFor(t.date).then(function (map) {
        var groups = map[String(t.ticker).toUpperCase()];
        // Nothing at Alpaca for that name on that day — a TTP-only trade, or a
        // day before the account existed. Silence, not a zero.
        if (!groups || !groups.length) return;
        if (card.querySelector('.jnl-fill-line')) return;
        /*
         * THE TRADE'S OWN ACCOUNT WHEN IT HAS ONE. An imported trade carries
         * the account that made it; a hand-typed one does not.
         *
         * With no account on the trade and the name filled in BOTH accounts,
         * there is no way to say which line belongs to this card — so both are
         * shown, each labelled, rather than one picked. Picking would put the
         * other account's price on this trade and it would look right.
         */
        var mine = t.account
          ? groups.filter(function (g) { return g.account === t.account; })
          : groups;
        var show = mine.length ? mine : groups;
        // THE DESK'S LEDGER ROW for this name and day, for the planned price.
        // Already cached per date, so this costs no extra request. A trade the
        // desk did not place resolves to nothing and the line falls back to
        // the journal's own entry, which for a typed trade is correct.
        deskSetupsFor(t.date).then(function (bySym) {
          var desk = bySym[String(t.ticker).toUpperCase()] || null;
          if (card.querySelector('.jnl-fill-line')) return;
          show.forEach(function (g) {
            card.appendChild(fillLine(g, t, desk));
          });
        });
      });
    });

    appBar();
    autoTag(host);
    statusLine();
    mergeAccountsIntoFilter();
    importButton();
    fixDashboardLink();
  }

  function start() {
    // Asked once, in the background — see loadAccountsKnown. The filter draws
    // from the trades straight away and widens when the desk answers.
    loadAccountsKnown();
    document.addEventListener('click', onDeleteClick, true);   // capture
    var host = document.getElementById(CONTAINER);
    if (host) new MutationObserver(decorate).observe(host, { childList: true });
    decorate();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
