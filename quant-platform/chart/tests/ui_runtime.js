/* Runtime smoke test for chart/static/index.html.
 *
 * `node --check` only PARSES. It cannot see the bug class that actually ships:
 * a helper declared with `const` inside one function and called from another
 * (a ReferenceError only at click time), a typo'd identifier, a function used
 * before its scope exists. This evaluates the page's real script against a
 * minimal DOM stub and then CALLS the handlers a user clicks.
 *
 * Deliberately not jsdom: no dependency, and the point is to catch missing
 * identifiers, not to render.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const html = fs.readFileSync(
  path.join(__dirname, '..', 'static', 'index.html'), 'utf8');
const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)]
  .map(m => m[1]);
if (!scripts.length) { console.log('  FAIL no inline script found'); process.exit(1); }

let PASS = 0, FAIL = 0;
const ok = (name, cond, extra) => {
  if (cond) { PASS++; console.log('  ok   ' + name); }
  else { FAIL++; console.log('  FAIL ' + name + (extra ? ' ' + extra : '')); }
};

// ── the smallest DOM that lets the page's top level evaluate ──────────────
const mkEl = (id) => {
  const el = {
    id, value: '', textContent: '', innerHTML: '', title: '', src: '',
    disabled: false, checked: false, dataset: {}, children: [],
    style: { cssText: '', setProperty() {}, display: '' },
    classList: { _s: new Set(),
      add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); },
      toggle(c, f) { const on = f === undefined ? !this._s.has(c) : !!f;
        on ? this._s.add(c) : this._s.delete(c); return on; },
      contains(c) { return this._s.has(c); } },
    appendChild(c) { this.children.push(c); return c; },
    removeChild() {}, remove() {}, insertBefore(c) { this.children.push(c); return c; },
    addEventListener() {}, removeEventListener() {}, click() {},
    setAttribute() {}, getAttribute() { return null; }, focus() {},
    getBoundingClientRect: () => ({ width: 800, height: 400, top: 0, left: 0 }),
    querySelector: () => mkEl('q'), querySelectorAll: () => [],
    clientWidth: 800, clientHeight: 400, scrollTop: 0, offsetHeight: 400,
  };
  return el;
};
const els = {};
const doc = {
  getElementById: (id) => (els[id] = els[id] || mkEl(id)),
  createElement: (t) => mkEl(t),
  querySelector: () => mkEl('q'), querySelectorAll: () => [],
  addEventListener() {}, body: mkEl('body'),
  documentElement: mkEl('html'), head: mkEl('head'),
};
doc.body.classList.toggle = mkEl('b').classList.toggle;

const store = {};
const win = {
  document: doc, innerWidth: 1200, innerHeight: 800,
  location: { protocol: 'http:', host: 'x', href: 'http://x/' },
  localStorage: { getItem: (k) => (k in store ? store[k] : null),
                  setItem: (k, v) => { store[k] = String(v); },
                  removeItem: (k) => { delete store[k]; } },
  addEventListener() {}, setTimeout: () => 0, clearTimeout() {},
  setInterval: () => 0, clearInterval() {}, requestAnimationFrame: () => 0,
  fetch: () => Promise.resolve({ json: () => Promise.resolve({ ok: true }),
                                 blob: () => Promise.resolve({}),
                                 headers: { get: () => '' } }),
  alert() {}, confirm: () => true, open() {}, print() {},
  Notification: function () {}, URL: { createObjectURL: () => 'blob:x',
                                       revokeObjectURL() {} },
  Intl, JSON, Math, Date, console, Promise, Error, Object, Array, String,
  Number, Boolean, Set, Map, RegExp, isNaN, parseFloat, parseInt,
  encodeURIComponent, decodeURIComponent, URLSearchParams, TextEncoder,
  Blob: function () {}, FormData: function () {}, WebSocket: function () {},
  ResizeObserver: function () { this.observe = () => {}; },
  AudioContext: function () { this.createOscillator = () => ({
    connect() {}, start() {}, stop() {}, frequency: { value: 0 } });
    this.createGain = () => ({ connect() {}, gain: { value: 0,
      setValueAtTime() {}, exponentialRampToValueAtTime() {} } });
    this.destination = {}; this.currentTime = 0; },
};
win.window = win;
win.Notification.permission = 'granted';
win.Notification.requestPermission = () => Promise.resolve('granted');

// the charting library, stubbed to the calls the page makes
const series = () => ({ setData() {}, update() {}, applyOptions() {},
                        setMarkers() {}, priceScale: () => ({ applyOptions() {} }),
                        createPriceLine: () => ({}), removePriceLine() {} });
win.LightweightCharts = {
  createChart: () => ({
    addCandlestickSeries: series, addLineSeries: series, addAreaSeries: series,
    addBarSeries: series, addHistogramSeries: series, addBaselineSeries: series,
    applyOptions() {}, remove() {}, removeSeries() {},
    priceScale: () => ({ applyOptions() {} }),
    timeScale: () => ({ fitContent() {}, setVisibleRange() {},
                        scrollToPosition() {}, getVisibleRange: () => null }),
    subscribeCrosshairMove() {}, unsubscribeCrosshairMove() {},
  }),
  CrosshairMode: { Normal: 0 }, LineStyle: { Dotted: 1, Dashed: 2, Solid: 0 },
  ColorType: { Solid: 'solid' },
};

const ctx = vm.createContext(win);
console.log('='.repeat(64));
console.log('index.html evaluates and its click handlers RUN (no ReferenceError)');
console.log('='.repeat(64));
try {
  vm.runInContext(scripts.join('\n;\n'), ctx, { filename: 'index.html' });
  ok('the page script evaluates end to end', true);
} catch (e) {
  ok('the page script evaluates end to end', false, e.message);
  console.log('\nRESULT  PASS=' + PASS + '  FAIL=' + FAIL);
  process.exit(1);
}

// Every function a user can reach by clicking must EXIST at top level.
for (const fn of ['loadChart', 'pickStock', 'toggleDrawer', '_resizeChart',
                  'jumpToDate', 'loadSources', 'fillRegPicker', 'loadRegister',
                  'loadRegDates', 'renderRegister', 'toggleLive', 'initChart',
                  'drawSnapshot', 'syncAsofUI', 'btRefresh', 'btRenderCore',
                  '_syncViewportHeight']) {
  ok('`' + fn + '` is defined at top level', typeof ctx[fn] === 'function',
     'got ' + typeof ctx[fn]);
}

// ...and actually run without throwing. toggleDrawer is the one that shipped
// broken: it calls a helper that used to live inside the load handler.
try { ctx.toggleDrawer(); ctx.toggleDrawer(); ok('toggleDrawer() runs (open + close)', true); }
catch (e) { ok('toggleDrawer() runs (open + close)', false, e.message); }
try { ctx._resizeChart(); ok('_resizeChart() runs', true); }
catch (e) { ok('_resizeChart() runs', false, e.message); }
// jumpToDate with no bars loaded must answer false, not throw
try { ok('jumpToDate() is safe with no data', ctx.jumpToDate('2026-07-16') === false); }
catch (e) { ok('jumpToDate() is safe with no data', false, e.message); }
try { ctx.syncAsofUI(); ok('syncAsofUI() runs', true); }
catch (e) { ok('syncAsofUI() runs', false, e.message); }
try { ctx.fillRegPicker(doc.getElementById('regReg'),
        [{ value: 'a:R1', label: 'R1 — A' }], 'a:R1');
      ok('fillRegPicker() runs', true); }
catch (e) { ok('fillRegPicker() runs', false, e.message); }

// MOBILE VIEWPORT HEIGHT. `100vh` on Android Chrome / iOS Safari is the height
// the page would have with the URL bar HIDDEN, so with the bar showing the body
// is taller than the visible area — and with overflow:hidden the bottom of the
// chart, where lightweight-charts draws the TIME AXIS, is unreachable. Reported
// twice from a phone as "horizontal scale is not exist".
ok('body height uses dvh (the visible viewport), not only vh',
   /body\s*\{[^}]*height:\s*100dvh/.test(html), 'no 100dvh on body');
ok('...with 100vh kept before it as the fallback',
   /body\s*\{[^}]*height:\s*100vh;\s*height:\s*100dvh/.test(html));
ok('and a JS fallback re-pins the height where dvh is unsupported',
   /CSS\.supports\('height',\s*'100dvh'\)/.test(html)
   && /visualViewport/.test(html));
ok('the fallback is re-applied on resize and orientation change',
   /addEventListener\('resize',\s*_syncViewportHeight\)/.test(html)
   && /orientationchange/.test(html));
try { ctx._syncViewportHeight(); ok('_syncViewportHeight() runs', true); }
catch (e) { ok('_syncViewportHeight() runs', false, e.message); }
// the drawer must never cover the axis either (the other cause, same symptom)
ok('an open drawer reserves its height instead of covering the chart',
   /body\.drawer-open main \{ padding-bottom/.test(html));

// STALE SHELL. Mobile Chrome caches the HTML document and a phone has no easy
// hard-refresh, so after a deploy the browser kept serving the previous page —
// the multi-source register picker was simply absent, which reads as a broken
// feature rather than an old page. The server sends no-store; the page also
// checks its own hash against the one the server reports.
ok('the page fetches health with cache:no-store',
   /fetch\('\/api\/health',\s*\{\s*cache:\s*'no-store'\s*\}\)/.test(html));
ok('it compares its own hash with the server-reported one',
   /crypto\.subtle\.digest\('SHA-256'/.test(html) && /mine!==h\.ui/.test(html));
ok('a stale page is announced, not left to be discovered',
   /STALE PAGE/.test(html) && /CACHED page from before the last deploy/.test(html));
// and the register picker is genuinely built from the server's source list
ok('the register picker is filled from /api/screener/sources, not hardcoded',
   /fillRegPicker\(document\.getElementById\('regReg'\)/.test(html));
ok('the old hardcoded "R1 (all)" label is gone', !/R1 \(all\)/.test(html));

console.log('\n' + '='.repeat(64));
console.log('RESULT  PASS=' + PASS + '  FAIL=' + FAIL);
console.log('='.repeat(64));
process.exit(FAIL ? 1 : 0);
