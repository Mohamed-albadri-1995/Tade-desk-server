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

  function fillsFor(date) {
    if (fillsByDate[date]) return fillsByDate[date];
    var url = location.protocol + '//' + location.hostname + ':' + ALERTS_PORT
      + '/api/broker/fills?date=' + encodeURIComponent(date);
    fillsByDate[date] = fetch(url)
      .then(function (r) { return r.json(); })
      .then(function (d) {
        var map = {};
        if (d && d.ok) {
          (d.symbols || []).forEach(function (g) { map[g.symbol] = g; });
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
    a.href = location.protocol + '//' + location.hostname + ':' + LANDING_PORT + '/';
    a.textContent = '← Trade Desk';
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
        var n = (d.symbols || []).length;
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

  /* One line, appended to a card, saying what the account really did. */
  function fillLine(g, t) {
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
     * The comparison, and the reason this exists. Shown only when the journal
     * has an entry price to compare against — and never as a correction: the
     * journal's number is what was intended and Alpaca's is what happened, and
     * both are worth keeping.
     */
    var want = Number(t.entryPrice);
    var got = Number(g.avgBuy != null && t.side !== 'short' ? g.avgBuy : g.avgSell);
    if (want > 0 && got > 0) {
      var raw = got - want;
      var slip = t.side === 'short' ? -raw : raw;      // + is worse, either way
      bits.push('vs ' + want + ' planned: ' + money(slip));
    }

    el.textContent = 'Alpaca — ' + bits.join(' · ');
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
        var g = map[String(t.ticker).toUpperCase()];
        // Nothing at Alpaca for that name on that day — a TTP-only trade, or a
        // day before the account existed. Silence, not a zero.
        if (!g) return;
        if (card.querySelector('.jnl-fill-line')) return;
        card.appendChild(fillLine(g, t));
      });
    });

    autoTag(host);
    statusLine();
    importButton();
    fixDashboardLink();
  }

  function start() {
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
