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
  return el;
}

/**
 * A page with `trades` rendered as cards, then the patch evaluated over it.
 * Returns the handles the assertions need.
 */
function page(trades) {
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

  const byId = { 'jnl-cards-container': container };
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
    fetch: () => Promise.resolve({ json: () => Promise.resolve({ ok: false }) }),
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
  return { ctx, doc, container, cards, bar: () => byId['jnl-acct-bar'] || null };
}

const T = (id, account) => ({ id, ticker: 'WULF', date: '2026-09-01', account });

describe('the account bar', () => {
  /*
   * NOTHING IS DRAWN FOR ONE ACCOUNT. A filter with a single option can only do
   * nothing, and on a one-account desk the trades carry no account at all — so
   * a chooser would imply there is something to choose between.
   */
  test('one account: no bar at all', () => {
    const p = page([T('1', null), T('2', null)]);
    expect(p.bar()).toBeNull();
  });

  test('two accounts: a bar appears', () => {
    const p = page([T('1', 'paperA'), T('2', 'paperB')]);
    expect(p.bar()).not.toBeNull();
  });

  test('it offers ALL plus one button per account, all first', () => {
    const p = page([T('1', 'paperB'), T('2', 'paperA')]);
    const labels = p.bar().querySelectorAll('button[data-acct]')
      .map(b => b.getAttribute('data-acct'));
    // 'all' leads: the combined book answers "how is the desk doing", and one
    // account is the exception you ask for.
    expect(labels).toEqual(['all', 'paperA', 'paperB']);
  });

  // BUILT FROM THE TRADES ON SCREEN. Add an account at the desk and it appears
  // the first time it trades — nothing to register in the journal as well.
  test('an account nobody traded gets no button', () => {
    const p = page([T('1', 'paperA')]);
    expect(p.bar()).toBeNull();
  });
});

describe('what the filter actually does', () => {
  test('everything is visible to begin with', () => {
    const p = page([T('1', 'paperA'), T('2', 'paperB')]);
    expect(p.cards.map(c => c.style.display)).toEqual(['', '']);
  });

  test('picking one account hides the other', () => {
    const p = page([T('1', 'paperA'), T('2', 'paperB')]);
    const btn = p.bar().querySelectorAll('button[data-acct]')
      .find(b => b.getAttribute('data-acct') === 'paperB');
    btn.click();
    expect(p.cards[0].style.display).toBe('none');
    expect(p.cards[1].style.display).toBe('');
  });

  test('and ALL brings them back', () => {
    const p = page([T('1', 'paperA'), T('2', 'paperB')]);
    const by = (id) => p.bar().querySelectorAll('button[data-acct]')
      .find(b => b.getAttribute('data-acct') === id);
    by('paperA').click();
    expect(p.cards[1].style.display).toBe('none');
    by('all').click();
    expect(p.cards.map(c => c.style.display)).toEqual(['', '']);
  });

  test('the count says how many are showing, and where', () => {
    const p = page([T('1', 'paperA'), T('2', 'paperA'), T('3', 'paperB')]);
    const by = (id) => p.bar().querySelectorAll('button[data-acct]')
      .find(b => b.getAttribute('data-acct') === id);
    by('paperA').click();
    const count = p.bar().children.find(c => c.id === 'jnl-acct-count');
    expect(count.textContent).toBe('2 trade(s) in paperA');
    by('all').click();
    expect(count.textContent).toBe('3 trade(s)');
  });

  // A trade with NO account — typed in by hand, or imported before accounts
  // existed — belongs to no account and must not vanish from the combined view.
  test('an untagged trade shows under ALL and under neither account', () => {
    const p = page([T('1', 'paperA'), T('2', 'paperB'), T('3', null)]);
    const by = (id) => p.bar().querySelectorAll('button[data-acct]')
      .find(b => b.getAttribute('data-acct') === id);
    expect(p.cards[2].style.display).toBe('');
    by('paperA').click();
    expect(p.cards[2].style.display).toBe('none');
    by('all').click();
    expect(p.cards[2].style.display).toBe('');
  });
});

describe('where the bar lives', () => {
  /*
   * OUTSIDE THE CONTAINER, like the status line and for the same reason: the
   * list replaces its own innerHTML on every filter, sort and delete, so a
   * control inside it would survive exactly until the first keystroke.
   */
  test('it is a sibling of the card list, not a child of it', () => {
    const p = page([T('1', 'paperA'), T('2', 'paperB')]);
    expect(p.container.children.some(c => c.id === 'jnl-acct-bar')).toBe(false);
    expect(p.bar().parentNode).toBe(p.container.parentNode);
  });

  test('and it is drawn BEFORE the list', () => {
    const p = page([T('1', 'paperA'), T('2', 'paperB')]);
    const kids = p.container.parentNode.children;
    expect(kids.indexOf(p.bar())).toBeLessThan(kids.indexOf(p.container));
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
