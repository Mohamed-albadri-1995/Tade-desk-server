/*
 * THE JOURNAL WAS THE LAST PROGRAM WITH NO WAY OUT.
 *
 * A page, and the browser's back button — plus one "← Trade Desk" link, which
 * is one exit, backwards. Every other page on this desk carries a strip naming
 * all four programs with the current one marked.
 *
 * THE JOURNAL CANNOT SIMPLY LINK desk.css. Its page is 1,079 lines on a branch
 * with no shared history with this repo, served from a worktree nobody here
 * has read, and desk.css sets body's font, background and gutter. Dropping it
 * on that page would restyle somebody else's work sight unseen.
 *
 * So the launcher slices out ONLY the bar's own rules — between two markers in
 * desk.css — and re-scopes the token block from :root to .dk-bar, where the
 * custom properties inherit to the bar's children and reach nothing else.
 *
 * That slice is the whole risk, and it is invisible: a marker that moves gives
 * an unstyled strip of four links at the top of the journal, which reads as a
 * bug in the journal. So it is RUN here, and what it produces is inspected.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const css = fs.readFileSync(path.join(ROOT, 'public', 'desk.css'), 'utf8');
const sh = fs.readFileSync(path.join(ROOT, 'deploy', 'journal-tool.sh'), 'utf8');
const patch = fs.readFileSync(path.join(ROOT, 'deploy', 'journal', 'patch.js'), 'utf8');

/**
 * The launcher's own deskbarCss(), lifted out of the heredoc and executed.
 * Reading the function is not the test — what it RETURNS is.
 */
function runDeskbarCss(deskRoot) {
  const from = sh.indexOf("const DESK = process.env.DESK_REPO");
  if (from < 0) {
    throw new Error('deploy/journal-tool.sh no longer builds the bar stylesheet '
      + '— the journal is the one program that cannot link desk.css directly');
  }
  const to = sh.indexOf("\napp.get('/deskbar.css'", from);
  // The heredoc is quoted with 'JS', so bash does not expand anything inside
  // it; the text on disk is the JavaScript that runs. Backslashes in the
  // source are already what node will see.
  // eslint-disable-next-line no-new-func
  return new Function('fs', 'path', 'process', 'console',
    `${sh.slice(from, to)}; return deskbarCss;`)(
    fs, path, { env: { DESK_REPO: deskRoot } }, { warn() {} })();
}

describe('the bar stylesheet the journal is served', () => {
  /*
   * Built inside the tests, not at module scope. A throw out here is "suite
   * failed to run" — one line naming neither the slice nor what it was
   * supposed to produce — and every other assertion in the file goes with it.
   */
  const built = () => {
    const out = runDeskbarCss(ROOT);
    /** Comments stripped: a `:root` in prose is not a selector. */
    return { out, live: out.replace(/\/\*[\s\S]*?\*\//g, '') };
  };

  test('the markers it slices between are in desk.css', () => {
    expect(css).toContain('/* >>> DESKBAR START');
    expect(css).toContain('/* <<< DESKBAR END */');
    expect(css.indexOf('/* >>> DESKBAR START'))
      .toBeLessThan(css.indexOf('/* <<< DESKBAR END */'));
  });

  test('it actually contains the bar', () => {
    const { out, live } = built();
    for (const sel of ['.dk-bar', '.dk-bar-home', '.dk-app', '.dk-app.on']) {
      expect({ sel, on: live.includes(sel) }).toEqual({ sel, on: true });
    }
    expect(out.length).toBeGreaterThan(2000);
  });

  test('the tokens are on .dk-bar, not on :root', () => {
    /*
     * Custom properties inherit, so defining them on the bar reaches every
     * child of the bar and nothing else. On :root they would reach the whole
     * journal, which is the restyle this avoids.
     */
    const { live } = built();
    expect(live).toMatch(/\.dk-bar \{[\s\S]*--bg2:/);
    expect(live).not.toMatch(/:root/);
  });

  test('and NOTHING in it can restyle the page around the bar', () => {
    /*
     * THE FAILURE THAT MATTERS. Every selector must be the bar or inside it.
     * A stray `body`, `*` or bare element rule here changes a page this repo
     * does not own, on a program whose source is not even in this repository.
     */
    const { live } = built();
    const selectors = live
      .replace(/@media[^{]*\{/g, '')            // the phone block's wrapper
      .split('}')
      .map(s => s.split('{')[0].trim())
      .filter(Boolean)
      .flatMap(s => s.split(',').map(x => x.trim()))
      .filter(Boolean);
    expect(selectors.length).toBeGreaterThan(5);
    const stray = selectors.filter(s => !s.startsWith('.dk-'));
    expect({ stray, hint: stray.length ? 'this rule escapes the bar' : 'ok' })
      .toEqual({ stray: [], hint: 'ok' });
  });

  test('a moved marker gives nothing, loudly, rather than half a stylesheet', () => {
    /*
     * AN ERROR IS NEVER A ZERO — and here the zero is the honest answer, since
     * half a stylesheet is worse than none: it would style the bar's frame and
     * not its pills, which looks deliberate. The launcher prints the reason.
     */
    const empty = runDeskbarCss(path.join(ROOT, 'no', 'such', 'dir'));
    expect(empty).toBe('');
    const fn = sh.slice(sh.indexOf('function deskbarCss()'),
                        sh.indexOf("\napp.get('/deskbar.css'"));
    expect(fn).toContain('console.warn');
    expect(fn).toContain('DESKBAR markers');
  });
});

describe('what the launcher injects', () => {
  test('the shared script, before the patch that calls into it', () => {
    const tag = sh.slice(sh.indexOf("const tag = '<link rel=\"stylesheet\" href=\"/deskbar.css\">'"),
                         sh.indexOf('res.type(\'html\').send(html.includes'));
    expect(tag).toContain('/deskbar.css');
    expect(tag.indexOf('/desk.js')).toBeLessThan(tag.indexOf('/_patch.js'));
  });

  test('the registry, from the one file every other page reads', () => {
    expect(sh).toContain("app.get('/api/tools'");
    expect(sh).toContain("'tools.config.json'");
  });

  test('and that route never throws', () => {
    // The bar is how you leave a page. A typo in a JSON file must not take the
    // exits off the journal.
    /*
     * To the route's OWN closing brace at column 0 — `res.json({ … });` inside
     * it also ends in `});`, so a slice to the first one stopped before the
     * catch and would have passed on any route that merely returned JSON.
     */
    const at = sh.indexOf("app.get('/api/tools'");
    const fn = sh.slice(at, sh.indexOf('\n});', at));
    expect(fn).toContain('catch');
    expect(fn).toContain('ok: false');
  });

  test('the launcher is told where this repo is', () => {
    // Without it the three routes have nothing to read and say so.
    expect(sh).toContain('DESK_REPO="$REPO"');
    expect(sh).toContain("const DESK = process.env.DESK_REPO || '';");
  });
});

describe('what the patch does on the page', () => {
  test('it draws the bar once, however often the page re-renders', () => {
    /*
     * The journal re-renders its container on every filter change and
     * decorate() runs again each time. Without the id check that is one bar
     * per redraw, stacking down the page.
     */
    const fn = patch.slice(patch.indexOf('function appBar()'),
                           patch.indexOf('\n  }', patch.indexOf('function appBar()')));
    expect(fn).toContain("if (document.getElementById('deskbar')) return;");
    expect(fn).toContain("deskAppBar('JOURNAL', { self: false })");
    // self:false — its own process on its own port, so "/" here is the journal
    // and home has to be built from the registry rather than assumed.
    expect(fn).not.toContain('self: true');
  });

  test('it does nothing at all if the shared script did not load', () => {
    // A ReferenceError at the top of decorate() would take the delete fix, the
    // chart button and the import button down with it.
    const fn = patch.slice(patch.indexOf('function appBar()'),
                           patch.indexOf('\n  }', patch.indexOf('function appBar()')));
    expect(fn).toContain("typeof deskAppBar !== 'function'");
  });

  test('the old back-link goes ONLY once the bar has really drawn', () => {
    /*
     * Two ways home in one header is the clutter the bar exists to end — but
     * removing the link on a browser where the bar failed would leave the
     * journal with no exit at all, which is worse than the clutter.
     */
    const fn = patch.slice(patch.indexOf('function fixDashboardLink()'),
                           patch.indexOf('\n  }', patch.indexOf('function fixDashboardLink()')));
    expect(fn).toContain("bar.querySelector('.dk-app')");
    expect(fn).toContain('a.remove()');
    // …and the fallback still rewrites the link to the landing page.
    expect(fn).toContain('LANDING_PORT');
  });

  test('the bar is drawn before the link is judged', () => {
    // Otherwise fixDashboardLink always finds no bar and never removes it.
    const start = patch.indexOf('appBar();');
    expect(start).toBeGreaterThan(-1);
    expect(start).toBeLessThan(patch.indexOf('fixDashboardLink();', start));
  });
});

/*
 * A DEPLOY THAT DOES NOT CHECK ITS OWN WORK.
 *
 * This script added three routes for the bar — the sliced stylesheet, the
 * shared script, the registry — and verified none of them. It printed three
 * green 200s for the trades API, the patch tag and the calendar, said nothing
 * about the bar, and reported a clean deploy. The file's own header warns
 * about exactly this shape ("a deploy script that only takes effect on the
 * NEXT deploy is a trap with no floor") and it caught nobody, because nothing
 * looked.
 *
 * Each route fails differently and all three fail invisibly:
 *
 *     no stylesheet   an unstyled row of four links
 *     no script       no bar at all
 *     no registry     a bar reading "app list unreadable"
 */
describe('the deploy checks the bar it just installed', () => {
  test('it asks for all three routes by name', () => {
    for (const route of ['/deskbar.css', '/desk.js', '/api/tools']) {
      expect({ route, checked: sh.includes(`localhost:$PORT${route}`) })
        .toEqual({ route, checked: true });
    }
  });

  test('the stylesheet is checked for CONTENT, not for a 200', () => {
    /*
     * deskbarCss() returns the empty string — with a 200 — when its markers
     * have moved. A status check would pass on the exact failure it exists to
     * catch, which is the same fault the calendar check was written to fix:
     * "a verification that cannot fail is not one".
     */
    const block = sh.slice(sh.indexOf("echo -n 'app bar stylesheet"),
                           sh.indexOf("echo -n 'app bar script"));
    expect(block).toContain('.dk-app');
    expect(block).toContain('-z "$_css"');
    // …and it says which of the two went wrong, not just that something did.
    expect(block).toContain('DESKBAR markers');
  });

  test('the script is checked for the function, not for bytes', () => {
    const block = sh.slice(sh.indexOf("echo -n 'app bar script"),
                           sh.indexOf("echo -n 'app bar programs"));
    expect(block).toContain('function deskAppBar');
    expect(block).toContain('DESK_REPO is wrong');
  });

  test('the registry check names the programs it found', () => {
    // "ok" proves nothing here — an empty apps list is a 200 with ok:true.
    const block = sh.slice(sh.indexOf("echo -n 'app bar programs"),
                           sh.indexOf('# ── AND THE CALENDAR FIX'));
    expect(block).toContain('apps');
    expect(block).toContain('NONE');
  });

  test('none of it can fail the deploy', () => {
    /*
     * The journal is already running by this point; these are reports, not
     * gates. A `set -e` script that exits on a failed curl would leave a
     * working journal looking like a failed deploy.
     */
    const block = sh.slice(sh.indexOf("echo -n 'app bar stylesheet"),
                           sh.indexOf('# ── AND THE CALENDAR FIX'));
    /*
     * STATEMENTS, NOT LINES. A `||` guard sits at the end of the whole
     * pipeline, which may be three backslash-continued lines below the curl
     * that starts it — reading line by line reports a guarded command as
     * unguarded, which is a test that fails on correct code.
     */
    const statements = block
      .replace(/\\\n\s*/g, ' ')            // join continuations
      .split('\n')
      // `curl` ANYWHERE in the statement, because half of these are
      // `_x=$(curl …)` and a filter anchored at the start silently checks only
      // the others — but NOT in a comment, which is prose about a command and
      // not a command.
      .filter(l => /\bcurl\b/.test(l) && !l.trim().startsWith('#'));
    expect(statements.length).toBeGreaterThanOrEqual(3);
    for (const c of statements) {
      expect({ c: c.trim().slice(0, 48), guarded: /\|\|/.test(c) })
        .toEqual({ c: c.trim().slice(0, 48), guarded: true });
    }
  });
});
