/*
 * THE JOURNAL, SPLIT BY ACCOUNT.
 *
 * Two Alpaca paper accounts run one setup each, so "how is this strategy doing"
 * and "how is this account doing" are the same question asked twice — and a
 * single undifferentiated list answers neither.
 *
 * The journal page itself lives on a branch with no shared history with this
 * repo, so everything added to it lives in deploy/journal/patch.js. This file
 * EVALUATES that patch against a DOM stub and drives it, rather than grepping
 * it for strings: a source-text test passes on code that could never run, and
 * the filter is real logic with a real off-by-one waiting in it — a remembered
 * choice for an account that no longer exists hides every trade on the page.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'deploy', 'journal', 'patch.js'), 'utf8');

/* ── the smallest DOM the patch needs ─────────────────────────────────── */
function mkEl(tag) {
  const el = {
    tagName: String(tag || 'div').toUpperCase(),
    id: '', className: '', textContent: '', innerHTML: '', href: '', title: '',
    type: '', target: '', rel: '',
    style: { cssText: '', display: '' },
    attrs: {},
    children: [],
    parentNode: null,
    listeners: {},
    classList: {
      _s: new Set(),
      add(c) { this._s.add(c); },
      remove(c) { this._s.delete(c); },
      contains(c) { return this._s.has(c); },
    },
    setAttribute(k, v) { this.attrs[k] = String(v); if (k === 'id') this.id = String(v); },
    getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; },
    removeAttribute(k) { delete this.attrs[k]; },
    appendChild(c) { c.parentNode = this; this.children.push(c); return c; },
    insertBefore(c, ref) {
      c.parentNode = this;
      const i = this.children.indexOf(ref);
      if (i < 0) this.children.push(c); else this.children.splice(i, 0, c);
      return c;
    },
    remove() {
      if (!this.parentNode) return;
      const i = this.parentNode.children.indexOf(this);
      if (i >= 0) this.parentNode.children.splice(i, 1);
      this.parentNode = null;
    },
    addEventListener(ev, fn) { (this.listeners[ev] = this.listeners[ev] || []).push(fn); },
    removeEventListener() {},
    click() { (this.listeners.click || []).forEach(fn => fn({ target: this })); },
    closest(sel) {
      let n = this;
      while (n) {
        if (sel.startsWith('.') && n.classList.contains(sel.slice(1))) return n;
        n = n.parentNode;
      }
      return null;
    },
    querySelector(sel) { return this.querySelectorAll(sel)[0] || null; },
    querySelectorAll(sel) {
      const out = [];
      const want = (n) => {
        if (sel.startsWith('.')) return n.classList.contains(sel.slice(1));
        const m = /^(\w+)\[([\w-]+)\]$/.exec(sel);
        if (m) return n.tagName === m[1].toUpperCase() && n.getAttribute(m[2]) !== null;
        return false;
      };
      const walk = (n) => {
        for (const c of n.children) { if (want(c)) out.push(c); walk(c); }
      };
      walk(this);
      return out;
    },
  };
  /*
   * innerHTML = '' EMPTIES THE ELEMENT, as it does in a browser.
   *
   * It was a plain string field, so a rebuild that clears itself and redraws
   * left the OLD children in place and appended beside them. Every count in
   * this file then measured one render or two depending on whether anything
   * had triggered a second one — and the account bar is rebuilt exactly once,
   * when the desk's answer arrives. A stub that quietly keeps what the code
   * deleted cannot be used to count anything.
   */
  let html = '';
  Object.defineProperty(el, 'innerHTML', {
    get() { return html; },
    set(v) {
      html = String(v === null || v === undefined ? '' : v);
      if (html === '') {
        el.children.forEach((c) => { c.parentNode = null; });
        el.children.length = 0;
      }
    },
  });
  return el;
}

/**
 * A page with `trades` rendered as cards, then the patch evaluated over it.
 * Returns the handles the assertions need.
 */
function page(trades, destinations = null) {
  const root = mkEl('div');
  const container = mkEl('div');
  container.id = 'jnl-cards-container';
  root.appendChild(container);

  const cards = trades.map((t) => {
    const card = mkEl('div');
    card.classList.add('jnl-card');
    const del = mkEl('button');
    del.classList.add('jnl-del-btn');
    del.setAttribute('data-id', t.id);
    card.appendChild(del);
    container.appendChild(card);
    return card;
  });

  /*
   * THE PAGE'S OWN ACCOUNT FILTER — public/journal.html:101. It is the whole
   * point of this file now: the patch no longer draws a control of its own, it
   * adds the desk's accounts to this one.
   *
   * `options` is the live list of <option> children, as a browser's is.
   */
  const select = mkEl('select');
  select.id = 'filter-account';
  Object.defineProperty(select, 'options', { get() { return select.children; } });
  const opt = (value, text) => {
    const o = mkEl('option');
    o.value = value;
    o.textContent = text;
    select.appendChild(o);
    return o;
  };
  // The page fills it from the accounts the TRADES carry, exactly as
  // journal.html does, before the patch ever runs.
  opt('', 'All accounts');
  [...new Set(trades.map(t => t && t.account).filter(Boolean))].sort()
    .forEach(a => opt(a, a));
  root.appendChild(select);

  const byId = { 'jnl-cards-container': container, 'filter-account': select };
  const doc = {
    getElementById: (id) => byId[id] || null,
    createElement: (tag) => mkEl(tag),
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() {},
    readyState: 'complete',
    body: root,
  };
  // Anything the patch creates and later looks up by id has to be findable.
  const origAppend = root.appendChild.bind(root);
  const track = (el) => { if (el && el.id) byId[el.id] = el; return el; };
  container.parentNode = root;
  root.insertBefore = function (c, ref) {
    c.parentNode = root;
    const i = root.children.indexOf(ref);
    if (i < 0) root.children.push(c); else root.children.splice(i, 0, c);
    track(c);
    // Children added to the bar afterwards need tracking too.
    const origChildAppend = c.appendChild.bind(c);
    c.appendChild = (x) => { origChildAppend(x); track(x); return x; };
    return c;
  };
  root.appendChild = (c) => track(origAppend(c));

  const ctx = {
    document: doc,
    window: null,
    location: { protocol: 'http:', hostname: 'localhost' },
    // The patch fetches fills, setups and a status probe. None of that is what
    // this file is about, so every request answers "nothing", which is a real
    // answer the patch already has to handle.
    /*
     * EVERY REQUEST ANSWERS "nothing" BY DEFAULT — fills, setups, the status
     * probe — which is a real answer the patch already has to handle.
     *
     * EXCEPT /api/broker, when a test supplies destinations. Every test in
     * this file used to answer ok:false here, so `acctsKnown` was always empty
     * and the desk's own account list was NEVER EXERCISED. That is the blind
     * spot the four-button bar grew in: the merge between what the desk knows
     * and what the trades show only ever ran on one of its two inputs.
     */
    fetch: (url) => Promise.resolve({
      json: () => Promise.resolve(
        (destinations && String(url).indexOf('/api/broker') !== -1)
          ? { ok: true, broker: { destinations } }
          : { ok: false }),
    }),
    MutationObserver: function () { this.observe = () => {}; },
    setTimeout, clearTimeout, console,
    // The chart button builds a query string; not what this file is about, but
    // the patch is one IIFE and everything in it runs.
    URLSearchParams, encodeURIComponent, Date, JSON, Math, Object, Array, String,
    Number, Boolean, Set, Promise, isNaN, parseFloat, parseInt,
    __trades: trades,
    __allTrades: trades,
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx, { filename: 'patch.js' });
  return {
    ctx, doc, container, cards, select,
    /** [value, label] for every option, in order. */
    options: () => select.children.map(o => [o.value, o.textContent]),
  };
}

const T = (id, account) => ({ id, ticker: 'WULF', date: '2026-09-01', account });

/*
 * THE PATCH NO LONGER DRAWS AN ACCOUNT FILTER, and these tests changed with it.
 *
 * They used to drive `#jnl-acct-bar` — a row of buttons this file added above
 * the trades list. It is gone. public/journal.html:101 has always carried
 *
 *     <select id="filter-account">
 *
 * populated from every trade's `account`, and on change it runs applyScope()
 * and renderAll() — so it filters the calendar, the stats, the risk tab and
 * the setups tab as well as the cards. The bar filtered only the cards, by
 * hiding them, on one tab.
 *
 * Two controls for one question, one of them weaker, in the same header. The
 * report was exactly that: "the filters are double and they don't even work".
 *
 * The one thing the bar had that the select does not is the accounts the DESK
 * knows — the select is built from trades on screen, so an account that has
 * not traded today is missing from it, and that is precisely the morning worth
 * looking at (2026-09-08: every order to alpaca2 refused, one account with
 * rows and two to tell apart). So those are merged INTO the select.
 */

describe('the desk\'s accounts are added to the page\'s own filter', () => {
  const DESK = [{ id: 'alpaca1', name: 'alpaca100k935' },
                { id: 'alpaca2', name: 'Alpaca100ktest' }];
  const settled = () => new Promise((r) => setTimeout(r, 0));

  test('no second control is drawn', async () => {
    const p = page([T('1', 'alpaca1'), T('2', 'alpaca2')], DESK);
    await settled();
    expect(p.doc.getElementById('jnl-acct-bar')).toBeNull();
  });

  /*
   * ONE ENTRY PER ACCOUNT. Two accounts and four options was the original
   * complaint, and it came from keying on the NAME while trades carry the ID.
   */
  test('two accounts give two entries beside All, not four', async () => {
    const p = page([T('1', 'alpaca1'), T('2', 'alpaca2')], DESK);
    await settled();
    expect(p.options().map(o => o[0])).toEqual(['', 'alpaca1', 'alpaca2']);
  });

  /*
   * THE ID IS THE VALUE. It is what every trade carries and what the page
   * compares against; the name is only what a person reads.
   */
  test('the value is the id and the label carries the name', async () => {
    const p = page([T('1', 'alpaca1'), T('2', 'alpaca2')], DESK);
    await settled();
    expect(p.options()).toEqual([
      ['', 'All accounts'],
      ['alpaca1', 'alpaca100k935 \u00b7 alpaca1'],
      ['alpaca2', 'Alpaca100ktest \u00b7 alpaca2'],
    ]);
  });

  test('an account whose name IS its id is not written twice', async () => {
    const p = page([T('1', 'alpaca1'), T('2', 'alpaca2')],
                   [{ id: 'alpaca1', name: 'alpaca1' }, { id: 'alpaca2', name: 'alpaca2' }]);
    await settled();
    expect(p.options()[1]).toEqual(['alpaca1', 'alpaca1']);
  });

  /*
   * THE ACCOUNT THAT HAS NOT TRADED TODAY. The page cannot know about it — it
   * builds the list from trades — and it is the one the desk most needs on a
   * morning where that account's orders were all refused.
   */
  test('a known account with no trades on screen is added', async () => {
    const p = page([T('1', 'alpaca1')], DESK);
    await settled();
    expect(p.options().map(o => o[0])).toEqual(['', 'alpaca1', 'alpaca2']);
  });

  /*
   * AND AN ACCOUNT ONLY THE TRADES KNOW IS LEFT ALONE. An imported row or a
   * retired destination must keep its entry, or its trades hide behind a
   * filter that never lists them.
   */
  test('an id only the trades know keeps its own entry', async () => {
    const p = page([T('1', 'alpaca1'), T('2', 'ttp5k')], DESK);
    await settled();
    expect(p.options().map(o => o[0])).toEqual(['', 'alpaca1', 'ttp5k', 'alpaca2']);
  });

  /*
   * NEVER REBUILT, ONLY ADDED TO. The page fills this select itself on every
   * load and keeps the current selection. Replacing its contents here would be
   * a second writer to one control.
   */
  test('the options the page made are kept, not replaced', async () => {
    const p = page([T('1', 'alpaca1'), T('2', 'alpaca2')], DESK);
    const before = p.select.children[0];
    await settled();
    expect(p.select.children[0]).toBe(before);
    expect(p.options()[0]).toEqual(['', 'All accounts']);
  });

  test('a destination carrying no id is not added', async () => {
    const p = page([T('1', 'alpaca1'), T('2', 'alpaca2')],
                   DESK.concat([{ name: 'a name with no id' }]));
    await settled();
    expect(p.options().map(o => o[0])).toEqual(['', 'alpaca1', 'alpaca2']);
  });

  /*
   * A ONE-ACCOUNT DESK IS LEFT COMPLETELY ALONE. There is nothing to tell
   * apart, and relabelling a lone entry is noise.
   */
  test('one account at the desk changes nothing', async () => {
    const p = page([T('1', null), T('2', null)], [{ id: 'alpaca1', name: 'only' }]);
    await settled();
    expect(p.options()).toEqual([['', 'All accounts']]);
  });

  test('a desk that did not answer leaves the page untouched', async () => {
    const p = page([T('1', 'alpaca1'), T('2', 'alpaca2')], null);
    await settled();
    expect(p.options()).toEqual([
      ['', 'All accounts'], ['alpaca1', 'alpaca1'], ['alpaca2', 'alpaca2'],
    ]);
  });
});

describe('the source contract the desk depends on', () => {
  // The trades carry the account because the desk stamps it — see
  // src/broker/journalTrades.js. If that stopped, the bar would silently never
  // appear again, so the two are named together here.
  test('the filter reads the trade\'s own account field', () => {
    expect(SRC).toMatch(/t\.account/);
  });

  test('...and the desk stamps it onto every imported trade', () => {
    const jt = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'broker', 'journalTrades.js'), 'utf8');
    expect(jt).toMatch(/account: t\.account \|\| null/);
  });

  /*
   * THE ACCOUNT IS PART OF THE TRADE'S ID. Two accounts trade the same name on
   * the same day — that is the point of running them side by side — and the
   * fallback id is symbol:timestamp. Colliding means the second import
   * OVERWRITES the first: one account's trade silently replaced by the other's.
   */
  test('and it is part of the id, so two accounts cannot overwrite each other', () => {
    const { tradesFrom } = require('../src/broker/journalTrades');
    const fills = [{ id: null, symbol: 'WULF', side: 'buy', qty: 10, price: 10,
                     at: '2026-09-01T13:36:00Z', type: 'fill' }];
    const a = tradesFrom(fills, 'paperA')[0];
    const b = tradesFrom(fills, 'paperB')[0];
    expect(a.extId).not.toBe(b.extId);
    expect(a.extId).toContain('paperA');
  });

  // A SINGLE-ACCOUNT DESK IS UNCHANGED: no account passed, no account stamped,
  // and the importer's existing 'Alpaca' default still applies.
  test('one account still produces the id it always did', () => {
    const { tradesFrom } = require('../src/broker/journalTrades');
    const t = tradesFrom([{ id: 'f1', symbol: 'WULF', side: 'buy', qty: 10,
                            price: 10, at: '2026-09-01T13:36:00Z', type: 'fill' }])[0];
    expect(t.extId).toBe('alpaca:f1');
    expect(t.account).toBeNull();
  });
});
