/*
 * THE TWO THINGS THE CHART LETS YOU MOVE, and why they are executed here
 * rather than grepped for.
 *
 * The complaint was concrete: on a phone, "the labels on right side and upside
 * are distracting", and the seven tools down the left take width the candles
 * need. Both are now switches — Labels (clean / every indicator tagged) and
 * Tools (left of the chart / under the time axis).
 *
 * A switch that writes a class and forgets to tell the chart, or that reads
 * `window.LINES` when LINES is a `let` binding — which is NOT a property of
 * window, so the loop iterates nothing and the tags never come off — passes
 * every substring check ever written and does nothing on the screen. So the
 * functions are pulled out of the shipped page and RUN, against a stub that
 * records what they touched.
 *
 * index.html is one long inline script that builds a real chart at load, so it
 * cannot be evaluated whole here. The two functions are sliced out of it by
 * brace matching — the code under test is the code that ships, not a copy.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const PAGE = path.join(__dirname, '..', 'quant-platform', 'chart', 'static', 'index.html');
const HTML = fs.readFileSync(PAGE, 'utf8');

/** The source of `function <name>(…){…}`, sliced by matching its braces. */
function fnSource(name) {
  const at = HTML.indexOf(`function ${name}(`);
  if (at < 0) throw new Error(`${name} is not in index.html`);
  let i = HTML.indexOf('{', at);
  let depth = 0;
  for (; i < HTML.length; i += 1) {
    if (HTML[i] === '{') depth += 1;
    else if (HTML[i] === '}') { depth -= 1; if (!depth) return HTML.slice(at, i + 1); }
  }
  throw new Error(`${name} never closes`);
}

/** A chart line as the page holds one: options in, options remembered. */
const line = (name) => ({
  _ov: { name, color: '#fff' },
  opts: {},
  applyOptions(o) { Object.assign(this.opts, o); },
});

function sandbox({ label = 'clean', rail = 'left', lines = [] } = {}) {
  const classes = new Set();
  const store = {};
  const calls = { legend: 0, resize: 0 };
  const ctx = {
    LINES: lines,
    STRATLINES: [],
    document: {
      body: {
        classList: {
          toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)),
          contains: (c) => classes.has(c),
        },
      },
      getElementById: (id) => (id === 'labelMode' ? { value: label }
        : id === 'railPos' ? { value: rail } : null),
    },
    localStorage: { setItem: (k, v) => { store[k] = v; }, getItem: (k) => store[k] },
    updateLegend: () => { calls.legend += 1; },
    _resizeChart: () => { calls.resize += 1; },
  };
  vm.createContext(ctx);
  vm.runInContext(`${fnSource('applyLabelMode')}\n${fnSource('applyRailPos')}`, ctx);
  return { ctx, classes, store, calls };
}

/* ── the labels ──────────────────────────────────────────────────────────── */

describe('Labels: clean drops the overlays\' tags and keeps the price', () => {
  test('clean takes the tag off every overlay, on the price scale and the oscillator',
    () => {
      const ls = [line('vwap.session'), line('ma.ema(20)')];
      const s = sandbox({ label: 'clean', lines: ls });
      s.ctx.STRATLINES.push(line('swing_hh(lookback=25)'));
      s.ctx.applyLabelMode();
      // …and STRATLINES too: it was pushed after the context was built, which
      // is exactly what a strategy overlay does mid-session.
      for (const l of [...ls, ...s.ctx.STRATLINES]) {
        expect(l.opts.lastValueVisible).toBe(false);
        expect(l.opts.title).toBe('');
      }
    });

  test('full puts every tag back, with the name it was drawn under', () => {
    const ls = [line('vwap.session')];
    const s = sandbox({ label: 'full', lines: ls });
    s.ctx.applyLabelMode();
    expect(ls[0].opts.lastValueVisible).toBe(true);
    expect(ls[0].opts.title).toBe('vwap.session');
  });

  /*
   * THE ONE THAT WOULD HAVE SHIPPED BROKEN. `window.LINES` is undefined —
   * LINES is a `let`, and `let` at the top level of a script does not become a
   * property of window. The loop would run over nothing, silently, and the
   * switch would look like it did not work.
   */
  test('it reads the bindings directly, never through window', () => {
    expect(fnSource('applyLabelMode')).not.toMatch(/window\.(LINES|STRATLINES)/);
  });

  test('the legend is repainted, because it carries the same names', () => {
    const s = sandbox({ label: 'clean' });
    s.ctx.applyLabelMode();
    expect(s.calls.legend).toBe(1);
  });

  test('the choice survives a reload', () => {
    const s = sandbox({ label: 'full' });
    s.ctx.applyLabelMode();
    expect(s.store.qpc_labels).toBe('full');
    const t = sandbox({ label: 'clean' });
    t.ctx.applyLabelMode();
    expect(t.store.qpc_labels).toBe('clean');
  });

  test('an overlay that refuses its options does not stop the rest', () => {
    const bad = line('broken');
    bad.applyOptions = () => { throw new Error('series removed'); };
    const good = line('vwap.session');
    const s = sandbox({ label: 'clean', lines: [bad, good] });
    expect(() => s.ctx.applyLabelMode()).not.toThrow();
    expect(good.opts.title).toBe('');
  });
});

/* ── where the seven tools sit ───────────────────────────────────────────── */

describe('Tools: the rail moves under the time axis and back', () => {
  test('bottom sets the class the stylesheet keys on', () => {
    const s = sandbox({ rail: 'bottom' });
    s.ctx.applyRailPos();
    expect(s.classes.has('rail-bottom')).toBe(true);
    expect(s.store.qpc_rail).toBe('bottom');
  });

  test('left takes it off again — both views, not a one-way door', () => {
    const s = sandbox({ rail: 'bottom' });
    s.ctx.applyRailPos();
    const t = sandbox({ rail: 'left' });
    t.ctx.applyRailPos();
    expect(t.classes.has('rail-bottom')).toBe(false);
    expect(t.store.qpc_rail).toBe('left');
  });

  /*
   * THE CHART'S BOX JUST CHANGED SHAPE. lightweight-charts measures its canvas
   * once and does not watch for it; a chart measured for the old box draws its
   * time axis off the bottom of the new one.
   */
  test('the chart is re-measured after the move', () => {
    const s = sandbox({ rail: 'bottom' });
    s.ctx.applyRailPos();
    expect(s.calls.resize).toBe(1);
  });
});

/* ── the page itself ─────────────────────────────────────────────────────── */

describe('the controls exist and are wired', () => {
  test('both selects are on the page, with both options each', () => {
    expect(HTML).toContain('id="labelMode"');
    expect(HTML).toContain('id="railPos"');
    for (const v of ['"clean"', '"full"', '"left"', '"bottom"']) expect(HTML).toContain(v);
  });

  test('each is restored from storage and applied at load, not just on change', () => {
    expect(HTML).toContain("localStorage.getItem('qpc_labels')");
    expect(HTML).toContain("localStorage.getItem('qpc_rail')");
    expect(HTML).toMatch(/addEventListener\('change',applyLabelMode\); ?applyLabelMode\(\)/);
    expect(HTML).toMatch(/addEventListener\('change',applyRailPos\); ?applyRailPos\(\)/);
  });

  /*
   * A REDRAW BUILDS THE SERIES AFRESH. Both places that create an overlay have
   * to read the preference at birth, or "clean" lasts until the next symbol
   * change and then quietly stops being true — the kind of half-working that
   * is worse than not shipping it.
   */
  test('a newly drawn overlay is born with the preference already applied', () => {
    const born = HTML.match(/lastValueVisible:!_clean\d?/g) || [];
    expect(born.length).toBe(2);      // drawSnapshot and drawStratSeries
    expect((HTML.match(/title:_clean\d?\?'':/g) || []).length).toBe(2);
  });

  /*
   * THE RAIL AT THE BOTTOM SITS INSIDE <main>, WHICH RESERVES ITS HEIGHT. The
   * drawer is position:fixed to the viewport, so with the drawer open the rail
   * has to climb above it or it is simply covered by it.
   */
  test('main reserves the rail\'s height, and the rail clears an open drawer', () => {
    expect(HTML).toContain('body.rail-bottom main { padding-bottom:var(--railH); }');
    expect(HTML).toContain('body.rail-bottom.drawer-open #leftRail { bottom:var(--drawerH, 42vh); }');
  });

  /*
   * AND --railH IS DECLARED WHERE `main` CAN SEE IT — the assertion above is
   * true of the broken version too, which is how this shipped.
   *
   * It was `#leftRail { --railH:46px; }`. A custom property inherits DOWN the
   * tree and <main> is the rail's PARENT, so `padding-bottom:var(--railH)` on
   * main was invalid at computed-value time and fell back to 0. main reserved
   * nothing, the absolutely-positioned rail landed on top of the time axis,
   * and the trader's report was exact: "the time scale should go up and create
   * space… this is not happening". The rail's own `height:var(--railH)`
   * resolved fine, which is why it looked half-built rather than unbuilt.
   *
   * Checking the DECLARATION SITE rather than the usage is the whole lesson: a
   * `var()` that cannot resolve is silent, so the string being present proves
   * nothing about the value arriving.
   */
  test('every element that reads --railH is a descendant of where it is declared',
    () => {
      // Each `--railH:` declaration, with the selector it sits on.
      const decls = [...HTML.matchAll(/([^{}]+)\{[^{}]*--railH\s*:/g)]
        .map(m => m[1].trim().split('\n').pop().trim());
      expect(decls.length).toBeGreaterThan(0);
      // :root/html/body are ancestors of everything on the page. Anything else
      // — #leftRail above all — cannot be seen by <main>.
      for (const sel of decls) {
        expect(sel).toMatch(/^(:root|html|body)\b/);
      }
      expect(HTML).not.toContain('#leftRail { --railH');
    });

  /*
   * Overlay names are typed by hand in the Indicators panel and go straight
   * into innerHTML.
   */
  test('the legend escapes the names it prints', () => {
    expect(HTML).toContain('function _esc(');
    expect(HTML).toContain('${_esc(shown)}');
    expect(HTML).toContain('title="${_esc(full)}"');
  });
});
