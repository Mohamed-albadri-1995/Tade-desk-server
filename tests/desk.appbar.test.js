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
      .toBe(`http://${HOST}:${app('SCR').port}/`);
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

  test('the two pages behind the landing page render one', () => {
    /*
     * The landing page does not: there the doors ARE the bar, and a second
     * copy of the same four names above them is one list too many.
     */
    for (const [name, src] of [['screeners.html', suite], ['alerts.html', alerts]]) {
      expect({ name, bar: src.includes('id="deskbar"') }).toEqual({ name, bar: true });
    }
    expect(home).not.toContain('id="deskbar"');
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
