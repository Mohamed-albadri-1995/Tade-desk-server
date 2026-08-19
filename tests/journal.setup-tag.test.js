/*
 * The journal's setup field, filled by the desk that placed the order.
 *
 * WHY IT MATTERS MORE THAN IT LOOKS. Per-setup expectancy — the number that
 * decides which strategies keep running — is computed from that tag, and the
 * tag was typed by hand. So an untagged day is a day that cannot be measured,
 * and tagging from memory a week later is how a trade gets filed under the
 * wrong strategy. The desk already knew: it chose the setup, sized it, sent it
 * and wrote the ledger row. Nothing had ever asked it.
 *
 * THE THREE RULES, and they are the whole design:
 *
 *   it fills only an EMPTY field. A tag a person chose is the answer, and a
 *   trade opened by hand stays untagged for a person to tag — the case this
 *   must not break, and the one the request called out by name.
 *
 *   it fills only when the DESK SENT AN ORDER for that name on that date. No
 *   inference from the ticker, no nearest match, no "probably".
 *
 *   two setups on one name on one day STOPS IT. A wrong tag is worse than no
 *   tag: it is invisible, and it moves a losing trade into another strategy's
 *   record where it will never be found.
 *
 * The browser half is asserted on its source, the way this repo's other page
 * tests are — jsdom is not a dependency here and adding one would have to be
 * installed on the box to deploy.
 */

const os = require('os');
const path = require('path');
const fs = require('fs');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'setup-tag-'));
process.env.BROKER_FILE = path.join(DIR, 'broker.json');
process.env.BROKER_LEDGER = path.join(DIR, 'orders.jsonl');

const broker = require('../src/broker/signalstack');

const DAY = '2026-08-18';

/** One ledger row, as the order path writes it. */
function row(over = {}) {
  const o = { at: 1000, date: DAY, symbol: 'EYPT', setupId: 'or-vwap-0935',
              signal: 'LONG', sent: true, destination: 'alp',
              quantity: 100, price: 5.42, ...over };
  fs.appendFileSync(process.env.BROKER_LEDGER, `${JSON.stringify(o)}\n`);
  return o;
}

beforeEach(() => { fs.rmSync(process.env.BROKER_LEDGER, { force: true }); });

// ── what the desk knows ────────────────────────────────────────────────────

describe('which setup put each name on', () => {
  test('the name, the setup, and which way it went', () => {
    row();
    expect(broker.setupBySymbol(DAY).EYPT)
      .toMatchObject({ symbol: 'EYPT', setupId: 'or-vwap-0935', side: 'long', ambiguous: false });
  });

  test('a short is recorded as one', () => {
    row({ signal: 'SHORT' });
    expect(broker.setupBySymbol(DAY).EYPT.side).toBe('short');
  });

  test('the name comes back upper-cased, whatever the row said', () => {
    row({ symbol: 'eypt' });
    expect(broker.setupBySymbol(DAY).EYPT).toBeDefined();
  });

  /*
   * ONLY WHAT WENT OUT. A refusal placed no trade, and tagging a journal row
   * from one would attribute a trade to a strategy that never took it.
   */
  test('a refused order tags nothing', () => {
    row({ sent: false, error: 'no buying power' });
    expect(broker.setupBySymbol(DAY)).toEqual({});
  });

  test('the close is not an entry, and neither is the broker talking back', () => {
    row({ kind: 'flatten', setupId: null });
    row({ kind: 'callback', setupId: 'or-vwap-0935' });
    expect(broker.setupBySymbol(DAY)).toEqual({});
  });

  test('a row with no setup id is skipped rather than tagged with nothing', () => {
    row({ setupId: null });
    expect(broker.setupBySymbol(DAY)).toEqual({});
  });

  test('another day is another question', () => {
    row({ date: '2026-08-17' });
    expect(broker.setupBySymbol(DAY)).toEqual({});
  });
});

// ── one signal, several rows ───────────────────────────────────────────────

describe('a name that produced more than one row', () => {
  /*
   * A three-leg scale-out in two accounts is six rows for ONE position taken by
   * ONE setup. Counting them as a disagreement would make every healthy signal
   * ambiguous and the whole feature would refuse to do anything.
   */
  test('a scale-out across two accounts is still one setup', () => {
    row({ at: 1000, destination: 'alp' });
    row({ at: 1001, destination: 'alp' });
    row({ at: 1002, destination: 'ttp' });
    const g = broker.setupBySymbol(DAY).EYPT;
    expect(g.ambiguous).toBe(false);
    expect(g.setupId).toBe('or-vwap-0935');
  });

  test('the EARLIEST send is the entry time', () => {
    row({ at: 5000 });
    row({ at: 1000 });
    expect(broker.setupBySymbol(DAY).EYPT.at).toBe(1000);
  });
});

// ── the case where guessing would be worse than nothing ────────────────────

describe('two setups, one name, one day', () => {
  test('it refuses to choose, and says both', () => {
    row({ setupId: 'or-vwap-0935' });
    row({ setupId: 't2-vwap-1000' });
    const g = broker.setupBySymbol(DAY).EYPT;
    expect(g.ambiguous).toBe(true);
    expect(g.setupId).toBeNull();
    expect(g.setupIds.sort()).toEqual(['or-vwap-0935', 't2-vwap-1000']);
  });

  /*
   * NULL, not the first one seen. A wrong tag is invisible: the card looks
   * tagged, the expectancy is computed, and the trade is in the wrong
   * strategy's record for good.
   */
  test('order does not decide it', () => {
    row({ at: 1, setupId: 'a' });
    row({ at: 2, setupId: 'b' });
    expect(broker.setupBySymbol(DAY).EYPT.setupId).toBeNull();
  });

  test('the other names on that day are unaffected', () => {
    row({ symbol: 'EYPT', setupId: 'a' });
    row({ symbol: 'EYPT', setupId: 'b' });
    row({ symbol: 'CAPR', setupId: 'a' });
    const out = broker.setupBySymbol(DAY);
    expect(out.EYPT.ambiguous).toBe(true);
    expect(out.CAPR.setupId).toBe('a');
  });
});

// ── the endpoint that serves it ────────────────────────────────────────────

describe('the endpoint', () => {
  const SERVER = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'alerts', 'server.js'), 'utf8');
  const at = SERVER.indexOf("app.get('/api/broker/setups'");
  const body = SERVER.slice(at, at + 1800);

  test('exists, and is a GET so the journal can read it cross-port', () => {
    expect(at).toBeGreaterThan(-1);
    expect(SERVER).toMatch(/if \(req\.method === 'GET'\) res\.set\('Access-Control-Allow-Origin'/);
  });

  test('it answers for the date asked for, defaulting to today in New York', () => {
    expect(body).toMatch(/\^\\d\{4\}-\\d\{2\}-\\d\{2\}\$/);
    expect(body).toMatch(/toETDate\(Date\.now\(\)\)/);
  });

  /*
   * 200 with ok:false. A page that got a 500 would show nothing and say
   * nothing, which reads as "the desk placed no orders" — the opposite fact.
   */
  test('a failure is ok:false, not a 500', () => {
    expect(body).toMatch(/res\.json\(\{ ok: false, error: err\.message \}\)/);
    expect(body).not.toMatch(/status\(5\d\d\)/);
  });

  /*
   * The label is a convenience and the ID is the thing that gets stored, so a
   * qp outage must cost the name and not the answer.
   */
  test('the display name is best-effort and cannot fail the request', () => {
    expect(body).toMatch(/catch \{ \/\* the label only/);
  });

  test('it does not ask qp when there is nothing to name', () => {
    expect(body).toMatch(/if \(Object\.keys\(bySymbol\)\.length\)/);
  });

  test('it says whose orders these are', () => {
    expect(body).toMatch(/scope: 'this desk only'/);
  });
});

// ── the page ───────────────────────────────────────────────────────────────

describe('what the journal page does with it', () => {
  const SRC = fs.readFileSync(
    path.join(__dirname, '..', 'deploy', 'journal', 'patch.js'), 'utf8');

  test('it asks the desk, for the CARD\'s date', () => {
    expect(SRC).toMatch(/\/api\/broker\/setups\?date=/);
    expect(SRC).toMatch(/deskSetupsFor\(t\.date\)/);
  });

  test('the answer is cached per date, like the fills', () => {
    expect(SRC).toMatch(/if \(setupsByDate\[date\]\) return setupsByDate\[date\]/);
  });

  /* RULE ONE. A tag a person chose is the answer. */
  test('it never touches a field that already has a value', () => {
    expect(SRC).toMatch(/if \(!id \|\| sel\.value \|\| tagged\[id\]\) return;/);
    // And again after the await, because it may have been set while it waited.
    expect(SRC).toMatch(/if \(sel\.value \|\| tagged\[id\]\) return;\n\s*tagged\[id\] = true;/);
  });

  /* RULE TWO. Nothing is inferred from the ticker alone. */
  test('no desk order for that name on that date means it does nothing', () => {
    expect(SRC).toMatch(/if \(!g\) return;/);
  });

  /* RULE THREE. */
  test('two setups on one name stops it, visibly', () => {
    expect(SRC).toMatch(/if \(g\.ambiguous\)/);
    expect(SRC).toMatch(/tag it yourself/);
  });

  /*
   * An id with no option in the dropdown would store a tag the page can never
   * show — the row would read "— untagged —" for ever while being tagged.
   */
  test('it will not store an id the journal cannot display', () => {
    expect(SRC).toMatch(/if \(!optionFor\(sel, g\.setupId\)\)/);
    expect(SRC).toMatch(/which is not in this list/);
  });

  /*
   * The mark goes down BEFORE the request. The list re-renders on every
   * keystroke in the ticker filter, so a mark written on success would issue
   * one PATCH per letter typed while a slow one was still in flight.
   */
  test('one attempt per trade per page load, marked before the request', () => {
    const i = SRC.indexOf('tagged[id] = true;');
    const j = SRC.indexOf("fetch('/api/journal/trades/'");
    expect(i).toBeGreaterThan(-1);
    expect(i).toBeLessThan(j);
  });

  test('a failure is said, and lets the next render try again', () => {
    expect(SRC).toMatch(/tagged\[id\] = false;/);
    expect(SRC).toMatch(/could not tag: /);
  });

  /*
   * The page renders each card from its own copy of the trade. Without writing
   * the tag back into those, the next keystroke draws it untagged and this runs
   * again; loadAll() would fix it and also rebuild the entire list underneath.
   */
  test('it updates the page\'s own copies rather than reloading everything', () => {
    expect(SRC).toMatch(/window\.__trades, window\.__allTrades/);
    expect(SRC).toMatch(/t\.setup_id = setupId;/);
    expect(SRC).not.toMatch(/autoTag[\s\S]{0,900}loadAll\(\)/);
  });

  test('it PATCHes the field the journal actually stores', () => {
    expect(SRC).toMatch(/JSON\.stringify\(\{ setup_id: g\.setupId \}\)/);
    expect(SRC).toMatch(/method: 'PATCH'/);
  });
});

// ── the reason any of it is visible ────────────────────────────────────────

describe('the status line', () => {
  const SRC = fs.readFileSync(
    path.join(__dirname, '..', 'deploy', 'journal', 'patch.js'), 'utf8');

  /*
   * THE BUG THIS ANSWERS, reported as "I am not seeing anything different or
   * any connections to alpaca in this tool". The per-card fill line is drawn
   * only when Alpaca has a fill for that name on that date — correct, because a
   * "0" on a card nobody traded is a number nobody made — but on a day with no
   * fills the page looks EXACTLY as it did before any of this existed, and
   * "connected, nothing to show" becomes indistinguishable from "broken".
   */
  test('there is one, and it is drawn whether or not there are fills', () => {
    expect(SRC).toMatch(/id = 'jnl-desk-status'/);
    expect(SRC).toMatch(/no fills on/);
  });

  /*
   * OUTSIDE the container. The list replaces its own innerHTML on every render,
   * so a status line inside it would be wiped and redrawn on every keystroke.
   */
  test('it sits above the list, not inside it', () => {
    expect(SRC).toMatch(/host\.parentNode\.insertBefore\(el, host\)/);
  });

  test('it is added once, not once per render', () => {
    expect(SRC).toMatch(/var el = document\.getElementById\('jnl-desk-status'\);\n\s*if \(el\) return;/);
  });

  /*
   * THREE DIFFERENT FAULTS, THREE DIFFERENT SENTENCES. "the desk is not
   * running", "the desk cannot reach Alpaca" and "no account is configured"
   * need three different things done about them, and one generic failure
   * message would send the reader to the wrong one.
   */
  test('an unreachable desk names the port', () => {
    expect(SRC).toMatch(/the desk did not answer on port ' \+ ALERTS_PORT/);
  });

  test('a desk that answered but could not ask Alpaca says so separately', () => {
    expect(SRC).toMatch(/the desk answered but the account did not/);
  });

  test('no configured account is its own answer', () => {
    expect(SRC).toMatch(/if \(d\.unverified\) return set\(d\.unverified/);
  });
});
