/*
 * What the account actually paid, on the journal card.
 *
 * The journal records what a trade was MEANT to be — the price the strategy
 * decided on. Alpaca knows what the money did. The two differ by the minute
 * between the decision bar's close and the market order, and by whatever the
 * spread took, and nothing had ever put the two numbers next to each other.
 *
 * WHY THIS IS A SOURCE TEST AND NOT A DOM TEST.
 *
 * The journal app is a separate codebase with no shared history, deliberately
 * left untouched; everything added to it lives in deploy/journal/patch.js and is
 * injected at serve time. Running that in jest would need jsdom, which is not a
 * dependency here and would have to be installed on the box to deploy. The
 * repo's other page tests (alerts.page.tabs, home.levels) assert on the source
 * for the same reason.
 *
 * SO THE BEHAVIOUR WAS VERIFIED IN A REAL BROWSER instead — headless Chromium,
 * four cards, a stubbed desk — and this is what it rendered:
 *
 *   EYPT long   bought 351 @ 5.42 · sold 351 @ 5.6 · realised +63.18
 *                                              · vs 5.39 planned: +0.03
 *   CAPR short  sold 100 @ 5.42 · STILL OPEN   · vs 5.39 planned: -0.03
 *   HALF        bought 200 @ 2.05 · sold 100 @ 2.2 · STILL OPEN
 *   ZZZZ        (no line at all — no Alpaca fill for that name)
 *
 * The second line is the one worth reading twice: a short that SOLD three cents
 * higher than planned reads as -0.03, which is BETTER. Unsigned, it and the
 * long above it would be identical.
 *
 * These tests hold the properties that verification depends on, so the file
 * cannot drift away from what was checked.
 */

const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'deploy', 'journal', 'patch.js'), 'utf8');

// ── it asks the right thing, of the right place ────────────────────────────

describe('where the fills come from', () => {
  test('the desk, on the alerts port, for the CARD\'s date', () => {
    expect(SRC).toMatch(/ALERTS_PORT\s*=\s*3090/);
    expect(SRC).toMatch(/\/api\/broker\/fills\?date=/);
    // The card's own date, not today's: the list can show several days at once
    // and one day's fills say nothing about another's.
    expect(SRC).toMatch(/fillsFor\(t\.date\)/);
  });

  /*
   * The card list re-renders on every keystroke in the ticker filter, so a
   * fetch per render would be a request per letter. Cached per date.
   */
  test('the answer is cached per date', () => {
    expect(SRC).toMatch(/fillsByDate/);
    expect(SRC).toMatch(/if \(fillsByDate\[date\]\) return fillsByDate\[date\]/);
  });

  /*
   * A FAILURE IS CACHED TOO — as an empty map. Retrying on every render turns
   * one unreachable desk into a request storm driven by the filter box.
   */
  test('a failure resolves to nothing rather than rejecting or retrying', () => {
    expect(SRC).toMatch(/\.catch\(function \(\) \{ return \{\}; \}\)/);
  });
});

// ── the arithmetic that matters ────────────────────────────────────────────

describe('the comparison', () => {
  /*
   * SIGNED AGAINST THE POSITION. Paying 5.42 for a long planned at 5.39 is
   * three cents worse; selling a short at 5.42 planned at 5.39 is three cents
   * BETTER. An unsigned difference reports the two identically and the whole
   * measurement is useless on a desk that trades both ways.
   *
   * The same rule as broker.slipOf() on the server, which has its own tests —
   * this is the browser's copy of it and the two must agree.
   */
  test('the slip is signed against the position, not against the number line', () => {
    expect(SRC).toMatch(/var raw = got - want;/);
    expect(SRC).toMatch(/t\.side === 'short' \? -raw : raw/);
  });

  test('a long reads its buy price, a short its sell price', () => {
    expect(SRC).toMatch(/g\.avgBuy != null && t\.side !== 'short' \? g\.avgBuy : g\.avgSell/);
  });

  /* No planned price, or no fill, means no comparison — not a comparison to 0. */
  test('it is only drawn when both numbers exist', () => {
    expect(SRC).toMatch(/if \(want > 0 && got > 0\)/);
  });

  test('the sign is shown, so "+" always means worse', () => {
    expect(SRC).toMatch(/n >= 0 \? '\+' : ''/);
  });
});

// ── what it must not do ────────────────────────────────────────────────────

describe('what it leaves alone', () => {
  /*
   * A realised number on a half-closed position is not a result, it is a
   * fragment that reads like one.
   */
  test('realised P&L only when the position is closed', () => {
    expect(SRC).toMatch(/if \(g\.closed\) bits\.push\('realised '/);
    expect(SRC).toMatch(/STILL OPEN at Alpaca/);
  });

  /*
   * SILENCE, NOT A ZERO. A name traded only at Trade The Pool has no Alpaca
   * fill; a "0" on a card is a number nobody made that reads as a result.
   */
  test('a name with no Alpaca fill gets no line', () => {
    expect(SRC).toMatch(/if \(!g\) return;/);
    expect(SRC).toMatch(/TTP5k is behind TraderEvolution/);
  });

  /*
   * It never REPLACES what the journal recorded. A card where the two disagree
   * is the interesting one, and overwriting the number hides the finding.
   */
  test('it appends a line and writes nothing back', () => {
    expect(SRC).toMatch(/card\.appendChild\(fillLine\(g, t\)\)/);
    expect(SRC).not.toMatch(/t\.entryPrice\s*=[^=]/);
    /*
     * The file DOES write now — the setup tag does, and only that. So this
     * checks the one thing it was always really about: no price or quantity the
     * journal recorded is ever sent back over Alpaca's version of it. The
     * disagreement is the finding, and overwriting either side hides it.
     */
    const writes = SRC.match(/body: JSON\.stringify\(\{[^}]*\}\)/g) || [];
    expect(writes).toEqual(['body: JSON.stringify({ setup_id: g.setupId })']);
  });

  /*
   * The list re-renders on every filter and sort, replacing innerHTML. Anything
   * added once survives exactly until the first keystroke — which is why the
   * existing chart button uses a MutationObserver, and why this rides the same
   * decorate() pass rather than running once.
   */
  test('it is added on every render, and only once per card', () => {
    expect(SRC).toMatch(/MutationObserver\(decorate\)/);
    expect(SRC).toMatch(/if \(card\.querySelector\('\.jnl-fill-line'\)\) return;/);
  });
});

// ── the endpoint it depends on ─────────────────────────────────────────────

describe('the endpoint behind it', () => {
  const SERVER = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'alerts', 'server.js'), 'utf8');

  test('exists, and is a GET so the page can read it cross-port', () => {
    expect(SERVER).toMatch(/app\.get\('\/api\/broker\/fills'/);
    // GETs on this app already carry Access-Control-Allow-Origin.
    expect(SERVER).toMatch(/if \(req\.method === 'GET'\) res\.set\('Access-Control-Allow-Origin'/);
  });

  /*
   * 200 with ok:false, never a 500. A journal page that got a 500 would show
   * nothing and say nothing, which reads as "no trades" rather than as "could
   * not ask" — and those are opposite facts.
   */
  test('a failure is ok:false, not a 500', () => {
    const at = SERVER.indexOf("app.get('/api/broker/fills'");
    const body = SERVER.slice(at, at + 1400);
    expect(body).toMatch(/res\.json\(\{ ok: false, error: err\.message \}\)/);
    expect(body).not.toMatch(/status\(5\d\d\)/);
  });

  test('it says which account it covers', () => {
    const at = SERVER.indexOf("app.get('/api/broker/fills'");
    expect(SERVER.slice(at, at + 1400)).toMatch(/scope: 'alpaca'/);
  });
});
