/*
 * Alert rules against the cards the screener already holds.
 *
 * The behaviour worth pinning is not "does it compare two numbers" — it is the
 * three ways an alerting system becomes worthless:
 *
 *   firing on a STATE instead of a transition, so the same break re-alerts
 *   every five minutes until it is switched off;
 *
 *   firing on MISSING DATA, which teaches you to ignore the next one;
 *
 *   firing on the FIRST sight of a stock, so every scan opens with a burst of
 *   alerts for names that did nothing.
 */

// `describe` is jest's. The engine's is imported under a different name rather
// than destructured, or it shadows the global and the whole file silently
// contains no tests.
const engine = require('../src/alerts/engine');
const { evaluate, validate, applies, sideNow } = engine;
const explain = engine.describe;

const row = (ticker, stock) => ({ ticker, stock });
const rule = (over = {}) => ({
  id: 1, name: 'Break PM high', enabled: true,
  left: 'price', operator: 'crosses_above', right: 'pmHigh',
  scope: { tools: [], tickers: [] }, ...over,
});

// Two passes with a shared memory, which is how the scheduler uses it.
function run(rules, passes, toolId = 'T1') {
  const prev = {};
  const out = [];
  for (const rows of passes) {
    out.push(evaluate({ rules, rows, toolId, prev, now: 1, date: '2026-08-07' }));
  }
  return { fires: out, prev };
}

describe('a break is a crossing, not a state', () => {
  test('below then above fires once', () => {
    const { fires } = run([rule()], [
      [row('AAA', { price: 9, pmHigh: 10 })],
      [row('AAA', { price: 11, pmHigh: 10 })],
    ]);
    expect(fires[0]).toEqual([]);
    expect(fires[1]).toHaveLength(1);
    expect(fires[1][0]).toEqual(expect.objectContaining({ ticker: 'AAA', ruleId: 1 }));
  });

  test('staying above does NOT keep firing', () => {
    // The failure that makes people switch alerts off: one break, then a
    // re-alert every five minutes for the rest of the session.
    const { fires } = run([rule()], [
      [row('AAA', { price: 9, pmHigh: 10 })],
      [row('AAA', { price: 11, pmHigh: 10 })],
      [row('AAA', { price: 12, pmHigh: 10 })],
      [row('AAA', { price: 11.5, pmHigh: 10 })],
    ]);
    expect(fires.map(f => f.length)).toEqual([0, 1, 0, 0]);
  });

  test('losing the level and reclaiming it fires again — that is a new break', () => {
    const { fires } = run([rule()], [
      [row('AAA', { price: 9, pmHigh: 10 })],
      [row('AAA', { price: 11, pmHigh: 10 })],
      [row('AAA', { price: 9.5, pmHigh: 10 })],
      [row('AAA', { price: 10.5, pmHigh: 10 })],
    ]);
    expect(fires.map(f => f.length)).toEqual([0, 1, 0, 1]);
  });

  test('the first sight of a stock is never a crossing', () => {
    // Otherwise every scan opens with a burst of alerts for names that did
    // nothing, and a process restart repeats it.
    const { fires } = run([rule()], [[row('AAA', { price: 11, pmHigh: 10 })]]);
    expect(fires[0]).toEqual([]);
  });

  test('crosses_below is the mirror', () => {
    const r = rule({ operator: 'crosses_below', right: 'pmLow', name: 'Lose PM low' });
    const { fires } = run([r], [
      [row('AAA', { price: 11, pmLow: 10 })],
      [row('AAA', { price: 9, pmLow: 10 })],
      [row('AAA', { price: 8, pmLow: 10 })],
    ]);
    expect(fires.map(f => f.length)).toEqual([0, 1, 0]);
  });

  test('a move the other way does not fire an upward rule', () => {
    const { fires } = run([rule()], [
      [row('AAA', { price: 11, pmHigh: 10 })],
      [row('AAA', { price: 9, pmHigh: 10 })],
    ]);
    expect(fires[1]).toEqual([]);
  });
});

describe('missing data never fires', () => {
  test('a null level is a question, not an answer', () => {
    const { fires } = run([rule()], [
      [row('AAA', { price: 9, pmHigh: 10 })],
      [row('AAA', { price: 11, pmHigh: null })],
    ]);
    expect(fires[1]).toEqual([]);
  });

  test('data going missing and coming back does not fake a crossing', () => {
    // The subtle one. If the missing pass left the old side behind, the return
    // would look like below→above even though the stock never moved.
    const { fires } = run([rule()], [
      [row('AAA', { price: 9, pmHigh: 10 })],
      [row('AAA', { price: 9, pmHigh: null })],
      [row('AAA', { price: 9, pmHigh: 10 })],
    ]);
    expect(fires.map(f => f.length)).toEqual([0, 0, 0]);
  });

  test('a row with no stock at all is skipped', () => {
    expect(() => run([rule()], [[{ ticker: 'AAA' }]])).not.toThrow();
  });

  test('sideNow reports null rather than guessing', () => {
    expect(sideNow(rule(), { price: 10 })).toBeNull();
    expect(sideNow(rule(), { pmHigh: 10 })).toBeNull();
  });
});

describe('scope — per tool and per stock', () => {
  test('no scope means every tool and every stock', () => {
    expect(applies(rule(), 'T7', 'ZZZ')).toBe(true);
  });

  test('a rule for one tool is ignored by the others', () => {
    const r = rule({ scope: { tools: ['T2'], tickers: [] } });
    expect(applies(r, 'T2', 'AAA')).toBe(true);
    expect(applies(r, 'T7', 'AAA')).toBe(false);
  });

  test('a rule for one stock ignores the rest', () => {
    const r = rule({ scope: { tools: [], tickers: ['AAPL'] } });
    expect(applies(r, 'T1', 'AAPL')).toBe(true);
    expect(applies(r, 'T1', 'TSLA')).toBe(false);
  });

  test('tool and stock together are an AND', () => {
    const r = rule({ scope: { tools: ['T2'], tickers: ['AAPL'] } });
    expect(applies(r, 'T2', 'AAPL')).toBe(true);
    expect(applies(r, 'T2', 'TSLA')).toBe(false);
    expect(applies(r, 'T7', 'AAPL')).toBe(false);
  });

  test('a scoped-out rule is not evaluated, so it builds no history either', () => {
    const r = rule({ scope: { tools: ['T2'], tickers: [] } });
    const { fires, prev } = run([r], [
      [row('AAA', { price: 9, pmHigh: 10 })],
      [row('AAA', { price: 11, pmHigh: 10 })],
    ], 'T7');
    expect(fires.flat()).toEqual([]);
    expect(Object.keys(prev)).toEqual([]);
  });

  test('a disabled rule does nothing', () => {
    const { fires } = run([rule({ enabled: false })], [
      [row('AAA', { price: 9, pmHigh: 10 })],
      [row('AAA', { price: 11, pmHigh: 10 })],
    ]);
    expect(fires.flat()).toEqual([]);
  });
});

describe('memory is bounded and does not leak across absences', () => {
  test('a stock that leaves the registry is forgotten', () => {
    const { prev } = run([rule()], [
      [row('AAA', { price: 9, pmHigh: 10 })],
      [row('BBB', { price: 9, pmHigh: 10 })],
    ]);
    expect(Object.keys(prev)).toEqual(['1|BBB']);
  });

  test('a stock that returns is treated as newly seen, not compared to hours ago', () => {
    const { fires } = run([rule()], [
      [row('AAA', { price: 9, pmHigh: 10 })],
      [row('BBB', { price: 9, pmHigh: 10 })],
      [row('AAA', { price: 11, pmHigh: 10 })],
    ]);
    expect(fires[2]).toEqual([]);
  });
});

describe('comparing against a plain number', () => {
  test('a numeric threshold works as well as a field', () => {
    const r = rule({ left: 'rvol', operator: 'crosses_above', right: 5, name: 'RVOL 5x' });
    const { fires } = run([r], [
      [row('AAA', { rvol: 3 })],
      [row('AAA', { rvol: 6 })],
    ]);
    expect(fires[1]).toHaveLength(1);
  });

  test('a number sent as a string still works — forms send strings', () => {
    const r = rule({ left: 'rvol', operator: 'crosses_above', right: '5' });
    const { fires } = run([r], [[row('AAA', { rvol: 3 })], [row('AAA', { rvol: 6 })]]);
    expect(fires[1]).toHaveLength(1);
  });
});

describe('what the alert says', () => {
  test('it names the level and its value, not just the field', () => {
    // "price crossed above pmHigh" without the number cannot be checked
    // against a chart without opening the card.
    expect(explain(rule(), { pmHigh: 10.5 })).toBe('price crosses above pmHigh (10.5)');
  });

  test('a fire carries what is needed to act — ticker, tool, price, time', () => {
    const { fires } = run([rule()], [
      [row('AAA', { price: 9, pmHigh: 10 })],
      [row('AAA', { price: 11, pmHigh: 10 })],
    ], 'T3');
    expect(fires[1][0]).toEqual(expect.objectContaining({
      ticker: 'AAA', toolId: 'T3', price: 11, date: '2026-08-07', rule: 'Break PM high',
    }));
  });
});

describe('a malformed rule is refused with a reason', () => {
  test('a good rule validates clean', () => {
    expect(validate(rule())).toEqual([]);
  });

  test('an unknown field is named, and the options are listed', () => {
    const e = validate(rule({ left: 'nonsense' }));
    expect(e[0]).toMatch(/left must be one of/);
    expect(e[0]).toMatch(/pmHigh/);
  });

  test('an unknown operator is refused', () => {
    expect(validate(rule({ operator: 'wiggles' })[0])).toBeTruthy();
  });

  test('a right side that is neither a number nor a field is refused', () => {
    expect(validate(rule({ right: 'banana' }))).toContain('right must be a number or a known field');
  });

  test('a nameless rule is refused — a list of unnamed alerts is unreadable', () => {
    expect(validate(rule({ name: '  ' }))).toContain('name is required');
  });

  test('a bad ticker in the scope is caught before it silently matches nothing', () => {
    expect(validate(rule({ scope: { tools: [], tickers: ['not a ticker'] } })).join())
      .toMatch(/not a ticker/);
  });
});

/*
 * The alerts service is its own process on its own port.
 *
 * What matters structurally: it must not need a TOOL_ID or a database, because
 * everything it touches is a shared file. A dependency on one tool's config
 * would make a desk-wide list belong to T1, and the service would refuse to
 * start on its own.
 */
describe('the alerts service stands alone', () => {
  const request = require('supertest');
  const os = require('os');
  const path = require('path');
  const fs = require('fs');
  let app;
  const dir = path.join(os.tmpdir(), `alsrv-${process.pid}`);

  beforeAll(() => {
    fs.mkdirSync(dir, { recursive: true });
    process.env.DATA_DIR = dir;
    // Deliberately NO TOOL_ID and no DB_PATH — if the service needs either,
    // this require throws and the suite says so.
    delete process.env.TOOL_ID;
    app = require('../src/alerts/server');
  });

  afterAll(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* gone */ } });

  test('it answers /health without a database', async () => {
    const r = await request(app).get('/health');
    expect(r.status).toBe(200);
    expect(r.body).toEqual(expect.objectContaining({ ok: true, app: 'ALERTS' }));
  });

  test('it serves the alerts page for any path — deep links carry a ticker', async () => {
    const r = await request(app).get('/?ticker=NVDA');
    expect(r.status).toBe(200);
    expect(r.text).toMatch(/Alerts/);
  });

  test('it offers every configured tool, without being one', async () => {
    const r = await request(app).get('/api/alerts/meta');
    expect(r.body.tools.map(t => t.id)).toEqual(
      expect.arrayContaining(['T1', 'T2', 'T9']));
  });

  test('rules round-trip through the shared file', async () => {
    const made = await request(app).post('/api/alerts/rules').send({
      name: 'Break PM high', left: 'price', operator: 'crosses_above', right: 'pmHigh',
      scope: { tools: ['T2'], tickers: ['nvda'] },
    });
    expect(made.body.ok).toBe(true);
    // Normalised on the way in, so every reader sees one shape.
    expect(made.body.rule.scope).toEqual({ tools: ['T2'], tickers: ['NVDA'] });

    const back = await request(app).get('/api/alerts/rules');
    expect(back.body.rules).toHaveLength(1);
    expect(fs.existsSync(path.join(dir, 'alert-rules.json'))).toBe(true);
  });

  test('a bad rule is a 400 with the reason, not a 500', async () => {
    // A rule typed wrong is not a server fault, and the message is the only
    // thing that makes it fixable from a phone.
    const r = await request(app).post('/api/alerts/rules').send({
      name: 'x', left: 'nonsense', operator: 'crosses_above', right: 'pmHigh',
    });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/left must be one of/);
  });

  test('deleting a rule that is not there is a 404, not a silent success', async () => {
    expect((await request(app).delete('/api/alerts/rules/9999')).status).toBe(404);
  });
});
