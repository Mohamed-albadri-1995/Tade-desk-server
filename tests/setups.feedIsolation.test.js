/*
 * CHANGING qp's DEFAULT FEED MUST NOT MOVE THE DESK.
 *
 * qp has a default feed, and it just changed: with a Polygon key configured it
 * now resolves to `hybrid_yahoo` (Polygon's history joined to Yahoo for the
 * minutes Polygon has not published yet) instead of `yahoo`.
 *
 * That default exists for CHARTS and BACKTESTS — a person opening qp and
 * getting the best available data without choosing. It must not reach the
 * decision or the management of a live position, for one reason:
 *
 *     THE FEED IS PART OF THE STRATEGY. A setup's stop is session VWAP, and
 *     VWAP is built from volume, so the feed decides where the stop is. A
 *     backtest justified on one feed and a live trade taken on another are two
 *     different strategies wearing one name — which is the whole fault the
 *     parity work exists to catch.
 *
 * So the desk names its feed explicitly, per setup, and falls back to a
 * LITERAL when a setup does not: never to whatever qp happens to prefer today.
 * A change to qp's default would otherwise silently re-point every setup that
 * had not named one, including the trade manager, which is the one loop that
 * decides when to CLOSE a position.
 *
 * These are source-shape tests on purpose. The property is "this code does not
 * read that value", and the only way to check a thing is not read is to look.
 */

const fs = require('fs');
const path = require('path');

const read = f => fs.readFileSync(path.join(__dirname, '..', 'src', 'setups', f), 'utf8');
const RUNNER = read('runner.js');
const MANAGER = read('manager.js');
const QPCLIENT = read('qpClient.js');

describe('the entry decision', () => {
  test('names its own feed, falling back to a literal', () => {
    expect(RUNNER).toMatch(/feed: setup\.feed \|\| 'yahoo'/);
  });

  test('and never asks qp what its default is', () => {
    expect(RUNNER).not.toMatch(/default_feed|defaultFeed/);
    expect(RUNNER).not.toMatch(/api\/health/);
  });
});

describe('the trade manager — the loop that decides when to CLOSE', () => {
  /*
   * The one the user asked about by name, and the one where a silent feed
   * change costs the most: this loop trails the stop and watches for the exit
   * rule. Move the feed and the VWAP moves, so the stop moves, so a position
   * closes on a level the strategy never chose.
   */
  test('manages a position on the SETUP’s feed, not the platform’s', () => {
    expect(MANAGER).toMatch(/feed: found\.setup\.feed \|\| 'yahoo'/);
  });

  test('and never asks qp what its default is', () => {
    expect(MANAGER).not.toMatch(/default_feed|defaultFeed/);
    expect(MANAGER).not.toMatch(/api\/health/);
  });

  /*
   * The entry and the exit must agree with EACH OTHER as well. A position
   * entered on one feed and managed on another is a stop computed from
   * different volume than the one the size was chosen from.
   */
  test('...and it is the same fallback the entry uses', () => {
    const entry = /feed: setup\.feed \|\| '(\w+)'/.exec(RUNNER);
    const exit = /feed: found\.setup\.feed \|\| '(\w+)'/.exec(MANAGER);
    expect(entry).not.toBeNull();
    expect(exit).not.toBeNull();
    expect(exit[1]).toBe(entry[1]);
  });
});

describe('the qp client', () => {
  /*
   * The default here is the last line of defence: if a caller ever forgets to
   * pass a feed, it must land on a named one rather than on "whatever qp
   * prefers". A parameter default is inspectable; a remote lookup is not.
   */
  test('its own defaults are literals, not a lookup', () => {
    expect(QPCLIENT).toMatch(/feed = 'yahoo'/);
    expect(QPCLIENT).not.toMatch(/default_feed|defaultFeed/);
  });

  test('and every call sends a feed, so qp never has to choose', () => {
    // decide() and manage() both put `feed` in the body.
    const bodies = QPCLIENT.match(/feed[,:]/g) || [];
    expect(bodies.length).toBeGreaterThanOrEqual(2);
  });
});

describe('where the platform default IS allowed to be read', () => {
  /*
   * One place: the alerts page's feed dropdown, to preselect an option. That is
   * a display default for a human about to choose, not an input to a trade.
   */
  test('only the page that offers a choice reads it', () => {
    const server = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'alerts', 'server.js'), 'utf8');
    expect(server).toMatch(/defaultFeed: d\.default_feed/);
    const page = fs.readFileSync(
      path.join(__dirname, '..', 'public', 'alerts.html'), 'utf8');
    expect(page).toMatch(/d\.defaultFeed/);
  });

  test('and nothing in src/setups or src/broker does', () => {
    const dirs = ['setups', 'broker'];
    for (const d of dirs) {
      const dir = path.join(__dirname, '..', 'src', d);
      for (const f of fs.readdirSync(dir).filter(x => x.endsWith('.js'))) {
        const src = fs.readFileSync(path.join(dir, f), 'utf8');
        expect(`${d}/${f}:${/default_feed|defaultFeed/.test(src)}`)
          .toBe(`${d}/${f}:false`);
      }
    }
  });
});
