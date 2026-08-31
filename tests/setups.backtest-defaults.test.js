/*
 * THE DESK STATES THE SETTINGS A BACKTEST MUST BE RUN WITH.
 *
 * A backtest is only evidence about the desk if it was run with the desk's
 * settings. They used to be typed into the qp form by hand — account size,
 * risk per trade, the position cap, the ranking, the timeframe, the feed, the
 * session view, the fill model — and every one of them was a chance for the
 * two to disagree. Three of them did, for a fortnight, with a P&L that did not
 * match as the only symptom.
 *
 * So this endpoint answers in the BACKTEST'S OWN key names, and the qp form
 * fills itself from it. Nothing is stored twice, so nothing can drift.
 *
 * What it deliberately does NOT answer: the date range and the strategy. The
 * range is a claim about which market you are testing and belongs to whoever
 * is running it; the strategy is the thing being chosen when the form opens.
 */

const os = require('os');
const path = require('path');
const fs = require('fs');

const PREFS = path.join(os.tmpdir(), `setup-prefs-btd-${process.pid}.json`);
const RISK = path.join(os.tmpdir(), `risk-btd-${process.pid}.json`);
process.env.SETUP_PREFS_FILE = PREFS;
process.env.RISK_FILE = RISK;
process.env.BROKER_FILE = path.join(os.tmpdir(), `broker-btd-${process.pid}.json`);
process.env.BROKER_LEDGER = path.join(os.tmpdir(), `broker-btd-${process.pid}.jsonl`);
afterAll(() => {
  for (const f of [PREFS, RISK, process.env.BROKER_FILE, process.env.BROKER_LEDGER]) {
    try { fs.unlinkSync(f); } catch { /* absent */ }
  }
});

const request = require('supertest');

jest.mock('../src/setups/qpClient', () => ({
  strategies: jest.fn(),
  setTools: jest.fn(),
}));
const qp = require('../src/setups/qpClient');

/*
 * Mounted on a bare express app rather than pulled out of a running server.
 *
 * The route lives on the TOOL apps (src/index.js), not on the alerts app — the
 * qp proxy asks a tool for it, because tools are what tools.config.json names.
 * Mounting the router directly tests the thing under test and nothing else.
 */
const express = require('express');
let app;
beforeAll(() => {
  app = express();
  app.use('/api/setups', require('../src/routes/setups'));
});

const LONG = {
  id: 1, name: 'OR + VWAP 09:35 (Long)', side: 'long', stage: 'ready',
  tools: ['T2'],
  risk: { window_start: 935, window_end: 935, max_entries_per_day: 1 },
};
const SHORT = { ...LONG, id: 2, name: 'OR + VWAP 09:35 (Short)', side: 'short' };
const ID = 'OR + VWAP 09:35@09:35';

const writeRisk = (o) => fs.writeFileSync(RISK, JSON.stringify(o));
const writePrefs = (o) => fs.writeFileSync(PREFS, JSON.stringify(o));

beforeEach(() => {
  qp.strategies.mockReset();
  qp.strategies.mockResolvedValue([LONG, SHORT]);
  writeRisk({ accountSize: 50000, riskPerTrade: 500, maxPositionPct: 16.66 });
  writePrefs({ setups: { [ID]: {
    rankMetric: 'vwap_extension', rankDirection: null, topN: 3,
    tf: '1m', feed: 'polygon', maxTradesPerDay: 1 } } });
});

const get = (q = '') => request(app).get(`/api/setups/backtest-defaults${q}`);

describe('the account settings arrive in backtest vocabulary', () => {
  test('account size, flat risk and the cap', async () => {
    const { body } = await get(`?setup=${encodeURIComponent(ID)}`);
    expect(body.ok).toBe(true);
    expect(body.spec.account_equity).toBe(50000);
    expect(body.spec.risk_usd).toBe(500);
    expect(body.spec.max_position_pct).toBe(16.66);
  });

  // A percentage COMPOUNDS and the desk does not. Sending risk_pct here would
  // reintroduce the exact difference this endpoint exists to remove.
  test('risk is flat dollars, and the percentage is explicitly zero', async () => {
    const { body } = await get(`?setup=${encodeURIComponent(ID)}`);
    expect(body.spec.risk_pct).toBe(0);
  });

  // 100% live means NO cap, which is what an absent cap means in the backtest.
  // Sending 100 would make the two differ while meaning the same thing.
  test('a live cap of 100% is sent as no cap at all', async () => {
    writeRisk({ accountSize: 50000, riskPerTrade: 500, maxPositionPct: 100 });
    const { body } = await get(`?setup=${encodeURIComponent(ID)}`);
    expect(body.spec.max_position_pct).toBe(0);
  });

  test('a setup-level risk override wins over the account', async () => {
    writePrefs({ setups: { [ID]: { riskPerTrade: 200, maxPositionPct: 10 } } });
    const { body } = await get(`?setup=${encodeURIComponent(ID)}`);
    expect(body.spec.risk_usd).toBe(200);
    expect(body.spec.max_position_pct).toBe(10);
  });

  /*
   * THE ADOPTED SHAPE. After `--adopt`, the setup holds its own risk rule —
   * that is where adoption writes it, so one strategy's winner cannot resize
   * another's. If this endpoint only knows how to read a flat dollar, a setup
   * sized at 0.5% reports no risk at all and the backtest form opens with the
   * money boxes empty — the exact state this endpoint exists to prevent.
   */
  test('a setup sized as a PERCENTAGE reports the percentage', async () => {
    writePrefs({ setups: { [ID]: { riskPct: 0.5, maxPositionPct: 100 } } });
    const { body } = await get(`?setup=${encodeURIComponent(ID)}`);
    expect(body.spec.risk_pct).toBe(0.5);
    // ...and the flat figure is zero, because the two are mutually exclusive
    // and sending both makes the run refuse to start.
    expect(body.spec.risk_usd).toBe(0);
  });

  test("...and its no-cap is reported as no cap, not as the account's", async () => {
    writeRisk({ accountSize: 50000, riskPerTrade: 500, maxPositionPct: 16.66 });
    writePrefs({ setups: { [ID]: { riskPct: 0.5, maxPositionPct: 100 } } });
    const { body } = await get(`?setup=${encodeURIComponent(ID)}`);
    expect(body.spec.max_position_pct).toBe(0);
  });

  // The setup's rule replaces the account's WHOLE, never mixes with it — half
  // a percentage and half a flat dollar is neither.
  test('a setup percentage beats an account flat dollar cleanly', async () => {
    writeRisk({ accountSize: 50000, riskPerTrade: 500, maxPositionPct: 100 });
    writePrefs({ setups: { [ID]: { riskPct: 0.5 } } });
    const { body } = await get(`?setup=${encodeURIComponent(ID)}`);
    expect([body.spec.risk_usd, body.spec.risk_pct]).toEqual([0, 0.5]);
  });
});

describe('the execution settings', () => {
  /*
   * THE FILL MODEL IS TRANSLATED, NOT COPIED. The desk runs 'live', which
   * cannot be backtested — it reports the decision price as the entry because
   * live has no fill price yet. Its backtestable twin is 'desk': the same
   * decision from the same bar with the same levels, plus the fill the next
   * bar's open really gave.
   */
  test("live's 'live' is offered to the backtest as 'desk'", async () => {
    const { body } = await get(`?setup=${encodeURIComponent(ID)}`);
    expect(body.spec.fill).toBe('desk');
  });

  test('a setup pinned to another model is passed through unchanged', async () => {
    writePrefs({ setups: { [ID]: { fill: 'close' } } });
    const { body } = await get(`?setup=${encodeURIComponent(ID)}`);
    expect(body.spec.fill).toBe('close');
  });

  test('timeframe, feed and session view come across', async () => {
    const { body } = await get(`?setup=${encodeURIComponent(ID)}`);
    expect(body.spec.tf).toBe('1m');
    expect(body.spec.feed).toBe('polygon');
    // Matches chart/backtest.py's own default. 'regular' changes every rolling
    // indicator's warm-up and removes the 09:29 decision bar entirely.
    expect(body.spec.view).toBe('all');
  });

  test('the universe is the setup’s own tools', async () => {
    const { body } = await get(`?setup=${encodeURIComponent(ID)}`);
    expect(body.spec.universe).toEqual({ kind: 'tools', register: 'R1', tools: ['T2'] });
  });

  test('the daily cap comes across', async () => {
    const { body } = await get(`?setup=${encodeURIComponent(ID)}`);
    expect(body.spec.rules.max_entries_per_day).toBe(1);
  });
});

describe('the ranking', () => {
  test('metric and count when both are set', async () => {
    const { body } = await get(`?setup=${encodeURIComponent(ID)}`);
    expect(body.spec.rank_per_day).toEqual(
      { metric: 'vwap_extension', top_n: 3, direction: null });
  });

  // A count with no metric is not a preference, it is a trap — it takes n of
  // the day's signals by an order nobody chose. Absent means every signal.
  test('a count without a metric is no ranking at all', async () => {
    writePrefs({ setups: { [ID]: { topN: 3 } } });
    const { body } = await get(`?setup=${encodeURIComponent(ID)}`);
    expect(body.spec.rank_per_day).toBeNull();
  });

  test('a metric without a count is no ranking either', async () => {
    writePrefs({ setups: { [ID]: { rankMetric: 'vwap_extension' } } });
    const { body } = await get(`?setup=${encodeURIComponent(ID)}`);
    expect(body.spec.rank_per_day).toBeNull();
  });
});

describe('what it refuses to answer', () => {
  // The range is a claim about which market you are testing. Defaulting it
  // here would put a stale "to 2026-08-31" into a form opened in November.
  test('no date range — that is chosen every run', async () => {
    const { body } = await get(`?setup=${encodeURIComponent(ID)}`);
    expect(body.spec.start).toBeUndefined();
    expect(body.spec.end).toBeUndefined();
  });

  test('an unknown setup is a 404, not an empty spec', async () => {
    const res = await get('?setup=nope');
    expect(res.status).toBe(404);
    expect(res.body.ok).toBe(false);
  });
});

describe('without a setup named, every setup answers', () => {
  test('the whole list, plus the account behind it', async () => {
    const { body } = await get();
    expect(body.ok).toBe(true);
    expect(body.account.accountSize).toBe(50000);
    expect(body.setups.length).toBe(1);
    expect(body.setups[0].id).toBe(ID);
    expect(body.setups[0].spec.risk_usd).toBe(500);
  });

  // The qp form matches a chosen strategy to a setup by NAME, so the names of
  // both books have to be in the answer or the form cannot find the setup a
  // "(Short)" strategy belongs to.
  test('each row names the strategies it covers, both sides', async () => {
    const { body } = await get();
    expect(body.setups[0].strategies).toEqual(
      ['OR + VWAP 09:35 (Long)', 'OR + VWAP 09:35 (Short)']);
  });
});

describe('an unset account is unset, not zero', () => {
  // A plausible-looking size derived from a number nobody entered is worse
  // than no size: the backtest would report dollars for an account that does
  // not exist.
  test('no account size means no dollar figure to offer', async () => {
    writeRisk({});
    const { body } = await get(`?setup=${encodeURIComponent(ID)}`);
    expect(body.spec.account_equity).toBe(0);
    expect(body.spec.risk_usd).toBe(0);
  });
});
