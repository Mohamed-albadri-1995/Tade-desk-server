/*
 * "feeds: alpaca ok" MEANT A KEY WAS IN A FILE.
 *
 * deploy-tools.sh printed this on every deploy, as the last word on whether
 * the morning was safe to trade:
 *
 *     feeds: alpaca ok · polygon ok · yahoo ok
 *
 * It read /api/health, whose `feeds` block is `_feed_status()` — an inventory
 * of CREDENTIALS. That function's own docstring already says why that is not
 * enough: "A key being PRESENT is not evidence that the plan behind it
 * includes the data being asked for." It was written after Polygon 403'd every
 * 1-minute request while the inventory called polygon the best feed available.
 * The lesson was written down and the deploy line went on printing the
 * inventory anyway.
 *
 * So it said "alpaca ok" every single day while the desk's key was refused:
 *
 *     Alpaca asset MMED 401: {"message": "unauthorized."}
 *
 * A 401 is not a plan limit — the credential was not accepted at all. A field
 * that says the same thing whatever happened, in the one line anybody reads
 * before the open. It is also why the short-borrow check never ran once, which
 * is how MMED reached the wire on 2026-09-15 as an order the broker could not
 * fill.
 *
 * AND IT ONLY RAN WHEN qp WAS RESTARTED. The check lived inside the "qp was
 * stale, restarted it, it came back" branch, so on every deploy where qp was
 * already current it printed nothing at all — which is the exact fault stated
 * thirty lines above it about the staleness warning: "A warning about an event
 * cannot detect a STATE."
 *
 * THE REPORTER IS RUN HERE, NOT GREPPED FOR. A substring search cannot verify
 * behaviour: this is a node program embedded in a shell string, and a stray
 * quote, a swallowed branch or an inverted test all leave the text reading
 * correctly while the deploy prints a pass over a dead feed.
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'deploy-tools.sh'), 'utf8');

/** The reporter, lifted out of the [6c/6] step exactly as the deploy runs it. */
function reporter() {
  const i = SRC.indexOf('[6c/6] Feeds');
  expect(i).toBeGreaterThan(-1);
  const j = SRC.indexOf('node -e "', i) + 'node -e "'.length;
  const k = SRC.indexOf('});" 2>/dev/null', j) + '});'.length;
  return SRC.slice(j, k);
}

/** Feed it a payload and collect what the deploy would print. */
function report(payload) {
  return execFileSync('node', ['-e', reporter()], {
    input: typeof payload === 'string' ? payload : JSON.stringify(payload),
    encoding: 'utf8',
  });
}

const GOOD = (feed, ms) => ({ feed, ok: true, ms });
const DEAD = (feed, detail, fix) => ({ feed, ok: false, ms: 90, detail, fix });

describe('a feed that answered is reported differently from one that did not', () => {
  test('every feed answering reads as answered', () => {
    const out = report({ feeds: [GOOD('alpaca', 210), GOOD('polygon', 180), GOOD('yahoo', 95)] });
    expect(out).toMatch(/alpaca ANSWERED/);
    expect(out).toMatch(/polygon ANSWERED/);
    expect(out).toMatch(/yahoo ANSWERED/);
  });

  /*
   * THE ONE THAT WAS BROKEN. This exact morning printed "alpaca ok".
   */
  test('a 401 reads as FAILED, never as ok', () => {
    const out = report({ feeds: [
      DEAD('alpaca', 'alpaca:SPY 401: {"message": "unauthorized."}',
           'check APCA_API_KEY_ID in quant-platform/.env'),
      GOOD('polygon', 180), GOOD('yahoo', 95)] });
    expect(out).toMatch(/alpaca FAILED/);
    expect(out).not.toMatch(/alpaca ok/);
    expect(out).not.toMatch(/alpaca ANSWERED/);
  });

  test('the reason is printed, not summarised away', () => {
    const out = report({ feeds: [DEAD('alpaca', 'alpaca:SPY 401: unauthorized.'), GOOD('yahoo', 95)] });
    expect(out).toMatch(/401/);
  });

  test('and the fix, when there is one', () => {
    const out = report({ feeds: [DEAD('alpaca', 'nope', 'check APCA_API_KEY_ID'), GOOD('yahoo', 9)] });
    expect(out).toMatch(/fix: check APCA_API_KEY_ID/);
  });

  /*
   * THE CONSEQUENCE, NOT JUST THE STATUS. "alpaca FAILED" is a fact; a setup
   * quietly deciding on a different feed than it was backtested on is what it
   * costs, and that is the whole reason live stops matching the backtest.
   */
  test('it says what a dead alpaca costs a setup', () => {
    const out = report({ feeds: [DEAD('alpaca', 'nope'), GOOD('yahoo', 9)] });
    expect(out).toMatch(/will decide on whatever it falls back to/);
  });

  test('and says nothing of the sort when alpaca is fine', () => {
    const out = report({ feeds: [GOOD('alpaca', 9), GOOD('yahoo', 9)] });
    expect(out).not.toMatch(/falls back to/);
  });

  test('a working feed beside a dead one is still reported as working', () => {
    const out = report({ feeds: [DEAD('alpaca', 'nope'), GOOD('yahoo', 95)] });
    expect(out).toMatch(/yahoo ANSWERED/);
  });

  test('the time is shown, so a feed that answers slowly is visible', () => {
    expect(report({ feeds: [GOOD('yahoo', 4310)] })).toMatch(/4310ms/);
  });
});

describe('a check that could not run is not a pass', () => {
  /*
   * AN ERROR IS NEVER A ZERO, and a silence is never an ok. qp being
   * unreachable is the case most likely to be misread, because the deploy
   * around it is otherwise succeeding.
   */
  test('no answer from qp says COULD NOT CHECK', () => {
    const out = report('');
    expect(out).toMatch(/COULD NOT CHECK/);
    expect(out).not.toMatch(/ANSWERED/);
  });

  test('and says plainly that it is not a verdict on the feeds', () => {
    expect(report('')).toMatch(/It says nobody asked/);
  });

  test('garbage from qp is not a pass either', () => {
    expect(report('<html>502 Bad Gateway</html>')).toMatch(/COULD NOT CHECK/);
  });

  /*
   * AN EMPTY LIST IS THE SUBTLE ONE: valid JSON, ok:true, and nothing checked.
   * Under a naive reader that prints a clean empty line and reads as fine.
   */
  test('valid JSON with no feeds in it is not a pass', () => {
    const out = report({ ok: true, feeds: [] });
    expect(out).toMatch(/COULD NOT CHECK/);
  });

  test('a missing feeds key is not a pass', () => {
    expect(report({ ok: true })).toMatch(/COULD NOT CHECK/);
  });
});

describe('the step runs on every deploy, not only when qp restarts', () => {
  /*
   * The reporter being right is worth nothing if it only runs on the deploy
   * that happens to restart qp. This can only be read from the text, because
   * the surrounding branch cannot be executed here.
   */
  test('it is its own step, outside the restart branch', () => {
    expect(SRC).toMatch(/\[6c\/6\] Feeds/);
    const step = SRC.indexOf('[6c/6] Feeds');
    const restartBranch = SRC.indexOf('bash deploy/qp-restart.sh');
    expect(step).toBeGreaterThan(restartBranch);
    // Past the `fi` that closes the qp block — the step is at top level.
    expect(SRC.slice(restartBranch, step)).toMatch(/\nfi\n/);
  });

  test('it asks the endpoint that fetches, not the credential inventory', () => {
    const step = SRC.slice(SRC.indexOf('[6c/6] Feeds'), SRC.indexOf('[6d/6]'));
    expect(step).toMatch(/api\/feedcheck/);
    expect(step).not.toMatch(/api\/health/);
  });

  test('the old inventory line is gone from the script entirely', () => {
    expect(SRC).not.toMatch(/feeds: alpaca '\+y\('alpaca'\)/);
    expect(SRC).not.toMatch(/\?'ok':'no key'/);
  });

  /*
   * IT MUST NOT FAIL THE DEPLOY. The script runs under `set -e`, and a feed
   * being down is a thing to be told about, not a reason to leave the tools
   * half-started.
   */
  test('a failed request cannot end the deploy', () => {
    const step = SRC.slice(SRC.indexOf('[6c/6] Feeds'), SRC.indexOf('[6d/6]'));
    expect(step).toMatch(/\|\| echo/);
  });
});
