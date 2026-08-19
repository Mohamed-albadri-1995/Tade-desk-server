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
