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

  /*
   * YAHOO IS STILL THE ANSWER WITH NO KEYS, which is the correction this file
   * was written for: delayed data that arrives beats deeper data that 403s.
   * The fallback now prefers the polygon+yahoo join FIRST when a Polygon key
   * exists — the only feed that answers both halves of the question, a year to
   * test against and today to decide from — and yahoo remains the floor.
   */
  test('falls back to yahoo, which needs no plan at all', () => {
    expect(QP).toMatch(/else:\n {8}default = 'yahoo'/);
  });

  test('...and prefers the join only when polygon is actually configured', () => {
    expect(QP).toMatch(/elif have\.get\('hybrid_yahoo'\):\n {8}default = 'hybrid_yahoo'/);
    expect(QP).toMatch(/'hybrid_yahoo': has_polygon/);
  });

  /*
   * A CHOSEN FEED WITH NO CREDENTIAL IS NOT A DEFAULT. That is how this broke
   * the first time — a default pointing at a feed that cannot answer — so the
   * choice is only honoured when the feed is actually configured.
   */
  test('a chosen feed is only used when it is configured', () => {
    expect(QP).toMatch(/if chosen and have\.get\(chosen\):\n {8}default = chosen/);
  });

  /*
   * "chosen" and "fell back" are different facts and a page that showed them
   * identically would present a guess as a decision — which is the whole bug.
   */
  /*
   * AND IT NAMES THE FEED, rather than a word written once. This test used to
   * require the sentence "falling back to yahoo" — which is what the page said
   * whatever the fallback actually was. The fallback above prefers
   * hybrid_yahoo whenever a Polygon key exists, so on a box with one the note
   * contradicted the dropdown three centimetres above it: the control read
   * hybrid_yahoo and the note said yahoo. The test was enforcing the bug.
   */
  test('it says whether it was chosen or fallen back to', () => {
    expect(QP).toMatch(/'default_chosen'/);
    expect(PAGE).toMatch(/not chosen — falling back to <b>\$\{esc\(d\.defaultFeed\)\}<\/b>/);
    expect(PAGE).toMatch(/chosen — <b>\$\{esc\(d\.defaultFeed\)\}<\/b>/);
    // …and never as a literal again. (The phrase survives in the comment that
    // records why, which is not what the page prints.)
    expect(PAGE).not.toMatch(/falling back to yahoo\./);
  });

  /*
   * WHICH SETTING THIS IS. The trader asked where "the real setup data feed"
   * lives and whether it is in qp or on the desk, and the honest answer is
   * that this control is neither: it is the CHART's and the BACKTEST's. A live
   * setup decides on the feed on its own card. Saying so here is cheaper than
   * discovering it from a morning that did not fire.
   */
  test('and says that a live setup does not read it', () => {
    expect(PAGE).toMatch(/feed for CHARTS and BACKTESTS/);
    expect(PAGE).toMatch(/its own card, which is a separate setting/);
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
