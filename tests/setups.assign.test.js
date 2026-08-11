/*
 * Assigning a strategy to a tool from the alerts page.
 *
 * This closes the one gap the live catalog left open. A strategy becomes a
 * setup by naming its tools, which means an unassigned one appears in no list
 * on this side — including any list you could assign it from. The fix was not
 * another registry: it was to show what qp holds and write the single field
 * back, so there is still exactly one copy of every strategy.
 *
 * What is pinned here is the narrowness. This side writes tools and nothing
 * else; a long and a short are assigned together or the setup ranks half its
 * signals; and qp refusing an id has to surface rather than be swallowed,
 * because a setup nobody runs looks exactly like a setup that never triggers.
 */

const os = require('os');
const path = require('path');
const fs = require('fs');

// Its own preferences file: a test that saved a filter into the real one would
// switch a live setup's universe on the deployment box.
const PREFS = path.join(os.tmpdir(), `setup-prefs-assign-${process.pid}.json`);
process.env.SETUP_PREFS_FILE = PREFS;
// Its own broker files too — the callback tests write a token and a ledger, and
// neither belongs in the real ones on the deployment box.
process.env.BROKER_FILE = path.join(os.tmpdir(), `broker-assign-${process.pid}.json`);
process.env.BROKER_LEDGER = path.join(os.tmpdir(), `broker-assign-${process.pid}.jsonl`);
afterAll(() => {
  for (const f of [PREFS, process.env.BROKER_FILE, process.env.BROKER_LEDGER]) {
    try { fs.unlinkSync(f); } catch { /* absent */ }
  }
});

const request = require('supertest');

jest.mock('../src/setups/qpClient', () => ({
  strategies: jest.fn(),
  setTools: jest.fn(),
}));
const qp = require('../src/setups/qpClient');

let app;
beforeAll(() => { app = require('../src/alerts/server'); });
beforeEach(() => { qp.strategies.mockReset(); qp.setTools.mockReset(); });

const LONG = {
  id: 1, name: 'T2 10:00 VWAP Extension (Long)', side: 'long',
  tools: [], risk: { window_start: 1000 },
};
const SHORT = { ...LONG, id: 2, name: 'T2 10:00 VWAP Extension (Short)', side: 'short' };

test('every strategy is listed, assigned or not — this is the picker', async () => {
  qp.strategies.mockResolvedValue([LONG, { ...SHORT, tools: ['T2'] }]);
  const res = await request(app).get('/api/strategies').expect(200);
  expect(res.body.strategies).toHaveLength(2);
  expect(res.body.strategies.map(s => s.id)).toEqual([1, 2]);
});

/*
 * Why it is not a setup yet, specifically. Unassigned and no-entry-window are
 * different problems: one is fixed by a tap here, the other only in the chart
 * tool. Offering the tap for the second would be offering a fix that does not.
 */
test('what each strategy still needs is named', async () => {
  qp.strategies.mockResolvedValue([
    LONG,
    { id: 3, name: 'Half built', tools: [], risk: {} },
    { id: 4, name: 'Ready', tools: ['T2'], risk: { window_start: 935 } },
  ]);
  const byId = Object.fromEntries(
    (await request(app).get('/api/strategies')).body.strategies.map(s => [s.id, s]));
  expect(byId[1].missing).toEqual(['tools']);
  expect(byId[3].missing).toEqual(['tools', 'entry window']);
  expect(byId[4].missing).toEqual([]);
  expect(byId[4].decisionTime).toBe('09:35');
});

/* Grouped the same way the setups list groups them, so the page can assign the
 * pair in one tap rather than leaving half a setup behind. */
test('the long and the short report the same base name', async () => {
  qp.strategies.mockResolvedValue([LONG, SHORT]);
  const list = (await request(app).get('/api/strategies')).body.strategies;
  expect(new Set(list.map(s => s.base)).size).toBe(1);
  expect(list.map(s => s.side).sort()).toEqual(['long', 'short']);
});

/*
 * qp down is not qp empty. An empty list means "nothing built yet" and the page
 * says so; an outage must not be dressed up as that, or the answer to "where
 * did my setups go" becomes "build them again".
 */
test('an unreachable qp is an error, not an empty list', async () => {
  qp.strategies.mockRejectedValue(new Error('ECONNREFUSED'));
  const res = await request(app).get('/api/strategies').expect(502);
  expect(res.body.ok).toBe(false);
  expect(res.body.error).toMatch(/ECONNREFUSED/);
});

test('assigning writes the tools straight through to qp', async () => {
  qp.setTools.mockResolvedValue({ id: 1, tools: ['T2'] });
  const res = await request(app)
    .post('/api/strategies/1/tools').send({ tools: ['T2'] }).expect(200);
  expect(qp.setTools).toHaveBeenCalledWith('1', ['T2']);
  expect(res.body.tools).toEqual(['T2']);
});

/*
 * The refusal has to reach the page. qp validates ids against the live tool
 * list, and a typo swallowed here would leave a strategy assigned to nothing
 * while the page showed it as done.
 */
test('a tool id qp refuses comes back as a refusal', async () => {
  qp.setTools.mockRejectedValue(new Error('unknown tool T99'));
  const res = await request(app)
    .post('/api/strategies/1/tools').send({ tools: ['T99'] }).expect(400);
  expect(res.body.ok).toBe(false);
  expect(res.body.error).toMatch(/T99/);
});

/* Clearing is a real instruction — it is how a setup is retired without
 * deleting the strategy or losing its backtests. */
test('an empty list is passed on rather than treated as nothing to do', async () => {
  qp.setTools.mockResolvedValue({ id: 1, tools: [] });
  await request(app).post('/api/strategies/1/tools').send({ tools: [] }).expect(200);
  expect(qp.setTools).toHaveBeenCalledWith('1', []);
});

/* Nothing else on the strategy is sendable from here. The rules, the window and
 * the side are the builder's, and a second place to edit them is a second copy. */
test('only the tools are forwarded, whatever else is posted', async () => {
  qp.setTools.mockResolvedValue({ id: 1, tools: ['T2'] });
  await request(app).post('/api/strategies/1/tools')
    .send({ tools: ['T2'], name: 'renamed', risk: { window_start: 1 } }).expect(200);
  expect(qp.setTools).toHaveBeenCalledWith('1', ['T2']);
});

/*
 * The filter's match mode has to survive a round trip.
 *
 * "market cap below 50M OR float above 10M" saved fine and then reopened
 * reading "all", so the next save turned it into an AND — a different filter,
 * silently, and one that would usually keep nothing.
 */
describe('the match mode comes back with the filter', () => {
  const prefs = require('../src/setups/prefs');
  const S = { id: 9, name: 'Fashionably Late Scalp', side: 'long',
              tools: ['T2'], risk: { window_start: 1000 } };

  test('an OR filter is reported as OR', async () => {
    qp.strategies.mockResolvedValue([S]);
    const id = (await request(app).get('/api/setups')).body.setups[0].id;
    prefs.saveSettings(id, { universe: { logic: 'OR', rules: [
      { left: 'mcap', operator: 'below', right: '50M' },
      { left: 'floatShares', operator: 'above', right: '10M' },
    ] } });

    const s = (await request(app).get('/api/setups')).body.setups[0];
    expect(s.universeLogic).toBe('OR');
    expect(s.universe).toMatch(/ OR /);
    expect(s.universeRules).toHaveLength(2);
  });

  test('no filter reads as AND rather than as nothing', async () => {
    qp.strategies.mockResolvedValue([{ ...S, name: 'Untouched', id: 10 }]);
    expect((await request(app).get('/api/setups')).body.setups[0].universeLogic).toBe('AND');
  });
});

/*
 * The public callback endpoint.
 *
 * SignalStack posts here with no key of its own, so the token in the path is
 * the only lock on it. A miss must not confirm the endpoint exists, and a body
 * this cannot parse must not make the sender retry or disable the notification.
 */
describe('the broker callback endpoint', () => {
  const broker = require('../src/broker/signalstack');

  test('a wrong token is a 404, not a 403', async () => {
    await request(app).post('/api/broker/callback/wrong').send({ id: 'X' }).expect(404);
  });

  test('the right token records the callback', async () => {
    const before = broker.orders().length;
    await request(app)
      .post(`/api/broker/callback/${broker.callbackToken()}`)
      .send({ id: 'ID1', status: 'filled', price: 12.5 })
      .expect(200);
    expect(broker.orders().length).toBe(before + 1);
  });

  test('a body it cannot make sense of still answers 200 and is kept', async () => {
    const before = broker.orders().length;
    await request(app)
      .post(`/api/broker/callback/${broker.callbackToken()}`)
      .send({ totally: 'unexpected' })
      .expect(200);
    expect(broker.orders().length).toBe(before + 1);
  });
});
