/*
 * The calculator.
 *
 * It exists so a trade the setups did not signal is sized by the same rule they
 * obey, and so a trade they DID signal can be checked before it is acted on.
 * The reason it is a server endpoint rather than arithmetic on the page is the
 * one that matters here: a second implementation would be a second answer to
 * "how many shares", and the page's answer is the one a person acts on.
 */

const os = require('os');
const path = require('path');
const fs = require('fs');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'calc-'));
process.env.RISK_FILE = path.join(DIR, 'risk.json');
process.env.ALERT_RULES_FILE = path.join(DIR, 'rules.json');
process.env.ALERT_FIRES_FILE = path.join(DIR, 'fires.json');
process.env.ALERT_HISTORY_DIR = path.join(DIR, 'history');
process.env.BROKER_FILE = path.join(DIR, 'broker.json');
process.env.BROKER_LEDGER = path.join(DIR, 'orders.jsonl');

const request = require('supertest');
const risk = require('../src/setups/risk');

let app;
beforeAll(() => { app = require('../src/alerts/server'); });
beforeEach(() => { fs.rmSync(process.env.RISK_FILE, { force: true }); });
afterAll(() => { fs.rmSync(DIR, { recursive: true, force: true }); });

const ask = body => request(app).post('/api/alerts/size').send(body);

test('shares come from what is lost if the stop is hit', async () => {
  risk.save({ accountSize: 5000, riskPerTrade: 25 });
  const { body } = await ask({ side: 'LONG', entry: 29.05, stop: 27.68 }).expect(200);
  expect(body.riskPerShare).toBeCloseTo(1.37, 2);
  expect(body.size.shares).toBe(18);              // floor(25 / 1.37)
  expect(body.size.riskDollars).toBeCloseTo(24.66, 2);
  expect(body.size.positionValue).toBeCloseTo(522.9, 1);
});

/* The same answer the automatic order would get. If these two ever disagree,
 * one of them is sending money somewhere on a number nobody checked. */
test('it agrees with the sizing the live order uses', async () => {
  risk.save({ accountSize: 5000, riskPerTrade: 25 });
  const { body } = await ask({ side: 'LONG', entry: 29.05, stop: 27.68 });
  expect(body.size).toEqual(
    risk.sizeFor({ entry: 29.05, riskPerShare: 29.05 - 27.68 }));
});

test('reward:risk is reported when a target is given', async () => {
  risk.save({ accountSize: 5000, riskPerTrade: 25 });
  const { body } = await ask({ side: 'LONG', entry: 29.05, stop: 27.68, target: 31.79 });
  expect(body.rr).toBeCloseTo(2.0, 1);
});

test('without a target it says where 2R would be', async () => {
  const { body } = await ask({ side: 'LONG', entry: 29.05, stop: 27.68 });
  expect(body.rr).toBeNull();
  expect(body.twoRTarget).toBeCloseTo(31.79, 2);
});

test('a short is sized the same way, mirrored', async () => {
  risk.save({ accountSize: 5000, riskPerTrade: 25 });
  const { body } = await ask({ side: 'SHORT', entry: 27.68, stop: 29.05 }).expect(200);
  expect(body.size.shares).toBe(18);
  expect(body.twoRTarget).toBeCloseTo(24.94, 2);
});

/*
 * A "long" whose stop is above the entry is either the wrong stop or the wrong
 * side. Sizing it would produce a confident number for a trade that cannot be
 * placed, and the number would look exactly like a correct one.
 */
test('a stop on the wrong side of the entry is refused, and says which', async () => {
  const { body } = await ask({ side: 'LONG', entry: 27.68, stop: 29.05 }).expect(400);
  expect(body.error).toMatch(/short/i);
});

test('a missing price is refused rather than sized as zero', async () => {
  await ask({ side: 'LONG', entry: 29.05 }).expect(400);
  await ask({ side: 'LONG', stop: 27.68 }).expect(400);
  await ask({ side: 'LONG', entry: 0, stop: 27.68 }).expect(400);
});

/* No account settings means no share count — the plan is still worth showing,
 * an invented size is not. */
test('with no account set it returns the plan and no size', async () => {
  const { body } = await ask({ side: 'LONG', entry: 29.05, stop: 27.68 }).expect(200);
  expect(body.size).toBeNull();
  expect(body.riskPerShare).toBeCloseTo(1.37, 2);
  expect(body.twoRTarget).toBeCloseTo(31.79, 2);
});

test('a stop too wide for the risk budget says so instead of rounding to zero', async () => {
  risk.save({ accountSize: 5000, riskPerTrade: 25 });
  const { body } = await ask({ side: 'LONG', entry: 100, stop: 60 });
  expect(body.size.shares).toBe(0);
  expect(body.size.reason).toMatch(/risks/);
});

test('the position cap is reported when it bites', async () => {
  risk.save({ accountSize: 1000, riskPerTrade: 100, maxPositionPct: 50 });
  const { body } = await ask({ side: 'LONG', entry: 10, stop: 9.9 });
  // Risk allows 1000 shares; 50% of a $1,000 account allows 50.
  expect(body.size.shares).toBe(50);
  expect(body.size.capped).toMatch(/capped/);
});
