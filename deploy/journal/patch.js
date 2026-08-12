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
 */
(function () {
  'use strict';

  var QP_PORT = 8765;                 // the chart platform, same host
  var CONTAINER = 'jnl-cards-container';

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
