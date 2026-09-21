/*
 * FOUR PROGRAMS AND NO WAY BETWEEN THEM.
 *
 * The desk is four separate programs — the screener suite, the chart platform,
 * the journal and the algo page — on four origins. Until now the only route
 * from any one of them to any other was the browser's back button and a
 * landing page that had to be returned to each time. The screener suite in
 * particular read as a dead end: you arrive, and the only exit is backwards,
 * which is what made it feel like a corridor between two pages rather than one
 * of the four places the work happens.
 *
 * So every page carries the same bar, built from tools.config.json, with the
 * current program marked. These check the three things about it that are easy
 * to get wrong and impossible to notice from a desk chair:
 *
 *   THE SCHEME. This page may be https (the alerts app is, because a browser
 *   refuses notification permission over plain http) while the program it
 *   links to is not. `location.protocol` there produces an https request to a
 *   port that speaks http — a connection that fails rather than a page that
 *   loads, from the one link most likely to be pressed at 09:36.
 *
 *   WHERE HOME IS. "/" is the landing page from the screener process and is
 *   the alerts page from the alerts process. A bar whose home link points at
 *   the page you are already on is the dead end it was built to remove.
 *
 *   ONE LINE, NOT A PARAGRAPH. The landing page's only question is "which
 *   program". A three-sentence description is read BEFORE the program it
 *   describes has been chosen, so the second and third sentences were never
 *   read at all — they were only ever in the way of the name.
 */

const fs = require('fs');
const path = require('path');

const read = (...f) => fs.readFileSync(path.join(__dirname, '..', ...f), 'utf8');
const js = read('public', 'desk.js');
const css = read('public', 'desk.css');
const home = read('public', 'home.html');
const suite = read('public', 'screeners.html');
const alerts = read('public', 'alerts.html');
const cfg = JSON.parse(read('tools.config.json'));

/*
 * The bar is RUN, not grepped. A substring search cannot verify behaviour —
 * only executing the function can, and every bug below is a bug in what the
 * function returns, not in whether a line of source exists.
 */
const HOST = 'desk.example.com';
let _desk = null;
function loadDesk() {
  if (_desk) return _desk;
  // Only the two pure href builders are needed; the renderer touches document.
  const from = js.indexOf('function deskEsc');
  const to = js.indexOf('async function deskAppBar');
  /*
   * A CRASH IS NOT A FAILING TEST. Slicing on markers that are not there gives
   * a nonsense string, `new Function` throws while the file is being loaded,
   * and jest reports "suite failed to run" — one line that names neither the
   * missing function nor the behaviour it was supposed to have. Said out loud
   * instead, so a future edit that renames these reads what it broke.
   */
  if (from < 0 || to < 0) {
    throw new Error('public/desk.js has no deskEsc/deskAppHref to run — the '
      + 'shared bar is what every page navigates with');
  }
  // eslint-disable-next-line no-new-func
  const make = new Function('location', `${js.slice(from, to)}; `
    + 'return { deskEsc, deskAppHref };');
  _desk = make({ hostname: HOST, protocol: 'https:', href: `https://${HOST}/` });
  return _desk;
}

/** The two builders, loaded on first use so a missing one fails a TEST. */
const D = {
  deskEsc: (...a) => loadDesk().deskEsc(...a),
  deskAppHref: (...a) => loadDesk().deskAppHref(...a),
};
const APPS = cfg.apps;
const app = id => APPS.find(a => a.id === id);
/** What the BAR prints: the short name, falling back to the full one. */
const label = a => a.short || a.name;

describe('where a program lives, from wherever you are standing', () => {
  test('a hop to another port is http, never this page\'s protocol', () => {
    /*
     * The alerts page is served over https. qp, the journal and the screeners
     * are plain http on their own ports and nothing proxies them, so an https
     * URL to those ports is a link that cannot connect. A top-level navigation
     * from https to http is allowed, which is what makes the literal scheme
     * correct rather than merely convenient.
     */
    for (const id of ['QP', 'JOURNAL']) {
      const href = D.deskAppHref(app(id), false);
      expect({ id, href }).toEqual({ id, href: expect.stringMatching(/^http:\/\//) });
      expect(href).toContain(`:${app(id).port}`);
    }
  });

  test('an app that declares its own address keeps it', () => {
    // The alerts app sits behind https on a real domain — see
    // deploy/setup-https.sh, which writes the address after issuing the cert.
    const withUrl = { ...app('ALERTS'), url: 'https://desk.example.com/', path: '/' };
    expect(D.deskAppHref(withUrl, false)).toBe('https://desk.example.com');
    expect(D.deskAppHref({ ...withUrl, path: '/algo' }, false))
      .toBe('https://desk.example.com/algo');
  });

  test('the suite is a PATH from its own process and a PORT from anywhere else', () => {
    /*
     * The suite is served by whichever screener tool is the front one, on
     * whatever port that tool happens to use — so `location.port` does not
     * answer "am I that process", and a wrong guess sends the main door to a
     * port with nothing on it. It is passed in, which is why there are two
     * answers here and not one.
     */
    expect(D.deskAppHref(app('SCR'), true)).toBe('/screeners');
    expect(D.deskAppHref(app('SCR'), false))
      .toBe(`http://${HOST}:${app('SCR').port}/screeners`);
  });

  test('"Screeners" opens the screeners, not the landing page', () => {
    /*
     * THE BUG THIS EXISTS FOR, reported as: "when I press in the header in
     * screener it took me to land page".
     *
     * The suite's registry entry carries `path: "/"`, and that is correct —
     * the process that serves the suite ALSO serves the landing page, so "/"
     * on port 3000 IS the landing page. Which made the Screeners chip on every
     * page outside that process a link to the front door. It looked right in
     * the source and right in the config; it was only wrong in a browser, and
     * only from three of the four programs, which is why it survived.
     *
     * `suitePath` is the one field that says where the suite actually is, so
     * it is what the chip uses from EITHER side. `self` only decides whether
     * it needs a host and a port in front of it.
     */
    const scr = app('SCR');
    expect(scr.suitePath).toBe('/screeners');
    for (const self of [true, false]) {
      const href = D.deskAppHref(scr, self);
      expect({ self, endsAtSuite: href.endsWith(scr.suitePath) })
        .toEqual({ self, endsAtSuite: true });
      // …and specifically NOT the front door.
      expect({ self, landing: href === '/' || href === `http://${HOST}:${scr.port}/` })
        .toEqual({ self, landing: false });
    }
  });

  test('an entry with no suitePath still lands somewhere that exists', () => {
    // AN ERROR IS NEVER A ZERO: a registry edited to drop the field must not
    // silently go back to pointing the chip at the landing page.
    const bare = { ...app('SCR') };
    delete bare.suitePath;
    expect(D.deskAppHref(bare, true)).toBe('/screeners');
    expect(D.deskAppHref(bare, false)).toBe(`http://${HOST}:${bare.port}/screeners`);
  });

  test('a missing app is a link home, not a crash', () => {
    // AN ERROR IS NEVER A ZERO: a bar rendered from a list that came back
    // short must still get you somewhere.
    expect(D.deskAppHref(undefined, false)).toBe('/');
    expect(D.deskAppHref(null, true)).toBe('/');
  });

  test('a name with a quote in it cannot break out of the markup', () => {
    // App names are typed by hand into tools.config.json and go into innerHTML.
    expect(D.deskEsc('A "B" & <C>')).toBe('A &quot;B&quot; &amp; &lt;C&gt;');
  });
});

describe('the bar is on every page, and says which one', () => {
  const pages = [
    ['home.html', home], ['screeners.html', suite], ['alerts.html', alerts],
  ];

  test('each page links the shared script that draws it', () => {
    for (const [name, src] of pages) {
      expect({ name, linked: src.includes('src="/desk.js"') })
        .toEqual({ name, linked: true });
    }
  });

  test('EVERY page renders one — no exceptions', () => {
    /*
     * The landing page was the exception, on the argument that there the doors
     * ARE the four programs so a bar above them is the same list twice. True,
     * and it made the landing page the one screen where the bar was missing —
     * so the one screen where the habit breaks. A control in the same place on
     * five pages and absent on the sixth is not a control you can reach for
     * without looking, and not looking is the whole point of it.
     *
     * Read from the DIRECTORY, not from a list written here: a page added next
     * month is a page this test already covers, which is the only way a rule
     * like "on every page" survives contact with a new file.
     */
    const dir = path.join(__dirname, '..', 'public');
    const pages = fs.readdirSync(dir).filter(f => f.endsWith('.html'));
    expect(pages.length).toBeGreaterThanOrEqual(6);
    for (const f of pages) {
      const src = fs.readFileSync(path.join(dir, f), 'utf8');
      expect({ f, bar: src.includes('id="deskbar"'), boots: /deskAppBar\(/.test(src),
               js: src.includes('/desk.js') })
        .toEqual({ f, bar: true, boots: true, js: true });
    }
  });

  test('the chart platform carries it too, from its own copy', () => {
    /*
     * qp is a separate program in a separate language on a separate port, and
     * it was the one place on this desk with no way out: a chart, and the
     * browser's back button.
     */
    const qp = read('quant-platform', 'chart', 'static', 'index.html');
    expect(qp).toContain('id="deskbar"');
    expect(qp).toContain("deskAppBar('QP', { self: false })");
    expect(qp).toContain('src="/static/desk.js"');
    // And it answers the registry itself rather than the page hardcoding four
    // names that go stale the first time a program moves.
    const server = read('quant-platform', 'chart', 'server.py');
    expect(server).toContain("@app.get('/api/tools')");
    expect(server).toContain("'tools.config.json'");
  });

  test('a page that cannot read the registry still draws a way out', () => {
    // The bar is how you LEAVE a page. qp's route returns ok:false rather than
    // raising, so a typo in a JSON file cannot take the exits off a chart.
    const server = read('quant-platform', 'chart', 'server.py');
    const fn = server.slice(server.indexOf('def tools_registry()'),
                            server.indexOf('@app.post', server.indexOf('def tools_registry()')));
    expect(fn).toContain('except Exception');
    expect(fn).toContain("'ok': False");
    expect(fn).not.toContain('raise');
  });

  test('each marks ITS OWN program, with the right idea of home', () => {
    // `self` is the claim "this process also serves the landing page". The
    // suite's process does; the alerts process does not, and a bar that got
    // that wrong would point "TRADE DESK" at the page you are already on.
    expect(suite).toContain("deskAppBar('SCR', { self: true })");
    expect(alerts).toContain("deskAppBar('ALERTS', { self: false })");
  });

  test('the alerts page no longer rewrites a single back-link by hand', () => {
    // It computed the suite's address into one <a id="home-link">. Four
    // programs, one of them reachable: that is the dead end, spelled out.
    expect(alerts).not.toContain('home-link');
    // The pill it was dressed in goes too. Not the WORDS "all tools" — a rule
    // with no tool scope still says "all tools · any stock", and that is a
    // sentence about a rule, not a link.
    expect(alerts).not.toContain('class="home"');
  });

  test('the suite has more than a crumb pointing backwards', () => {
    expect(suite).not.toContain('class="crumb"');
    expect(suite).toContain('id="deskbar"');
  });

  test('the bar needs no stylesheet of its own', () => {
    for (const cls of ['.dk-bar', '.dk-bar-home', '.dk-app', '.dk-door', '.dk-rows']) {
      expect({ cls, on: css.includes(cls) }).toEqual({ cls, on: true });
    }
  });
});

describe('the doors carry a name and one line', () => {
  test('every app has a `one`, and it is one sentence', () => {
    for (const a of APPS) {
      expect({ id: a.id, one: typeof a.one }).toEqual({ id: a.id, one: 'string' });
      // Short enough to be read at a glance on a phone, and not two sentences
      // wearing one sentence's clothes.
      expect({ id: a.id, len: a.one.length < 64 }).toEqual({ id: a.id, len: true });
      const sentences = a.one.split('. ').length;
      expect({ id: a.id, sentences }).toEqual({ id: a.id, sentences: 1 });
    }
  });

  test('the long description is kept, not deleted', () => {
    // `one` is what the landing page prints; `desc` is still the long form for
    // anywhere with room for it, and the fallback for an app added without a
    // `one`. Dropping it would have made this a rewrite rather than a fold.
    for (const a of APPS) {
      expect({ id: a.id, desc: (a.desc || '').length > a.one.length })
        .toEqual({ id: a.id, desc: true });
    }
  });

  test('the landing page prints the one-liner and falls back to a sentence', () => {
    expect(home).toContain('a.one || deskFirstSentence(a.desc)');
    /*
     * A LOOKBEHIND WOULD HAVE EMPTIED THE PAGE. `(?<=\.)\s` is a SyntaxError
     * when the file is parsed on an older phone, not when the line runs — so
     * the whole script, doors included, would never execute. This is the desk's
     * most-read device.
     */
    for (const [name, src] of [['home.html', home], ['desk.js', js]]) {
      expect({ name, lookbehind: src.includes('(?<=') })
        .toEqual({ name, lookbehind: false });
    }
  });

  test('a door is a link, and there is no inert "you are here" card', () => {
    expect(home).toContain('<a class="dk-door"');
    expect(home).not.toContain('is-self');
  });

  test('and the door still says where it goes', () => {
    // "port 3090" under a card that opens an https domain is a wrong answer to
    // "which port do I open in AWS".
    expect(home).toContain('dk-door-at');
    expect(home).toContain("`port ${a.port}`");
  });
});

/*
 * THE BAR ITSELF, RUN.
 *
 * Everything above this point is either a pure function or a substring, and a
 * substring search cannot verify behaviour. The three bugs this bar can have —
 * a home link that points at the page you are already on, no program marked or
 * two marked, and a sunlight button dropped on the floor by the innerHTML that
 * draws the bar over it — all live in the renderer, and all of them look
 * perfectly fine in the source.
 *
 * There is no jsdom in this repository, so the handful of DOM calls the
 * renderer makes are stubbed and the markup it produces is read back. That is
 * enough: the function's whole output IS a string.
 */
async function renderBar(currentId, self, apps, { failFetch = false } = {}) {
  const from = js.indexOf('function deskEsc');
  const to = js.indexOf('const DESK_WHY_LIMIT');
  if (from < 0 || to < 0) throw new Error('public/desk.js has no bar to render');

  let html = null;
  let adopted = null;
  const end = { appendChild: (n) => { adopted = n; } };
  const bar = {
    set innerHTML(v) { html = v; },
    get innerHTML() { return html; },
    querySelector: (s) => (s === '.dk-bar-end' ? end : null),
  };
  const sun = { id: 'sun-btn' };
  const doc = { getElementById: id => (id === 'deskbar' ? bar : id === 'sun-btn' ? sun : null) };
  const fetchStub = async () => {
    if (failFetch) throw new Error('offline');
    return { json: async () => ({ ok: true, apps }) };
  };
  // eslint-disable-next-line no-new-func
  const fn = new Function('document', 'fetch', 'location',
    `${js.slice(from, to)}; return deskAppBar;`);
  await fn(doc, fetchStub, { hostname: HOST, protocol: 'https:' })(currentId, { self });
  return { html: html || '', adopted };
}

const hrefs = html => [...html.matchAll(/href="([^"]*)"/g)].map(m => m[1]);

describe('the bar, drawn', () => {
  test('from the alerts process, HOME is the suite\'s address and not "/"', async () => {
    /*
     * THE BUG THIS EXISTS FOR. "/" is the landing page from the screener
     * process and is the alerts page itself from the alerts process. A bar
     * whose home link reloads the page you are on is precisely the dead end it
     * was built to remove — and it looks correct in every code review.
     */
    const { html } = await renderBar('ALERTS', false, APPS);
    expect(html).toContain(`<a class="dk-bar-home" href="http://${HOST}:${app('SCR').port}/"`);
    expect(hrefs(html)[0]).not.toBe('/');
  });

  test('from the suite\'s own process, HOME is "/"', async () => {
    const { html } = await renderBar('SCR', true, APPS);
    expect(html).toContain('<a class="dk-bar-home" href="/"');
    // …and its own door is a path on this host, not a hop to a port.
    expect(html).toContain('href="/screeners"');
  });

  test('home and the Screeners chip are not the same address', async () => {
    /*
     * They were, from every program that is not the suite: the wordmark went
     * to http://host:3000/ and so did the chip labelled "Screeners". Two
     * controls, one destination, and the destination was the one neither of
     * them said — which is exactly what "I pressed screener and it took me to
     * land page" describes.
     */
    const { html } = await renderBar('ALERTS', false, APPS);
    const [homeHref] = hrefs(html);
    const chip = /<a class="dk-app"[^>]*title="Screener Suite"[^>]*href="([^"]*)"/.exec(html)
      || /<a class="dk-app"[^>]*href="([^"]*)"[^>]*title="Screener Suite"/.exec(html);
    expect({ found: !!chip }).toEqual({ found: true });
    expect(chip[1]).toBe(`http://${HOST}:${app('SCR').port}/screeners`);
    expect(homeHref).toBe(`http://${HOST}:${app('SCR').port}/`);
    expect(chip[1]).not.toBe(homeHref);
  });

  test('the wordmark says where it goes, and is drawn as something pressable', async () => {
    /*
     * It navigates, and at --text3 it was the dimmest thing in the bar — which
     * is how a LABEL is drawn. Pressed by accident, the landing page arriving
     * reads as the page having thrown you out rather than as a link you took.
     */
    const { html } = await renderBar('ALERTS', false, APPS);
    expect(html).toContain('title="the landing page');
    const rule = css.slice(css.indexOf('\n.dk-bar-home {'),
                           css.indexOf('}', css.indexOf('\n.dk-bar-home {')));
    // Full strength now that it is the wordmark on a header band rather than a
    // caption on a strip: --text, not the two dimmer greys.
    expect(rule).toContain('color:var(--text)');
    expect(rule).not.toContain('color:var(--text3)');
    expect(rule).not.toContain('color:var(--text2)');
    // It takes a background the band itself does not have, so it belongs to
    // the row of things that go somewhere — on touch as well as on hover,
    // because a phone has no hover.
    expect(css).toContain('.dk-bar-home:hover, .dk-bar-home:active');
    const hov = css.slice(css.indexOf('.dk-bar-home:hover'),
                          css.indexOf('}', css.indexOf('.dk-bar-home:hover')));
    const band = css.slice(css.indexOf('\n.dk-bar {'), css.indexOf('}', css.indexOf('\n.dk-bar {')));
    const surface = /background:(var\(--bg\d\))/.exec(band);
    expect({ band: !!surface }).toEqual({ band: true });
    // A HOVER THE COLOUR OF THE THING UNDER IT IS NOT A HOVER. The band moved
    // from --bg2 to --bg3 and both hovers were --bg3, which is invisible.
    expect({ hover: hov.includes(surface[1]) }).toEqual({ hover: false });
    const pill = css.slice(css.indexOf('.dk-app:hover'),
                           css.indexOf('}', css.indexOf('.dk-app:hover')));
    expect({ pillHover: pill.includes(surface[1]) }).toEqual({ pillHover: false });
  });

  test('exactly one program is marked, and it is the current one', async () => {
    for (const id of APPS.map(a => a.id)) {
      const { html } = await renderBar(id, false, APPS);
      const marked = [...html.matchAll(/<a class="dk-app on"[^>]*>([^<]+)</g)].map(m => m[1]);
      // THE SHORT NAME, as the bar writes it, escaped. Comparing against the
      // raw config string would fail on the one app whose name has an
      // ampersand in it, which is the escaping working.
      expect({ id, marked }).toEqual({ id, marked: [D.deskEsc(label(app(id)))] });
      expect((html.match(/aria-current="page"/g) || []).length).toBe(1);
    }
  });

  test('every program is in the bar, current one included', async () => {
    const { html } = await renderBar('SCR', true, APPS);
    for (const a of APPS) expect(html).toContain(`>${D.deskEsc(label(a))}</a>`);
  });

  test('the sunlight button is adopted, not drawn over', async () => {
    /*
     * The page puts it inside the bar so it is in the right place from the
     * first paint. The renderer replaces that bar's contents — so the button
     * has to be taken BEFORE the wipe, or the only control on the page that
     * cannot be reached any other way silently disappears.
     */
    const { adopted } = await renderBar('ALERTS', false, APPS);
    expect(adopted).toEqual({ id: 'sun-btn' });
  });

  test('a list that could not be read still gets you home', async () => {
    // AN ERROR IS NEVER A ZERO. An empty strip reads as "there is nowhere to
    // go", which is a different and worse claim than "I could not ask".
    const { html } = await renderBar('ALERTS', false, [], { failFetch: true });
    expect(html).toContain('dk-bar-home');
    expect(html).toContain('app list unreadable');
  });

  test('an app name is escaped on its way into the bar', async () => {
    const { html } = await renderBar('X', false,
      [{ id: 'X', name: '"><script>bad()</script>', port: 1, accent: '#fff' }]);
    expect(html).not.toContain('<script>');
    expect(html).toContain('&quot;&gt;&lt;script&gt;');
  });
});

/*
 * TWO OF THE FOUR PROGRAMS WERE NOT ON THE SCREEN.
 *
 * Measured in a browser at 430px — the phone this desk is read on — the four
 * full names came to 539px of row. The bar scrolls horizontally, so nothing
 * overlapped and nothing looked broken: Journal and Algo were simply not
 * visible, behind a hidden scrollbar, on the one strip that exists so you can
 * reach them. The sunlight button sat on top of the last name still showing.
 *
 * A scrolling row is right for tabs WITHIN a page, where the first is the
 * default and the rest are variations. It is wrong for whole programs — an
 * item you have to know is there in order to find it is an item that is not
 * there.
 *
 * Two changes, and this pins both: the bar prints a SHORT name, and on a phone
 * it WRAPS so the names get a line to themselves.
 */
describe('the bar fits on a phone', () => {
  test('every app has a short name, and it is actually short', () => {
    for (const a of APPS) {
      expect({ id: a.id, short: typeof a.short }).toEqual({ id: a.id, short: 'string' });
      // Four of these plus a wordmark and a button share 430px.
      expect({ id: a.id, fits: a.short.length <= 12 }).toEqual({ id: a.id, fits: true });
    }
    // Their total is what actually has to fit, so it is what is measured.
    const total = APPS.reduce((n, a) => n + a.short.length, 0);
    expect({ chars: total, under: total <= 40 }).toEqual({ chars: total, under: true });
  });

  test('the bar prints the short name and keeps the full one', async () => {
    const { html } = await renderBar('QP', false, APPS);
    // The full name is still reachable — a pointer gets it, and the landing
    // page's door carries it in full.
    expect(html).toContain('>Chart</a>');
    expect(html).toContain('title="Chart &amp; Backtest"');
    expect(html).not.toContain('>Chart &amp; Backtest</a>');
  });

  test('an app with no short name still gets a label', async () => {
    // AN ERROR IS NEVER A ZERO: a registry entry written before `short`
    // existed must render its name, not an empty chip.
    const { html } = await renderBar('X', false,
      [{ id: 'X', name: 'Some Program', port: 1, accent: '#fff' }]);
    expect(html).toContain('>Some Program</a>');
  });

  test('the landing page door keeps the FULL name', () => {
    // Opposite requirement, same registry: the bar is a label you glance at,
    // the door is the thing you are choosing.
    expect(home).toContain('deskEsc(a.name)');
    expect(home).not.toContain('a.short');
  });

  test('on a phone the bar wraps instead of hiding its tail', () => {
    const phone = css.slice(css.indexOf('@media (max-width:640px)', css.indexOf('.dk-bar-end')));
    expect(phone).toContain('.dk-bar { flex-wrap:wrap');
    // The names take a full-width line of their own.
    expect(phone).toContain('.dk-bar-apps { order:3; flex:1 0 100%');
  });
});

/*
 * A HEADING THE BAR ALREADY SAID.
 *
 * The Algo page opened with a bar chip reading "Algo" and, forty pixels below,
 * an <h1> reading "Algo". Deleting the h1 would leave the document with no
 * outline, so it is kept and not drawn — and NOT with display:none, which
 * takes it out of the accessibility tree as well and so removes the only
 * reason it is still there.
 */
test('the Algo page has a heading, and does not print it twice', () => {
  expect(alerts).toContain('<h1 class="dk-sr">Algo</h1>');
  expect(css).toContain('.dk-sr {');
  const rule = css.slice(css.indexOf('.dk-sr {'), css.indexOf('}', css.indexOf('.dk-sr {')));
  expect(rule).toContain('clip:rect(0 0 0 0)');
  expect(rule).not.toContain('display:none');
  // The row that held the heading, the back-link and the button is gone with
  // them — a class nothing carries is a rule the next reader has to rule out.
  expect(alerts).not.toContain('class="top"');
});

/*
 * A DESCRIPTION WRITTEN FOR A REGISTRY, PRINTED ON A CARD.
 *
 * tools.config.json's `desc` is two or three sentences — "A 15% move in two
 * hours with no news behind it, expected to correct back. The six-month trend
 * is a safety layer: a spike that agrees with it is not unexplained. Needs a
 * 'catalyst is empty' filter on the setup." That is the right text for the
 * registry and the wrong text for a card, and there are six of them on one
 * screen. The first sentence says what the tool is; the rest qualifies it, and
 * is read at the moment you are choosing WHICH tool, which is before any
 * qualification can mean anything.
 *
 * SPLIT, NOT TRUNCATED. The two halves have to add back up to the original —
 * a card that quietly drops two thirds of what the registry says is a card
 * that deleted it.
 */
describe('the first sentence, and the rest kept', () => {
  function split() {
    const from = js.indexOf('function deskFirstSentence');
    const to = js.indexOf('/*\n * WHERE A PROGRAM LIVES');
    if (from < 0 || to < 0) throw new Error('public/desk.js does not split a description');
    // eslint-disable-next-line no-new-func
    return new Function(`${js.slice(from, to)}; `
      + 'return { deskFirstSentence, deskRestOfIt };')();
  }

  test('the halves add back up to the whole, for every real description', () => {
    const { deskFirstSentence, deskRestOfIt } = split();
    const all = [...cfg.tools, ...cfg.apps].map(t => (t.desc || '').trim()).filter(Boolean);
    expect(all.length).toBeGreaterThan(8);
    for (const d of all) {
      const head = deskFirstSentence(d);
      const rest = deskRestOfIt(d);
      expect({ d, rejoined: rest ? `${head} ${rest}` : head }).toEqual({ d, rejoined: d });
    }
  });

  test('a one-sentence description has no remainder to fold away', () => {
    const { deskFirstSentence, deskRestOfIt } = split();
    const one = 'Daily moving averages stacked fast-over-slow.';
    expect(deskFirstSentence(one)).toBe(one);
    expect(deskRestOfIt(one)).toBe('');
  });

  test('a decimal or an abbreviation does not end the sentence', () => {
    /*
     * The split is on ". " and not on "." for exactly this: "a 1.5% move" and
     * "T10 vs. T11" both contain a full stop, and cutting at the first one
     * would leave a card reading "a 1." — a number that is arithmetically a
     * full stop and is not the end of anything.
     */
    const { deskFirstSentence } = split();
    expect(deskFirstSentence('A 1.5% move on 2.2x volume.'))
      .toBe('A 1.5% move on 2.2x volume.');
  });

  test('nothing is not a crash', () => {
    const { deskFirstSentence, deskRestOfIt } = split();
    for (const v of [undefined, null, '', '   ']) {
      expect({ v, head: deskFirstSentence(v), rest: deskRestOfIt(v) })
        .toEqual({ v, head: '', rest: '' });
    }
  });

  test('the suite prints one sentence and folds the rest into the expander', () => {
    expect(suite).toContain('esc(deskFirstSentence(t.desc))');
    expect(suite).toContain('deskRestOfIt(t.desc)');
    expect(suite).toContain('sc-lead');
    // …and it is not simply dropped when a tool has no screener summary.
    expect(suite).toContain('more about this tool');
    expect(suite).not.toContain('<div class="card-desc">${esc(t.desc || \'\')}</div>\n      </a>\n      ${screensBlock(t, summary)}');
  });
});

/*
 * THE ICONS.
 *
 * "⚡ Algo" was a heading with a bolt in front of it. The bolt had to be
 * learned, rendered differently on every device it was read on, and on this
 * same desk already meant "loading" somewhere else. A glyph that means two
 * things means neither.
 *
 * The sun is not in this list and is not an icon in that sense: it is the
 * label ON a control, the control has a title, and there is exactly one of it.
 */
test('no decorative glyph is left in a page heading', () => {
  for (const [name, src] of [['home.html', home], ['screeners.html', suite],
                             ['alerts.html', alerts]]) {
    const heads = [...src.matchAll(/<h1[^>]*>([\s\S]*?)<\/h1>/g)].map(m => m[1]);
    for (const h of heads) {
      // Anything outside the Latin-1 range in a heading is decoration.
      const glyphs = [...h].filter(c => c.charCodeAt(0) > 0x2000);
      expect({ name, head: h.trim(), glyphs }).toEqual(
        { name, head: h.trim(), glyphs: [] });
    }
  }
});

/*
 * ONE PALETTE. The landing page was the last file with a private `:root` — its
 * own blue, its own type scale, and no sunlight mode, which made it the one
 * screen on this desk that could not be read outdoors.
 */
test('the landing page is on the design system, not a fifth palette', () => {
  expect(home).toContain('href="/desk.css"');
  expect(home).not.toContain(':root {');
  expect(home).not.toContain('--accent:#4a9eff');
  expect(home).toContain('id="sun-btn"');
});

/*
 * A BAR, NOT A ROW OF LINKS UNDER A LINE.
 *
 * Four plain words over a hairline, with the current one UNDERLINED — which is
 * how a link is drawn, so the thing saying "you are here" was wearing the one
 * decoration that means "this goes somewhere else". And four unequal words
 * floating on the page background do not read as one control; they read as
 * four, which is the opposite of what a bar is for.
 */
describe('the bar looks like one control', () => {
  const rule = (sel) => {
    const at = css.indexOf(`\n${sel} {`);
    expect({ sel, found: at >= 0 }).toEqual({ sel, found: true });
    return css.slice(at, css.indexOf('}', at));
  };

  test('it is a surface, not four words on the page background', () => {
    const bar = rule('.dk-bar');
    expect(bar).toMatch(/background:var\(--bg[234]\)/);
    // Not the page's own background — a band the colour of the page is four
    // words floating on it, which is what this replaced.
    expect(bar).not.toContain('background:var(--bg)');
  });

  test('the current program is FILLED, not underlined', () => {
    /*
     * Filled against outlined is a difference you see before you have read
     * anything. An underline two pixels tall is not, and it is the wrong
     * signal besides.
     */
    const on = css.slice(css.indexOf('.dk-app.on {'));
    expect(on).toContain('background:color-mix');
    expect(on).not.toContain('border-bottom-color');
  });

  test('and it is filled in ITS OWN colour, from one rule', () => {
    // color-mix over the program's accent: one rule for four programs, rather
    // than four hand-mixed hexes that drift the first time a colour changes.
    expect(css).toContain('var(--dk-accent, var(--accent)) 16%');
  });

  test('a browser without color-mix still marks something', () => {
    /*
     * AN ERROR IS NEVER A ZERO, in CSS too. The plain rule above the tinted
     * one is what such a browser paints: still a filled pill, just not tinted.
     * A bar that degrades to plain is fine; one that degrades to "nothing is
     * marked" is a bar that has stopped answering its only question.
     */
    const first = css.indexOf('.dk-app.on {');
    const plain = css.slice(first, css.indexOf('}', first));
    expect(plain).toContain('background:var(--bg4)');
    expect(plain).not.toContain('color-mix');
  });
});

/*
 * AND IT IS THE PAGE'S HEADER, NOT A ROW ON THE PAGE.
 *
 * Said as: "the header give you feeling like it's part of the page not the
 * biggest header". It was a rounded box with a border, inset by the same
 * gutter as the text under it, sitting on the page — which is the description
 * of a PANEL. A panel is something the page contains. A header is the thing
 * the page is under, and the whole difference is whether it reaches the glass.
 *
 * THE HAZARD IS THE NEGATIVE MARGIN. The band cancels the page's gutter to get
 * to the edge, and "the page's gutter" is not a constant: two pages run
 * full-bleed and set body's padding to zero. Cancelling fourteen pixels that
 * were never there hangs the header off the left of the screen — on a phone,
 * silently, because the bar scrolls.
 */
describe('the header reaches the glass', () => {
  test('the gutter is a token, so the band can cancel exactly it', () => {
    // Written out as `padding:18px 14px` it is a number the bar has to guess,
    // and a guess that is right today is wrong the first time it changes.
    const body = css.slice(css.indexOf('\nbody {'), css.indexOf('}', css.indexOf('\nbody {')));
    expect(body).toContain('padding:var(--dk-pad-t) var(--dk-pad-x)');
    // The :root that holds the scale, not the one that holds the palette —
    // there are two, and the gutter belongs with the spacing steps.
    const at = css.lastIndexOf(':root {', css.indexOf('--s4:'));
    const root = css.slice(at, css.indexOf('\n}', at));
    expect(root).toMatch(/--dk-pad-x:\s*14px/);
    expect(root).toMatch(/--dk-pad-t:\s*18px/);
  });

  test('the band pulls out of the gutter, on both sides and the top', () => {
    const bar = css.slice(css.indexOf('\n.dk-bar {'), css.indexOf('}', css.indexOf('\n.dk-bar {')));
    expect(bar).toContain('margin:calc(-1 * var(--dk-pad-t)) calc(-1 * var(--dk-pad-x))');
    // A band with rounded corners and a border on all four sides is a panel
    // however wide it is.
    expect(bar).toContain('border-radius:0');
    expect(bar).toContain('border-bottom:1px solid var(--border)');
    expect(bar).toContain('border:none');
  });

  test('and it keeps an inner gutter of its own', () => {
    /*
     * Cancelling the page's padding without adding any back puts the wordmark
     * against the edge of the glass, which on a phone is where a thumb rests.
     * The padding is a NUMBER rather than the token: the token is zero on the
     * full-bleed pages and the band still needs its gutter there.
     */
    const bar = css.slice(css.indexOf('\n.dk-bar {'), css.indexOf('}', css.indexOf('\n.dk-bar {')));
    const pad = /padding:(\d+)px (\d+)px/.exec(bar);
    expect({ found: !!pad }).toEqual({ found: true });
    expect({ inner: Number(pad[2]) >= 10 }).toEqual({ inner: true });
  });

  test('every page that sets its own body padding sets the tokens with it', () => {
    /*
     * THE BUG THIS EXISTS FOR, and it is a bug a reader cannot see: the rule
     * lives in desk.css and the thing that breaks it lives in another file.
     * Read from the DIRECTORY, so a page written next month is covered.
     */
    const dir = path.join(__dirname, '..', 'public');
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.html'))
      .map(f => [f, fs.readFileSync(path.join(dir, f), 'utf8')]);
    files.push(['qp/index.html',
      read('quant-platform', 'chart', 'static', 'index.html')]);
    let checked = 0;
    for (const [name, src] of files) {
      // Its own <style>, not desk.css: a body rule that names padding.
      const own = [...src.matchAll(/(?:^|[\s,])body\s*\{([^}]*)\}/g)]
        .map(m => m[1]).filter(b => /(?:^|[;{\s])padding\s*:/.test(b));
      if (!own.length) continue;
      checked++;
      const all = own.join(' ');
      expect({ page: name, sets: /--dk-pad-x\s*:/.test(all) && /--dk-pad-t\s*:/.test(all) })
        .toEqual({ page: name, sets: true });
    }
    // If this drops to zero the test has stopped looking rather than started
    // passing — the two full-bleed pages are why it exists.
    expect({ pagesWithOwnPadding: checked >= 2 }).toEqual({ pagesWithOwnPadding: true });
  });

  test('the two full-bleed pages no longer inline a margin over the band', () => {
    // `style="margin:12px 14px 0"` on the <nav> wins over every rule in
    // desk.css, so the band was a floating strip on exactly the two pages the
    // token work was for.
    for (const [name, src] of [['index.html', read('public', 'index.html')],
                               ['qp', read('quant-platform', 'chart', 'static', 'index.html')]]) {
      const nav = src.slice(src.indexOf('id="deskbar"'));
      expect({ name, inline: /^[^>]*style="[^"]*margin:/.test(nav) })
        .toEqual({ name, inline: false });
    }
  });

  test('the Algo page puts it OUTSIDE its centred column', () => {
    /*
     * .wrap is a 1180px column centred on the page. A header inside it starts
     * where the text starts and ends where the text ends — a row ON the page,
     * which is the thing being fixed. It has to come first in the body.
     */
    expect(alerts.indexOf('id="deskbar"'))
      .toBeLessThan(alerts.indexOf('<div class="wrap">'));
    expect(alerts).toContain('<div class="wrap">');
    // Still exactly one column, opened once and closed once.
    expect((alerts.match(/<div class="wrap">/g) || []).length).toBe(1);
  });

  test('the journal does not pull on a layout that is not ours', () => {
    /*
     * The bar is injected into someone else's app, whose body padding is
     * whatever it is. Cancelling fourteen pixels it never had would hang the
     * header off the side of it.
     */
    const patch = read('deploy', 'journal', 'patch.js');
    const fn = patch.slice(patch.indexOf('function appBar()'),
                           patch.indexOf('\n  }', patch.indexOf('function appBar()')));
    expect(fn).toContain("setProperty('--dk-pad-x', '0')");
    expect(fn).toContain("setProperty('--dk-pad-t', '0')");
    // Set BEFORE it is put in the document, so it never paints pulled over.
    expect(fn.indexOf('--dk-pad-x')).toBeLessThan(fn.indexOf('insertBefore'));
  });

  test('the wordmark is a wordmark, not a caption', () => {
    const rule = css.slice(css.indexOf('\n.dk-bar-home {'),
                           css.indexOf('}', css.indexOf('\n.dk-bar-home {')));
    const font = /font:(\d+) (\d+(?:\.\d+)?)px/.exec(rule);
    expect({ found: !!font }).toEqual({ found: true });
    // It was 700/10px in the dimmest grey on the page — a caption's weight and
    // a caption's size, on the one element that names the whole desk.
    expect({ weight: Number(font[1]) >= 800, size: Number(font[2]) >= 12 })
      .toEqual({ weight: true, size: true });
  });
});

/*
 * ONE IMPLEMENTATION OF SUNLIGHT.
 *
 * desk.js was extracted FROM the scanner page, and the scanner page kept its
 * copy — two functions doing the same job, and the copy set the class on
 * <body> only, so its palette landed one paint later than the shared one's.
 */
test('the scanner page no longer carries its own sunlight code', () => {
  const scanner = read('public', 'index.html');
  expect(scanner).toContain('src="/desk.js"');
  expect(scanner).not.toContain('function toggleSunlight()');
  expect(scanner).not.toContain('function restoreSunlight()');
  // Its own layout still wins: desk.css gives every page a gutter and this
  // page is full-bleed — and it zeroes the two tokens that gutter is made of
  // with it, or the header band would cancel a gutter this page never had.
  expect(scanner).toMatch(/body \{[^}]*margin: 0; padding: 0;/);
  expect(scanner).toMatch(/body \{[^}]*--dk-pad-x: 0; --dk-pad-t: 0; \}/);
});
