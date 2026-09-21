/*
 * The two behaviours every page on this desk shares.
 *
 * Kept beside desk.css rather than copied into four <script> blocks, for the
 * same reason the tokens are: four copies of one idea drift, and the one that
 * drifts is always the page you look at least.
 */

/*
 * SUNLIGHT MODE, and it is ON by default.
 *
 * A dark theme outdoors is a mirror. The screener has treated high contrast as
 * the normal case and the dark palette as the opt-out since the day someone
 * tried to read a card at a bus stop, and every other page kept its own dark
 * palette with no way out of it at all.
 *
 * Applied before the first data arrives, so a page comes up readable rather
 * than flashing the low-contrast palette and then correcting itself.
 */
function deskSunlight() {
  let on = true;
  try { on = localStorage.getItem('sunlight') !== '0'; } catch { /* private mode */ }
  /*
   * The ROOT element, not just the body.
   *
   * This script is in <head>, which is where it has to be — a palette applied
   * after the first paint is a page that flashes dark and then corrects
   * itself. But <body> does not exist yet at that point, and reaching for its
   * classList there threw on every page. documentElement always exists, so the
   * variables land from the first byte; the body gets the same class as soon
   * as there is one, because the screener's own rules are written against it.
   */
  document.documentElement.classList.toggle('sunlight', on);
  if (document.body) document.body.classList.toggle('sunlight', on);
  const b = document.getElementById('sun-btn');
  if (b) {
    b.classList.toggle('on', on);
    b.title = on ? 'back to normal contrast'
                 : 'high contrast, for reading the screen outdoors';
  }
}

function toggleSunlight() {
  const on = !document.documentElement.classList.contains('sunlight');
  try { localStorage.setItem('sunlight', on ? '1' : '0'); } catch { /* private mode */ }
  deskSunlight();
}

/*
 * THE APP BAR — the four programs, on every page of every one of them.
 *
 * WHAT WAS MISSING: a way to be somewhere. The only route from any program to
 * any other was the browser's back button and a landing page that had to be
 * returned to each time, so the screener suite in particular read as a dead
 * end — you arrive, and the only exit is backwards.
 *
 * The names come from tools.config.json through /api/tools, which BOTH servers
 * answer (src/index.js and src/alerts/server.js), so a new program is one
 * registry entry and appears in the bar of every page that already exists.
 *
 * It carries no status. A door that also reports health is a door you have to
 * read, and these are separate programs on separate origins — asking "is it up"
 * from here gets a network error whether it is up or not.
 */
function deskEsc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/*
 * THE FIRST SENTENCE, and the rest kept separately.
 *
 * Both the landing page's doors and the suite's tool cards print a description
 * written for a registry entry rather than for a card — two or three sentences,
 * six of them on one screen. The first one says what the thing is; the rest
 * qualifies it, and is read at the moment you are choosing WHICH thing, which
 * is before any qualification can mean anything.
 *
 * Nothing is thrown away: the caller gets both halves and decides where the
 * second one goes. On the cards it goes behind the expander that is already
 * there, so a card still has exactly one thing to open.
 *
 * WRITTEN WITH indexOf, NOT A LOOKBEHIND. A regex lookbehind assertion is a
 * SyntaxError when the file is PARSED on an older phone, not when the line
 * runs — so the whole script would never execute, on the device this desk is
 * most read on. The literal is not even written in this comment: a test greps
 * for it, and a mention in prose would read as a use.
 */
function deskFirstSentence(s) {
  s = String(s == null ? '' : s).trim();
  const i = s.indexOf('. ');
  return i > 0 ? s.slice(0, i + 1) : s;
}

/** Everything after that first sentence, or '' when there is nothing more. */
function deskRestOfIt(s) {
  s = String(s == null ? '' : s).trim();
  const i = s.indexOf('. ');
  return i > 0 ? s.slice(i + 2).trim() : '';
}

/*
 * WHERE A PROGRAM LIVES, from wherever you are standing.
 *
 * `self` is "this page is served by the process that serves the landing page
 * and the screener suite". It is passed in rather than guessed because it is
 * not guessable: the suite is served by whichever screener tool is the front
 * one, on whatever port that tool happens to use, so `location.port` does not
 * answer it and a wrong guess sends the main door to a port with nothing on it.
 */
function deskAppHref(a, self) {
  if (!a) return '/';
  /*
   * An app may declare its own address, and then that wins over host:port.
   * The alerts app is why: it sits behind https on a real domain, and it has
   * to, because a browser refuses notification permission to a page served
   * over plain http. See deploy/setup-https.sh, which writes the address.
   */
  if (a.url) return a.url.replace(/\/$/, '') + (a.path && a.path !== '/' ? a.path : '');
  /*
   * THE SUITE'S DOOR IS ITS OWN PATH, FROM EVERYWHERE.
   *
   * `path` for the suite's entry is "/", because the process that serves the
   * suite ALSO serves the landing page, and "/" is the landing page. So the
   * Screeners chip on every page outside that process — the Algo page, the
   * chart, the journal — pointed at http://host:3000/, and pressing "Screeners"
   * opened the front door instead of the screeners. Reported exactly that way:
   * "when I press in the header in screener it took me to land page".
   *
   * `suitePath` is where the suite actually is. It is used whether or not this
   * page is that process; `self` only decides whether it needs a host and port
   * in front of it.
   */
  if (a.isSelf) {
    const p = a.suitePath || '/screeners';
    if (self) return p;
    return `http://${location.hostname}:${a.port}${p}`;
  }
  /*
   * NEVER this page's protocol. The alerts page is reached over https through
   * duckdns; the other programs listen on plain http on their own ports and
   * nothing proxies them. Copying `location.protocol` produced https://…:8765,
   * an https request to a port that speaks http — a connection that fails
   * rather than a page that loads. A top-level navigation from https to http
   * is allowed, so the literal scheme works from either side.
   */
  return `http://${location.hostname}:${a.port}${a.path || '/'}`;
}

/*
 * Renders into #deskbar, and adopts the page's existing sunlight button rather
 * than drawing a second one — one control, one handler, one corner.
 */
async function deskAppBar(currentId, opts) {
  const el = document.getElementById('deskbar');
  if (!el) return;
  const self = !!(opts && opts.self);
  /*
   * Taken BEFORE the innerHTML below, not after. A page is free to put the
   * sunlight button inside the bar so it is in the right place from the first
   * paint instead of jumping there when the fetch lands — and a lookup after
   * the wipe would have found nothing, silently dropping the only control on
   * the page that cannot be reached any other way.
   */
  const sun = document.getElementById('sun-btn');
  let apps = [];
  try {
    const d = await (await fetch('/api/tools')).json();
    apps = d.apps || [];
  } catch { /* handled below — a bar with no names still gets you home */ }

  /*
   * HOME IS NOT ALWAYS "/". On the alerts page "/" is the alerts page, which
   * is how "← all tools" would have pointed at itself. The landing page is
   * served by the same process as the suite, so the suite's entry is its
   * address.
   */
  const suite = apps.find(a => a.isSelf);
  const home = (self || !suite) ? '/' : deskAppHref({ port: suite.port, path: '/' }, false);

  /*
   * THE SHORT NAME IN THE BAR, the full one on the landing page's doors.
   *
   * MEASURED, not guessed. At 430px — the phone this desk is read on — the
   * four full names came to 539px of row. The bar scrolls, so nothing
   * overlapped and nothing looked broken; Journal and Algo were simply not on
   * the screen, behind a hidden scrollbar. Two of the four programs, invisible,
   * on the one strip that exists so you can reach them.
   *
   * `title` keeps the full name for a pointer, and the door on the landing
   * page still carries it in full.
   */
  const links = apps.map((a) => {
    const on = a.id === currentId;
    return `<a class="dk-app${on ? ' on' : ''}" href="${deskEsc(deskAppHref(a, self))}"`
      + `${on ? ' aria-current="page"' : ''} title="${deskEsc(a.name)}"`
      + ` style="--dk-accent:${deskEsc(a.accent || '#3b82f6')}">`
      + `${deskEsc(a.short || a.name)}</a>`;
  }).join('');

  // AN ERROR IS NEVER A ZERO. With no list there are no names to show, and
  // saying so beats an empty strip that reads as "there is nowhere to go".
  el.innerHTML = `<a class="dk-bar-home" href="${deskEsc(home)}"`
    + ' title="the landing page — every program on this desk">TRADE DESK</a>'
    + `<div class="dk-bar-apps">${links || '<span class="dk-app">app list unreadable</span>'}</div>`
    + '<div class="dk-bar-end"></div>';
  if (sun) el.querySelector('.dk-bar-end').appendChild(sun);
}

/*
 * FOLD THE LONG EXPLANATIONS AWAY.
 *
 * Anything past a couple of lines goes behind a small "why" you can tap.
 * Length is the test, so a genuinely short note — "6 fired", "not saved" — is
 * left exactly where it is, and only .risk-hint / .cmp-hint blocks are
 * touched: those are explanations by construction. Warnings, counts and errors
 * are never hidden.
 *
 * Done in code rather than by hand because these paragraphs are spread over
 * thousands of lines, and a rule applied once catches the ones written next
 * month too.
 */
const DESK_WHY_LIMIT = 150;

function deskFoldWhy(root = document) {
  for (const el of root.querySelectorAll('.risk-hint:not([data-folded]), .cmp-hint:not([data-folded])')) {
    el.setAttribute('data-folded', '1');
    if (el.textContent.trim().length < DESK_WHY_LIMIT) continue;
    // Buttons and inputs live inside some of these blocks. Those are controls,
    // not prose, and they stay on screen — only the words fold.
    const controls = [...el.childNodes].filter(
      n => n.nodeType === 1 && n.matches('button, input, select, a, code, textarea, div.cmp-row'));
    const d = document.createElement('details');
    d.className = 'why';
    const sum = document.createElement('summary');
    sum.textContent = 'why';
    const body = document.createElement('div');
    body.className = 'why-body';
    body.innerHTML = el.innerHTML;
    for (const c of body.querySelectorAll('button, input, select, textarea, div.cmp-row')) c.remove();
    d.append(sum, body);
    el.innerHTML = '';
    el.append(...controls, d);
  }
}

document.addEventListener('DOMContentLoaded', () => { deskSunlight(); deskFoldWhy(); });
// The palette must not wait for DOMContentLoaded — a page that paints dark and
// then goes light is worse than one that was always dark.
deskSunlight();
