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
    // Every real element has it. Stubbed so a caller is exercised rather than
    // guarded against in production code that will never meet a browser
    // without it.
    scrollIntoView() {},
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

// THE AXIS IS MEASURED, NOT ASSUMED.
//
// Reported a third time from a phone after two layout fixes that each held on
// one device. There are too many ways for the last 28 pixels of #chart to fall
// off a phone — the URL bar returning, a gesture bar drawn over the page, a
// browser whose 100dvh disagrees with its own innerHeight — to keep guessing
// which one it is from a screenshot. So the page measures the axis row and
// shortens the chart by exactly the overflow, whatever caused it.
ok('the page measures whether the time axis is on screen',
   /_keepAxisOnScreen/.test(html) && /rows\[rows\.length-1\]\.getBoundingClientRect/.test(html));
ok('...against the VISIBLE viewport, not the document',
   /visualViewport && window\.visualViewport\.height\)\s*\n?\s*\|\| window\.innerHeight/.test(html));
ok('...and only ever shortens, so a correct layout is left alone',
   /if\(over <= 1\)\{ _axisFix = 0; return; \}/.test(html));
ok('the correction re-measures itself instead of assuming it worked',
   /requestAnimationFrame\(_keepAxisOnScreen\)/.test(html));
ok('it is capped, so it cannot spin',
   /if\(_axisFix >= 3\) return;/.test(html));
// The resize observer used to call applyOptions directly and skip the check,
// which is how a resize could put the axis back under the fold and leave it.
ok('every chart resize goes through the check',
   /new ResizeObserver\(\(\)=>_resizeChart\(\)\)/.test(html));
// _syncViewportHeight returned EARLY where dvh is supported — which is every
// modern browser — taking the resize handling with it.
ok('a dvh-capable browser still re-measures on resize',
   /_axisFix=0;\s*\n?\s*\/\/[^\n]*\n?\s*_resizeChart\(\);/.test(html)
   || /_axisFix=0;[\s\S]{0,200}_resizeChart\(\);/.test(html));

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

// ── THE MONEY: one run reports three different P&L numbers ────────────────
// +43.956% (percent moves added up), $527.86 (flat 100 shares, prop firm) and
// $9,118.85 (the real account). They differ by more than 10x, and the panel
// used to print all three with nothing saying which one answers "what did I
// make" — reported from a phone as "is it 500 or 9000 or what exactly".
const SUM = {
  trades: 14, win_rate: 64.3, total_return_pct: 43.956, avg_return_pct: 3.14,
  sharpe: 14.26, max_drawdown_pct: 5.227, max_dd_days: 2, pairs: 199,
  exits_by: { SL: 5, exit: 5, eod: 4 }, errors: 0, open_trades: 0,
  ttp: { shares: 100, net_pnl_usd: 527.86, fees_usd: 27.75,
         counted_pnl_usd: 524.9, min_profit_ps: 0.1, wins_below_min: 1 },
  account: { account_equity_start: 100000, risk_pct: 0.5, max_leverage: 2,
             equity_end: 109118.85, net_pnl_usd: 9118.85, return_pct: 9.12,
             fees_usd: 61.15, trades_sized: 14, win_rate_pct: 64.3,
             avg_pnl_usd: 651.35, max_drawdown_pct: 0.99,
             unsized_no_stop: 0, size_capped_by_leverage: 1,
             skipped_no_capital: 0, max_concurrent_positions: 2,
             fee_per_share: 0.005, fee_min_per_order: 0.75 },
};
let H = '';
try { ctx.btRenderCore({ summary: SUM, trades: [] }, ''); H = els.btSummary.innerHTML; }
catch (e) { ok('btRenderCore() renders a finished run', false, e.message); }
ok('btRenderCore() renders a finished run', H.length > 0);
ok('the account P&L is stated in plain dollars, with its sign',
   H.includes('+$9,118.85'), H.slice(0, 200));
ok('...and the balance it moves between',
   H.includes('$100,000.00') && H.includes('$109,118.85'));
// The result panel was rebuilt into money -> figures -> folded detail, so
// these match the FACT rather than the old sentence. The fee total belongs
// next to the money; the fee SCHEDULE is a sizing assumption and folds away.
ok('FEES are shown against that number (they were computed but never printed)',
   /after \$61\.15 fees/.test(H) && H.includes('$0.005/share') && H.includes('min $0.75/order'));
ok('the sizing rule is spelled out, not left to be inferred',
   /\(equity × 0\.5%\) ÷ \(entry − stop\)/.test(H) && /2× equity/.test(H));
ok('the leverage cap that bit one trade is reported',
   /1 trade sized down to the cash available/.test(H));
ok('the percent total is labelled as NOT an account return',
   /NOT an account return/.test(H) && /43\.956%/.test(H));
// …and it is FOLDED. It is the number most often mistaken for a return, and
// the fix for that is not a louder caption, it is not being the first thing on
// screen.
ok('...and it is behind the fold, not competing with the money',
   H.indexOf('<details') >= 0 && H.indexOf('<details') < H.search(/[Uu]nsized edge/));
ok('the prop-firm number says it is a flat share count',
   /[Ff]lat 100 shares every trade/.test(H) && H.includes('$527.86'));
ok('the money leads — the account block is printed before the % edge',
   H.indexOf('+$9,118.85') < H.search(/[Uu]nsized edge/));
// and with no account set, say what is missing rather than showing nothing
const NOACCT = Object.assign({}, SUM); delete NOACCT.account;
ctx.btRenderCore({ summary: NOACCT, trades: [] }, '');
const H2 = els.btSummary.innerHTML;
ok('with no account $, the panel says how to get a dollar figure',
   /no dollar P&L/.test(H2) && !/YOUR ACCOUNT/.test(H2));


/* ── THE BACKTEST FORM'S DEFAULTS, AND ITS MEMORY ────────────────────────
 *
 * The form had no memory at all: every reload put back the shipped values,
 * so re-running a configuration you already trusted meant retyping nineteen
 * fields on a phone. Worse, two of them were overwritten AFTER the form was
 * built — the backtest timeframe from the CHART's timeframe, and the feed
 * from the server default — so a field could change itself between loads with
 * nothing on screen saying why.
 *
 * These defaults are the settings behind backtest #349 (+$3,346.50, 30 trades,
 * 2026-08-11 → 08-31). They are a STARTING POINT for real inputs, never a
 * decision taken behind one: btRun() reads the fields, so what is on screen is
 * what runs.
 */
const BT_WANT = {
  btUni: 'R1', btFill: 'next_open', btTf: '1m', btFeed: 'polygon',
  btEquity: '50000', btRiskPct: '0.5',
  btRankMetric: 'vwap_extension', btTopN: '3',
  btPreset: 'ttp', btShares: '100',
  btFee: '0.005', btFeeMin: '0.75', btMinPs: '0.10',
};
// Fields the screenshots leave EMPTY. A default here would silently change
// what gets tested — a max-position cap or a cost the user never chose.
const BT_BLANK = ['btSyms', 'btRiskUsd', 'btMaxPos', 'btCost',
                  'btMinRvol', 'btTarget', 'btMaxDD', 'btMaxDay'];

/* `const` at a script's top level is a LEXICAL binding, not a property of the
 * global object, so ctx.BT_DEFAULTS is undefined even though the name is very
 * much in scope. Read it the way the page's own code does — by evaluating the
 * identifier inside the same context. */
const evalIn = (src) => vm.runInContext(src, ctx);
const BT_DEFAULTS = evalIn('BT_DEFAULTS');
const BT_STRAT_DEFAULTS = evalIn('BT_STRAT_DEFAULTS');
ok('the defaults live in ONE table, not scattered through the handlers',
   typeof BT_DEFAULTS === 'object' && BT_DEFAULTS !== null);
for (const [id, want] of Object.entries(BT_WANT)) {
  ok(`default ${id} = ${want}`, String(BT_DEFAULTS[id]) === want,
     'got ' + JSON.stringify(BT_DEFAULTS[id]));
}
for (const id of BT_BLANK) {
  ok(`${id} ships EMPTY`, BT_DEFAULTS[id] === '',
     'got ' + JSON.stringify(BT_DEFAULTS[id]));
}
ok('RTH-only + forced 15:50 close is on by default', BT_DEFAULTS.btRules === true);
ok('the scanner gate is on by default', BT_DEFAULTS.btScanGate === true);
ok('the two books are named, not numbered — ids are per-database',
   BT_STRAT_DEFAULTS.btStrat === 'OR + VWAP 09:35 (Long)'
   && BT_STRAT_DEFAULTS.btStrat2 === 'OR + VWAP 09:35 (Short)');

// EVERY DEFAULT MUST BE A FIELD ON THE PAGE. A default with no input behind
// it is a hardcoded setting wearing a table's clothes.
for (const id of [...Object.keys(BT_DEFAULTS), ...Object.keys(BT_STRAT_DEFAULTS)]) {
  ok(`${id} is an editable control in the HTML`,
     new RegExp(`id="${id}"`).test(html));
}

// RESTORE puts the defaults on the page.
try {
  ctx.btSettingsRestore();
  ok('btSettingsRestore() runs', true);
} catch (e) { ok('btSettingsRestore() runs', false, e.message); }
ok('...and the form now holds them', els.btEquity.value === '50000'
   && els.btTopN.value === '3' && els.btFill.value === 'next_open',
   [els.btEquity.value, els.btTopN.value, els.btFill.value].join('/'));
ok('...including the checkboxes, by the table not by el.type',
   els.btRules.checked === true && els.btScanGate.checked === true);

// THE DATE RANGE IS NOT REMEMBERED — see the note in the page. A remembered
// "to 2026-08-31" would still be sitting there in November, and a run of the
// last-tested window reads exactly like a run of the recent one.
ok('the range opens on a rolling 20 days, both ends filled',
   /^\d{4}-\d{2}-\d{2}$/.test(els.btStart.value)
   && /^\d{4}-\d{2}-\d{2}$/.test(els.btEnd.value),
   els.btStart.value + ' → ' + els.btEnd.value);
ok('...and it really is 20 days wide',
   Math.round((Date.parse(els.btEnd.value) - Date.parse(els.btStart.value)) / 86400000) === 20,
   els.btStart.value + ' → ' + els.btEnd.value);
ok('the dates are NOT written to storage',
   !/btStart|btEnd/.test(store.qpc_bt_form || ''));

// MEMORY: what you last used comes back.
els.btEquity.value = '250000';
els.btMaxPos.value = '16.66';
els.btRules.checked = false;
ctx.btSettingsSave();
els.btEquity.value = ''; els.btMaxPos.value = ''; els.btRules.checked = true;
ctx.btSettingsRestore();
ok('a changed account size survives a reload', els.btEquity.value === '250000',
   els.btEquity.value);
ok('...so does a field the defaults leave empty', els.btMaxPos.value === '16.66',
   els.btMaxPos.value);
ok('...and an UNCHECKED box stays unchecked (false is a value, not "missing")',
   els.btRules.checked === false);

// RESET is the way back out of the memory.
try { ctx.btSettingsReset(); ok('btSettingsReset() runs', true); }
catch (e) { ok('btSettingsReset() runs', false, e.message); }
ok('reset restores the shipped account size', els.btEquity.value === '50000',
   els.btEquity.value);
ok('reset clears a value the defaults leave empty', els.btMaxPos.value === '',
   els.btMaxPos.value);
ok('reset re-checks the boxes', els.btRules.checked === true);

// NOTHING MAY OVERWRITE THE FORM AFTER IT IS BUILT. Both of these used to.
ok('the backtest TF is no longer taken from the chart on load',
   !/getElementById\('btTf'\)\.value\s*=\s*document\.getElementById\('tf'\)\.value/.test(html));
ok('the backtest feed is no longer overwritten by the server default',
   !/if\(h\.default_feed\)document\.getElementById\('btFeed'\)\.value=h\.default_feed/.test(html));
// A commission preset reaching two sections up to change an EXECUTION
// assumption is the same class of bug: a setting moved by something the reader
// cannot see, on a phone where the field is off screen.
ok('the fee preset no longer sets the fill model behind your back',
   !/btPreset[\s\S]{0,400}getElementById\('btFill'\)\.value/.test(html));

// A dead feed is the one remembered value that fails SILENTLY.
evalIn("FEEDS = { polygon: false, yahoo: true }; DEFAULT_FEED = 'yahoo';");
els.btFeed.value = 'polygon';
try { ctx.btFeedSanity(); } catch (e) { /* reported below */ }
ok('a remembered feed with no API key falls back to one that has one',
   els.btFeed.value === 'yahoo', els.btFeed.value);
evalIn('FEEDS = { polygon: true, yahoo: true };');
els.btFeed.value = 'polygon';
ctx.btFeedSanity();
ok('...and a working feed is left alone', els.btFeed.value === 'polygon');


/* ── THE DESK'S SETTINGS ARE THE FORM'S DEFAULTS ─────────────────────────
 *
 * A backtest is only evidence about the desk if it was run with the desk's
 * settings. They used to be re-typed into this form by hand, which is exactly
 * how three of them drifted apart for a fortnight — with a mismatched P&L as
 * the only symptom.
 *
 * Now the desk states them in the backtest's own key names
 * (/api/setups/backtest-defaults, proxied by qp) and the form fills itself.
 * Precedence: what you last used, then the DESK, then this file's table.
 */
const DESK = {
  ok: true,
  setups: [{
    id: 'OR + VWAP 09:35@09:35',
    name: 'OR + VWAP 09:35',
    strategies: ['OR + VWAP 09:35 (Long)', 'OR + VWAP 09:35 (Short)'],
    spec: {
      account_equity: 50000, risk_usd: 500, risk_pct: 0,
      max_position_pct: 16.66,
      rank_per_day: { metric: 'vwap_extension', top_n: 3 },
      tf: '1m', feed: 'polygon', view: 'all', fill: 'desk',
      universe: { kind: 'tools', register: 'R1', tools: ['T2'] },
      rules: { max_entries_per_day: 1 },
    },
  }],
};

ok('the form asks the desk for its settings',
   /\/api\/desk\/backtest-defaults/.test(html));
ok('...and the backtest has its OWN Session control now',
   /id="btView"/.test(html)
   // it used to send the CHART's selector, so scrolling the chart to RTH
   // quietly changed what the next backtest evaluated
   && !/view:document\.getElementById\('view'\)\.value, fill:/.test(html));

const deskFields = evalIn('btDeskFields');
const f = deskFields(DESK.setups[0].spec);
ok('account size comes from the desk', f.btEquity === '50000', f.btEquity);
ok('risk arrives as FLAT DOLLARS', f.btRiskUsd === '500', f.btRiskUsd);
// The two are mutually exclusive server-side; leaving a stale 0.5 in the
// percent box while the dollar box is filled makes the run refuse to start.
ok('...and the percentage box is CLEARED with it', f.btRiskPct === '', f.btRiskPct);
ok('the position cap comes across', f.btMaxPos === '16.66', f.btMaxPos);
ok('the ranking comes across',
   f.btRankMetric === 'vwap_extension' && f.btTopN === '3',
   [f.btRankMetric, f.btTopN]);
ok('so do the frame settings',
   f.btTf === '1m' && f.btFeed === 'polygon' && f.btView === 'all',
   [f.btTf, f.btFeed, f.btView]);
ok("and the fill model — 'desk', the backtestable twin of live's 'live'",
   f.btFill === 'desk', f.btFill);

// A cap of 0 means NO cap on both sides, so it must land as an EMPTY box
// rather than as the number zero, which would read as "cap at 0%".
const noCap = deskFields({ ...DESK.setups[0].spec, max_position_pct: 0 });
ok('no cap lands as an empty box, not as 0', noCap.btMaxPos === '', noCap.btMaxPos);
const noRank = deskFields({ ...DESK.setups[0].spec, rank_per_day: null });
ok('no ranking lands as empty, not as a leftover metric',
   noRank.btRankMetric === '' && noRank.btTopN === '',
   [noRank.btRankMetric, noRank.btTopN]);
ok('and an unreachable desk yields nothing rather than guesses',
   Object.keys(deskFields(null)).length === 0);

// PRECEDENCE, which is the whole contract.
evalIn('BT_DESK = ' + JSON.stringify(DESK) + ';');
els.btStrat.selectedIndex = 0;
els.btStrat.options = [{ value: '7', textContent: 'OR + VWAP 09:35 (Long)' }];
store.qpc_bt_form = JSON.stringify({ btEquity: '250000' });
ctx.btSettingsRestore();
ok('what you last used still wins over the desk',
   els.btEquity.value === '250000', els.btEquity.value);
ok('...and the desk wins over this file for everything else',
   els.btRiskUsd.value === '500' && els.btMaxPos.value === '16.66',
   [els.btRiskUsd.value, els.btMaxPos.value]);

delete store.qpc_bt_form;
ctx.btSettingsRestore();
ok('with nothing remembered, the form IS the desk',
   els.btEquity.value === '50000' && els.btRiskUsd.value === '500'
   && els.btMaxPos.value === '16.66' && els.btRiskPct.value === '',
   [els.btEquity.value, els.btRiskUsd.value, els.btMaxPos.value, els.btRiskPct.value]);

// RESET drops what you last used and comes back to the DESK, not to this file.
store.qpc_bt_form = JSON.stringify({ btEquity: '999' });
ctx.btSettingsReset();
ok('reset returns to the desk, not to the shipped table',
   els.btEquity.value === '50000', els.btEquity.value);

// A DESK THAT CANNOT BE REACHED must not look like one that agreed.
// Storage is cleared first because the reset above SAVED what it applied —
// which is correct behaviour, and would otherwise mask the fallback here.
evalIn('BT_DESK = null;');
delete store.qpc_bt_form;
ctx.btSettingsRestore();
ok('an unreachable desk falls back to the shipped table',
   els.btEquity.value === '50000' && els.btRiskUsd.value === '',
   [els.btEquity.value, els.btRiskUsd.value]);
ok('...and the page SAYS the numbers are not the desk’s',
   /NOT the desk/.test(html));


/* ── THE CHART MUST GET ITS HEIGHT BACK ──────────────────────────────────
 *
 * Reported as "when I try to change the symbol the screen shrinks", with a
 * screenshot of a strip of candles above a black page.
 *
 * The axis correction pins #chartWrap to an explicit pixel height and sets
 * flex:0 0 auto. That is right exactly once — for the layout it measured. A
 * different symbol has a taller or shorter overlay legend, so the pin is a
 * number computed for a layout that no longer exists, and nothing undid it.
 * Resetting _axisFix does not help: it resets the COUNTER, never the pin.
 */
ok('there is a way to release the pinned height',
   typeof ctx._releaseChartHeight === 'function');
ok('...and it clears BOTH the height and the flex override',
   /wrap\.style\.height = '';[\s\S]{0,80}wrap\.style\.flex = '';/.test(html),
   'a height cleared while flex:0 0 auto remains is still pinned');

// Called on every chart load, which is the moment the layout is known to be
// about to change — a symbol change goes through here.
ok('every chart load releases it before drawing',
   /_releaseChartHeight\(\);\s*\n\s*_axisFix = 0;\s*\n\s*syncAsofUI\(\);/.test(html),
   'loadChart must reset the pin, or a new symbol inherits the old height');

// And a fresh measurement starts from the full height, so a chart shortened
// for a viewport that has since grown is not left short forever.
ok('a fresh measurement releases first, then re-measures',
   /if\(_axisFix === 0\)\{[\s\S]{0,160}_releaseChartHeight\(\);/.test(html));

// It must NOT release mid-correction: that would undo the shrink being
// verified and the two would fight, frame by frame.
ok('...but not mid-correction', /if\(_axisFix === 0\)\{/.test(html));

try {
  // The stub creates elements on demand, so ask for it the way the page does.
  const wrap = doc.getElementById('chartWrap');
  wrap.style.height = '180px';
  wrap.style.flex = '0 0 auto';
  ctx._releaseChartHeight();
  ok('releasing really clears them',
     wrap.style.height === '' && wrap.style.flex === '',
     wrap.style.height + ' / ' + wrap.style.flex);
} catch (e) { ok('releasing really clears them', false, e.message); }


/* ── THE LEFT RAIL ────────────────────────────────────────────────────────
 *
 * Every tool used to sit behind one "More" button: two taps to reach, and
 * invisible until you found it. On a phone you could not tell the strategy
 * builder existed.
 *
 * THE PROPERTY THAT MATTERS MOST is that the rail duplicates NOTHING. A rail
 * with its own copy of "chart type" would be a second source of truth for one
 * setting, and the two would disagree the first time either was changed — the
 * failure this codebase keeps finding elsewhere. So each button either clicks
 * the button that already owns the behaviour, or opens the existing sheet and
 * brings the right group into view.
 */
ok('the rail exists, on the left of the chart',
   /<nav id="leftRail"[\s\S]{0,2000}<div id="chartWrap">/.test(html));
ok('it has a FIXED width, so the chart does not resize under your hand',
   /#leftRail \{[^}]*flex:0 0 54px/.test(html));

// An icon-only rail is a memory test. The labels are what make it readable to
// someone who did not build it.
ok('every button carries a word, not just an icon',
   (html.match(/class="rl"/g) || []).length >= 6);

// NOT ONE INPUT IS DUPLICATED. Checked by counting the ids that own a setting:
// if the rail had copied any of them there would be two in the file.
for (const id of ['ctype', 'scaleMode', 'view', 'days', 'feed', 'addPrim']) {
  ok(`#${id} exists exactly once — the rail copied no control`,
     (html.match(new RegExp(`id="${id}"`, 'g')) || []).length === 1);
}

// The three that own behaviour are FORWARDED to, never re-implemented: the
// strategy drawer, the alert watcher and the print sheet each carry their own
// state, and a second caller is a second place to get that state wrong.
ok('strategy, alerts, print and panel forward to the buttons that own them',
   /railForward\('railStrat','stratBtn'\)/.test(html)
   && /railForward\('railAlerts','alertsBtn'\)/.test(html)
   && /railForward\('railPrint','printR1Btn'\)/.test(html)
   && /railForward\('railPanel','sideBtn'\)/.test(html));

ok('`railOpen` is defined at top level and runs',
   typeof ctx.railOpen === 'function');
try {
  ctx.railOpen('mgrpChart');
  ok('railOpen() opens the sheet', doc.body.classList.contains('more-open'));
  ok('...and marks the group it brought into view',
     els.mgrpChart.classList.contains('flash'),
     'landing mid-sheet with nothing highlighted reads as the wrong button');
} catch (e) { ok('railOpen() runs', false, e.message); }

// A toggle with no sign of its state is a button you press twice to find out
// what it did.
ok('the rail shows what is currently open', typeof ctx.railSync === 'function');
try { ctx.railSync(); ok('railSync() runs', true); }
catch (e) { ok('railSync() runs', false, e.message); }

// NEVER HIDDEN ON A PHONE — that is where the complaint came from, and hiding
// it would put every tool back behind the one menu button it replaced.
ok('the rail narrows on a phone rather than disappearing',
   /#leftRail \{ flex:0 0 44px/.test(html) && !/#leftRail \{[^}]*display:none/.test(html));

console.log('\n' + '='.repeat(64));
console.log('RESULT  PASS=' + PASS + '  FAIL=' + FAIL);
console.log('='.repeat(64));
process.exit(FAIL ? 1 : 0);
