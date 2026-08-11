/*
 * Public addresses for apps, from data/app-urls.json.
 *
 * This exists for one concrete failure. The alerts app has to be reached over
 * https, because a browser refuses Notification.requestPermission() to a page
 * on a plain http origin — that refusal is the whole reason a certificate was
 * obtained. But the landing page builds every app link from its OWN protocol
 * and host, and the landing page is still http. So the card would send every
 * visit back to http://<ip>:3090, where the prompt is refused again, with a
 * working certificate sitting unused. An app therefore has to be able to say
 * where it actually lives.
 *
 * Why not tools.config.json: that file is committed, and a domain belongs to
 * whoever deployed the box. Editing a tracked file on the server also makes the
 * next `git pull` refuse to run, which turns a cosmetic link into a deployment
 * that has to be untangled by hand. data/ is gitignored.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const FILE = path.join(ROOT, 'data', 'app-urls.json');

let saved = null;
beforeAll(() => {
  try { saved = fs.readFileSync(FILE, 'utf8'); } catch { saved = null; }
});
afterEach(() => { try { fs.unlinkSync(FILE); } catch { /* absent */ } });
afterAll(() => {
  if (saved !== null) fs.writeFileSync(FILE, saved);
  else { try { fs.unlinkSync(FILE); } catch { /* absent */ } }
});

function loadConfig(contents) {
  if (contents === null) { try { fs.unlinkSync(FILE); } catch { /* absent */ } }
  else {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE, contents);
  }
  // jest keeps its own module registry; deleting from require.cache does not
  // reach it, and every load after the first would quietly return the first
  // test's config — which is a test that passes by not running.
  jest.resetModules();
  return require('../src/config');
}

function alerts(cfg) { return cfg.apps.find(a => a.id === 'ALERTS'); }

describe('app URL overrides', () => {
  test('an address in the file lands on the app', () => {
    const cfg = loadConfig(JSON.stringify({ ALERTS: 'https://example.duckdns.org' }));
    expect(alerts(cfg).url).toBe('https://example.duckdns.org');
  });

  test('apps not named in the file are left on host:port', () => {
    const cfg = loadConfig(JSON.stringify({ ALERTS: 'https://example.duckdns.org' }));
    expect(cfg.apps.find(a => a.id === 'QP').url).toBeUndefined();
  });

  test('no file at all leaves every app as it was', () => {
    const cfg = loadConfig(null);
    expect(cfg.apps.every(a => a.url === undefined)).toBe(true);
    // And the ports are still there — the fallback the page builds links from.
    expect(alerts(cfg).port).toBe(3090);
  });

  /*
   * The failure modes all have to be survivable. This file is written by a
   * deploy script on a server; if a half-written or hand-edited copy could stop
   * the tool booting, the landing page would have taken the screeners down.
   */
  test('malformed JSON does not stop the tool loading', () => {
    const cfg = loadConfig('{ this is not json');
    expect(cfg.apps.length).toBeGreaterThan(0);
    expect(alerts(cfg).url).toBeUndefined();
  });

  test('a non-string address is ignored', () => {
    const cfg = loadConfig(JSON.stringify({ ALERTS: 3090 }));
    expect(alerts(cfg).url).toBeUndefined();
  });

  /*
   * Only http and https. The link is written straight into an href on a page,
   * so a value here is a value the browser will be asked to navigate to —
   * javascript: is the obvious thing not to hand it, and a bare hostname with
   * no scheme silently resolves as a relative path against the landing page.
   */
  test('a scheme that is not http or https is refused', () => {
    for (const bad of ['javascript:alert(1)', 'example.duckdns.org', 'ftp://x.y', '']) {
      expect(alerts(loadConfig(JSON.stringify({ ALERTS: bad }))).url).toBeUndefined();
    }
  });

  test('http is allowed — a box with no certificate can still redirect a card', () => {
    expect(alerts(loadConfig(JSON.stringify({ ALERTS: 'http://10.0.0.4:3090' }))).url)
      .toBe('http://10.0.0.4:3090');
  });
});
