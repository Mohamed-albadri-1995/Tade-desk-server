/*
 * A DEPLOY THAT THE BROWSER DID NOT TAKE.
 *
 * REPORTED AS: "If I click 1 time it took me to the landing page if I press
 * again it took me to correct page."
 *
 * The Screeners link had been fixed, pushed, pulled and restarted. Every
 * server was serving the new desk.js. The page in front of the reader was
 * still running the old one, so its first press used the old address and
 * landed on the landing page — and the SECOND press was made from that landing
 * page, whose copy had just been fetched, and went where it said. Two presses,
 * two different versions of the same file, and nothing in any log to see.
 *
 * desk.js and desk.css are not assets in the sense the caching rule meant.
 * They are the NAVIGATION: every link from any program to any other is a
 * string desk.js computes, one copy is shared by four servers on four origins,
 * and they change on exactly the deploys that change where things are. A stale
 * copy is a bar full of addresses that no longer exist.
 *
 * WHY EACH SERVER GOT IT WRONG DIFFERENTLY, which is why this is checked on
 * all four rather than in one place:
 *
 *   the screener   no-cache, but only for HTML — desk.js has an extension
 *   the algo page  no cache middleware at all; express's `public, max-age=0`
 *   qp             StaticFiles sends NO Cache-Control, so the browser guesses
 *                  a lifetime from the file's age. For a week-old file, hours.
 *   the journal    served from the repo on every request, which updates the
 *                  SERVER on a git pull and does nothing for the browser
 *
 * `no-cache` is not `no-store`. The file is kept and asked about; the answer is
 * a 304 nearly every time; the cost is one round trip on eighteen kilobytes.
 */

process.env.DB_PATH = require('path').join(require('os').tmpdir(), `nocache-${process.pid}.db`);
process.env.TOOL_ID = 'T1';

const fs = require('fs');
const path = require('path');
const request = require('supertest');

const ROOT = path.join(__dirname, '..');
const { SHARED_ASSETS, isSharedAsset } = require('../src/utils/sharedAssets');

/** `no-cache` present, in whatever order the directives were written. */
const revalidates = v => /no-cache/.test(String(v || ''));

afterAll(() => {
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(process.env.DB_PATH + suffix); } catch { /* gone */ }
  }
});

describe('which files this is about', () => {
  test('the two shared ones, and they exist', () => {
    expect(SHARED_ASSETS).toEqual(['/desk.js', '/desk.css']);
    for (const f of SHARED_ASSETS) {
      expect({ f, onDisk: fs.existsSync(path.join(ROOT, 'public', f)) })
        .toEqual({ f, onDisk: true });
    }
  });

  test('and nothing else — every other asset keeps normal caching', () => {
    for (const p of ['/app.js', '/desk.js.map', '/lightweight-charts.js',
                     '/alerts.html', '/', '/deskjs']) {
      expect({ p, shared: isSharedAsset(p) })
        .toEqual({ p, shared: p === '/desk.js' });
    }
    // A path that is not a string is not a shared asset, and is not a crash.
    for (const p of [null, undefined, 0]) expect(isSharedAsset(p)).toBe(false);
  });
});

/*
 * THE TWO NODE SERVERS ARE RUN, not read. The bug lives in the ORDER of the
 * handlers — a middleware mounted after express.static never sees the request
 * that static already answered — and a test that read the source would pass on
 * a server that was still sending the old header.
 */
describe('the servers that hand out the navigation', () => {
  const cases = [
    ['the screener suite', () => require('../src/index'), SHARED_ASSETS],
    ['the algo page', () => require('../src/alerts/server'), SHARED_ASSETS],
  ];

  for (const [name, load, paths] of cases) {
    describe(name, () => {
      let app;
      beforeAll(() => { app = load(); });

      for (const p of paths) {
        test(`${p} is revalidated before it is used`, async () => {
          const r = await request(app).get(p);
          expect({ p, status: r.status }).toEqual({ p, status: 200 });
          expect({ p, cache: r.headers['cache-control'] })
            .toEqual({ p, cache: expect.stringMatching(/no-cache/) });
        });
      }

      test('and it is really the shared file, not the SPA fallback', async () => {
        /*
         * BOTH of these servers answer an unknown path with a page of HTML.
         * A desk.js route that had been removed would still return 200 with a
         * Cache-Control header on it — a test that checked only the header
         * would pass while the bar had no script at all.
         */
        const r = await request(app).get('/desk.js');
        expect(r.text).toContain('function deskAppBar');
        expect(r.text).not.toContain('<html');
      });

      test('an ordinary asset is NOT put on no-cache', async () => {
        // The rule is narrow on purpose. Turning off caching for everything
        // this server sends would be a different and much worse change.
        const r = await request(app).get('/lightweight-charts.js');
        if (r.status !== 200) return;      // not every server carries it
        expect(revalidates(r.headers['cache-control'])).toBe(false);
      });
    });
  }
});

/*
 * THE JOURNAL is a separate app, written out by deploy/journal-tool.sh into
 * ~/journal-app. Its two routes are pulled out of the script and RUN — the
 * header has to be set on the response the handler actually builds, and
 * `res.set(...).type(...).send(...)` only chains because express's set returns
 * res, which is exactly the kind of thing a substring cannot check.
 */
describe('the journal serves them from the repo, and says to ask', () => {
  const sh = fs.readFileSync(path.join(ROOT, 'deploy', 'journal-tool.sh'), 'utf8');

  /** Run one `app.get('<route>', …)` handler from the script. */
  function runRoute(route) {
    const at = sh.indexOf(`app.get('${route}'`);
    if (at < 0) {
      throw new Error(`deploy/journal-tool.sh no longer serves ${route} — the `
        + 'journal reads the shared navigation out of the desk repo');
    }
    /*
     * The end of the call is found by MATCHING the parenthesis, not by looking
     * for a `});` — one of these two routes is a one-liner ending in `}));`
     * and the other has a `;` on its first body line, so every landmark that
     * works for one cuts the other in the wrong place. Quotes are tracked so a
     * bracket inside a string cannot move the count.
     */
    const open = sh.indexOf('(', at);
    let depth = 0;
    let quote = '';
    let to = -1;
    for (let i = open; i < sh.length; i++) {
      const c = sh[i];
      if (quote) { if (c === '\\') i++; else if (c === quote) quote = ''; continue; }
      if (c === '\'' || c === '"' || c === '`') { quote = c; continue; }
      if (c === '(') depth++;
      else if (c === ')' && --depth === 0) { to = i + 1; break; }
    }
    if (to < 0) throw new Error(`deploy/journal-tool.sh: ${route} does not close`);
    if (sh[to] === ';') to++;
    const out = { headers: {}, body: null, type: null };
    const res = {
      set(k, v) { out.headers[String(k).toLowerCase()] = v; return res; },
      type(t) { out.type = t; return res; },
      send(b) { out.body = b; return res; },
      sendFile(f) { out.body = `<file ${f}>`; return res; },
    };
    // The route, unwrapped from app.get(…) into the bare handler it holds.
    const handler = sh.slice(at, to)
      .replace(/^app\.get\([^,]+,\s*/, '')
      .replace(/\);\s*$/, '');
    // SHARED_NO_CACHE is read from the script rather than written here, so a
    // route that stopped using it cannot be rescued by this test's own copy.
    const decl = sh.slice(sh.indexOf('const SHARED_NO_CACHE ='));
    // eslint-disable-next-line no-new-func
    new Function('res', 'fs', 'path', 'deskbarCss',
      `${decl.slice(0, decl.indexOf('\n') + 1)}const DESK = '';\n`
      + `const h = ${handler};\nh({}, res);`)(res, fs, path, () => 'css');
    return out;
  }

  for (const route of ['/desk.js', '/deskbar.css']) {
    test(`${route} is revalidated before it is used`, () => {
      const out = runRoute(route);
      expect({ route, cache: out.headers['cache-control'] })
        .toEqual({ route, cache: expect.stringMatching(/no-cache/) });
    });
  }

  test('the header is set even when the desk repo is not configured', () => {
    /*
     * AN ERROR IS NEVER A ZERO. With DESK unset the route answers with a
     * placeholder rather than the file — and that placeholder is the thing
     * most important not to cache, because the moment DESK_REPO is fixed the
     * browser has to notice.
     */
    const out = runRoute('/desk.js');
    expect(out.body).toContain('desk repo not configured');
    expect(revalidates(out.headers['cache-control'])).toBe(true);
  });
});

/*
 * QP is Python and has no cache middleware to inherit — Starlette's
 * StaticFiles sends an ETag and a Last-Modified and no Cache-Control at all,
 * which is the one of the four that can go stale for HOURS without asking.
 * The Python side runs its own test; this pins that the rule is there and
 * names the same two files under the prefix qp mounts them at.
 */
test('qp names the same two files, under its own prefix', () => {
  const py = fs.readFileSync(path.join(ROOT, 'quant-platform', 'chart', 'server.py'), 'utf8');
  expect(py).toContain("_SHARED_ASSETS = ('/static/desk.js', '/static/desk.css')");
  for (const f of SHARED_ASSETS) expect(py).toContain(`'/static${f}'`);
  expect(py).toContain("@app.middleware('http')");
});
