/*
 * Which feed everything defaults to — chosen, not guessed.
 *
 * THE BUG, paid for in a live session. qp picked its default by looking for a
 * key: `polygon if POLYGON_API_KEY else alpaca if ... else yahoo`. A key being
 * PRESENT is not evidence that the plan behind it includes the data being asked
 * for, and this one did not:
 *
 *     Polygon 403: {"status":"NOT_AUTHORIZED","message":"Your plan doesn't
 *     include this data timeframe. Please upgrade your plan"}
 *
 * So every 1-minute request failed while the platform reported polygon as the
 * best feed it had — the default pointed at the one feed that could not answer
 * the question the platform exists to answer, and said so nowhere.
 *
 * Nothing can test a plan's entitlements without spending a request on every
 * startup. So the guess is gone: yahoo unless somebody has CHOSEN otherwise,
 * and choosing is one control away.
 */

const fs = require('fs');
const path = require('path');

const QP = fs.readFileSync(
  path.join(__dirname, '..', 'quant-platform', 'tools', 'compare_server.py'), 'utf8');
const QP_SERVER = fs.readFileSync(
  path.join(__dirname, '..', 'quant-platform', 'chart', 'server.py'), 'utf8');
const SERVER = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'alerts', 'server.js'), 'utf8');
const PAGE = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'alerts.html'), 'utf8');

// ── the guess is gone ──────────────────────────────────────────────────────

describe('the default', () => {
  test('is no longer inferred from a key being present', () => {
    expect(QP).not.toMatch(/default = 'polygon' if has_polygon/);
  });

  test('falls back to yahoo, which needs no plan at all', () => {
    expect(QP).toMatch(/default = chosen if \(chosen and have\.get\(chosen\)\) else 'yahoo'/);
  });

  /*
   * A CHOSEN FEED WITH NO CREDENTIAL IS NOT A DEFAULT. That is how this broke
   * the first time — a default pointing at a feed that cannot answer — so the
   * choice is only honoured when the feed is actually configured.
   */
  test('a chosen feed is only used when it is configured', () => {
    expect(QP).toMatch(/chosen if \(chosen and have\.get\(chosen\)\)/);
  });

  /*
   * "chosen" and "fell back" are different facts and a page that showed them
   * identically would present a guess as a decision — which is the whole bug.
   */
  test('it says whether it was chosen or fallen back to', () => {
    expect(QP).toMatch(/'default_chosen'/);
    expect(PAGE).toMatch(/not chosen — falling back to yahoo/);
  });

  test('the reason is written down where the code is', () => {
    expect(QP).toMatch(/NOT_AUTHORIZED/);
    expect(QP).toMatch(/A key being PRESENT is not evidence/);
  });
});

// ── it survives a restart, and changes without one ─────────────────────────

describe('where the choice is kept', () => {
  /*
   * A FILE, not an env var: an env var cannot be changed from a page, and would
   * need a restart to take — which is exactly what was wanted here, since the
   * platform is a systemd service that a deploy does not touch.
   */
  test('a file, so it can change without a restart and survive one', () => {
    expect(QP).toMatch(/_FEED_PREF = Path\(__file__\)\.resolve\(\)\.parents\[1\] \/ '\.default-feed'/);
    expect(QP).toMatch(/def default_feed_override/);
  });

  test('an unknown feed is refused rather than stored', () => {
    expect(QP).toMatch(/if v not in _VALID_FEEDS:/);
    expect(QP).toMatch(/raise ValueError/);
  });

  /* A corrupt or missing file is "nobody has chosen", not a crash. */
  test('a missing or unreadable file reads as no choice', () => {
    expect(QP).toMatch(/except Exception:\n\s+return ''/);
  });
});

// ── the way it is changed ──────────────────────────────────────────────────

describe('the endpoint', () => {
  test('qp owns it, since qp owns the answer', () => {
    expect(QP_SERVER).toMatch(/@app\.post\('\/api\/settings\/default-feed'\)/);
  });

  /* 200 with ok:false — the caller is a page, and the reason beats the status. */
  test('a bad feed is a reason, not a 4xx', () => {
    const at = QP_SERVER.indexOf("@app.post('/api/settings/default-feed')");
    expect(QP_SERVER.slice(at, at + 1400)).toMatch(/status_code=200/);
  });

  /*
   * PROXIED THROUGH THE DESK. The page is served from 3090 and qp is on 8765,
   * so a direct call is cross-origin — and adding CORS to a service that can
   * move money in order to fix a dropdown is the wrong trade.
   */
  test('the desk proxies it rather than the browser calling qp', () => {
    expect(SERVER).toMatch(/app\.get\('\/api\/feed'/);
    expect(SERVER).toMatch(/app\.post\('\/api\/feed'/);
    expect(SERVER).toMatch(/a direct call is cross-origin/);
  });

  test('the desk keeps no second copy of the answer', () => {
    const at = SERVER.indexOf("app.get('/api/feed'");
    expect(SERVER.slice(at, at + 700)).toMatch(/\/api\/health/);
    expect(SERVER.slice(at, at + 700)).not.toMatch(/prefs\.|save\(/);
  });

  test('an unreachable qp is ok:false, not a 500', () => {
    const at = SERVER.indexOf("app.get('/api/feed'");
    const body = SERVER.slice(at, at + 700);
    expect(body).toMatch(/qp did not answer/);
    expect(body).not.toMatch(/status\(5\d\d\)/);
  });
});

// ── the control ────────────────────────────────────────────────────────────

describe('the control on the page', () => {
  test('there is one, and changing it saves', () => {
    expect(PAGE).toMatch(/<select id="feed" onchange="saveFeed\(\)">/);
    expect(PAGE).toMatch(/async function saveFeed/);
  });

  test('it is loaded at boot', () => {
    expect(PAGE).toMatch(/^loadFeed\(\);$/m);
  });

  /*
   * ONLY CONFIGURED FEEDS. Offering one with no credential is how the default
   * came to point at something that could not answer in the first place.
   */
  test('it offers only feeds that are actually configured', () => {
    expect(PAGE).toMatch(/Object\.keys\(d\.feeds\)\.filter\(k => d\.feeds\[k\]\)/);
  });

  test('an unreachable qp says so instead of showing an empty box', () => {
    expect(PAGE).toMatch(/sel\.innerHTML = '<option>unavailable<\/option>'/);
  });
});
