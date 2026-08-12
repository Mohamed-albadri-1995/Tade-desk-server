/*
 * WHICH ACCOUNT a signal's order goes to.
 *
 * With one broker this question did not exist. With two it is the question,
 * and every wrong answer is a different kind of expensive:
 *
 *   the wrong account      a position in the book that is being managed by
 *                          nobody, under a strategy that is not running there
 *   both when one was meant  the trade twice, at twice the risk
 *   neither, silently      an alert that reads like a trade and is not one
 *
 * The last is the one this file spends the most effort on. A refusal has to be
 * loud: broker.route returns a REASON, never an empty list, so the alert can
 * say what it would have done and why it did not.
 */

const os = require('os');
const path = require('path');
const fs = require('fs');

const FILE = path.join(os.tmpdir(), `broker-route-${process.pid}.json`);
const LEDGER = path.join(os.tmpdir(), `broker-route-ledger-${process.pid}.jsonl`);
const PREFS = path.join(os.tmpdir(), `setup-prefs-route-${process.pid}.json`);
process.env.BROKER_FILE = FILE;
process.env.BROKER_LEDGER = LEDGER;
process.env.SETUP_PREFS_FILE = PREFS;

const broker = require('../src/broker/signalstack');
const prefs = require('../src/setups/prefs');

const HOOK_A = 'https://app.signalstack.com/hook/FAKEhookAAAAAAAAAAAAa';
const HOOK_B = 'https://app.signalstack.com/hook/FAKEhookBBBBBBBBBBBBb';

const TTP = { id: 'ttp', name: 'Trade The Pool', dialect: 'ttp', webhookUrl: HOOK_A };
const ALPACA = { id: 'alpaca', name: 'Alpaca', dialect: 'alpaca', webhookUrl: HOOK_B };

beforeEach(() => {
  for (const f of [FILE, LEDGER, PREFS]) { try { fs.unlinkSync(f); } catch { /* absent */ } }
});
afterAll(() => {
  for (const f of [FILE, LEDGER, PREFS]) { try { fs.unlinkSync(f); } catch { /* absent */ } }
});

const ids = (r) => r.cfgs.map(c => c.destinationId);

// ── the four things a person wants to say ─────────────────────────────────

describe('the routes a setup can be given', () => {
  beforeEach(() => broker.save({ enabled: true, destinations: [TTP, ALPACA] }));

  test('to both accounts', () => {
    const r = broker.route(['ttp', 'alpaca']);
    expect(r.error).toBeNull();
    expect(ids(r)).toEqual(['ttp', 'alpaca']);
    // and each carries its own hook, which is the whole point
    expect(r.cfgs[0].webhookUrl).toBe(HOOK_A);
    expect(r.cfgs[1].webhookUrl).toBe(HOOK_B);
  });

  test('to one of them', () => {
    expect(ids(broker.route(['alpaca']))).toEqual(['alpaca']);
  });

  test('to neither — alert only', () => {
    // Expressed as autoTrade off rather than here; what route says about an
    // empty list with two accounts configured is the next block.
    expect(prefs.settingsFor('never-configured').autoTrade).toBe(false);
    expect(prefs.settingsFor('never-configured').brokers).toEqual([]);
  });

  test('the order given is the order used', () => {
    expect(ids(broker.route(['alpaca', 'ttp']))).toEqual(['alpaca', 'ttp']);
  });

  test('the same account twice is once', () => {
    // Two entries would be the same trade twice, at twice the risk, from one
    // signal — and the second one would look like a fill in the log.
    expect(ids(broker.route(['ttp', 'ttp']))).toEqual(['ttp']);
  });
});

// ── refusing, out loud ────────────────────────────────────────────────────

describe('when it will not choose', () => {
  test('nothing said and two to choose from', () => {
    broker.save({ enabled: true, destinations: [TTP, ALPACA] });
    const r = broker.route([]);
    expect(r.cfgs).toEqual([]);
    expect(r.error).toMatch(/does not say which broker/);
    // Naming them matters: the fix is to pick one, and the message has to say
    // what there is to pick from.
    expect(r.error).toContain('Trade The Pool');
    expect(r.error).toContain('Alpaca');
  });

  test('nothing said and only one exists — nothing to decide', () => {
    broker.save({ enabled: true, destinations: [TTP] });
    expect(ids(broker.route([]))).toEqual(['ttp']);
  });

  test('nothing said and none configured', () => {
    const r = broker.route([]);
    expect(r.cfgs).toEqual([]);
    expect(r.error).toMatch(/no broker is configured/);
  });

  test('routed to an account that no longer exists', () => {
    // Deleting a destination must not quietly turn a trading setup into an
    // alerting one. It stops, and it says the name it was looking for.
    broker.save({ enabled: true, destinations: [TTP] });
    const r = broker.route(['alpaca']);
    expect(r.cfgs).toEqual([]);
    expect(r.error).toMatch(/routed to alpaca/);
  });

  test('one of two missing stops BOTH', () => {
    // Sending to the one that still exists would be a half-executed strategy
    // that reports success. Whether that is right is not this code's call.
    broker.save({ enabled: true, destinations: [TTP] });
    expect(broker.route(['ttp', 'alpaca']).cfgs).toEqual([]);
  });

  test('a destination switched off is not silently skipped', () => {
    broker.save({ enabled: true, destinations: [TTP, { ...ALPACA, enabled: false }] });
    const r = broker.route(['alpaca']);
    expect(r.cfgs).toEqual([]);
    expect(r.error).toMatch(/switched off/);
    // …and it is not one of the two the empty-list case chooses between either
    expect(ids(broker.route([]))).toEqual(['ttp']);
  });

  test('a destination with no hook cannot receive anything', () => {
    broker.save({ enabled: true, destinations: [TTP, { ...ALPACA, webhookUrl: null }] });
    expect(broker.route(['alpaca']).error).toBeTruthy();
    expect(ids(broker.route([]))).toEqual(['ttp']);
  });

  test('every destination off', () => {
    broker.save({ enabled: true, destinations: [{ ...TTP, enabled: false }] });
    expect(broker.route([]).error).toMatch(/every destination is disabled/);
  });
});

// ── what a setup stores ───────────────────────────────────────────────────

describe('a setup remembers where it sends', () => {
  beforeEach(() => broker.save({ enabled: true, destinations: [TTP, ALPACA] }));

  test('the ids are kept, in order', () => {
    prefs.saveSettings('or935', { brokers: ['alpaca', 'ttp'] });
    expect(prefs.settingsFor('or935').brokers).toEqual(['alpaca', 'ttp']);
  });

  test('a name that is not a broker is refused where it is typed', () => {
    /*
     * The alternative is worse than it looks. 'alpca' would store cleanly, read
     * back as a real preference, and then either send nowhere or fall through
     * to whatever the default was — and the first anyone would know is a
     * morning with no fills, or fills in the wrong account.
     */
    expect(() => prefs.saveSettings('or935', { brokers: ['alpca'] }))
      .toThrow(/no broker called alpca/);
    // and it says what there was to choose from
    expect(() => prefs.saveSettings('or935', { brokers: ['alpca'] }))
      .toThrow(/ttp, alpaca/);
  });

  test('emptying it puts the setup back to unsaid', () => {
    prefs.saveSettings('or935', { brokers: ['alpaca'] });
    prefs.saveSettings('or935', { brokers: [] });
    expect(prefs.settingsFor('or935').brokers).toEqual([]);
  });

  test('the same id twice is stored once', () => {
    prefs.saveSettings('or935', { brokers: ['ttp', 'ttp'] });
    expect(prefs.settingsFor('or935').brokers).toEqual(['ttp']);
  });

  test('routing is not permission', () => {
    // Naming an account is how "send this one by hand, to Alpaca" is said.
    // If saving a route also armed the setup, that sentence could not exist.
    prefs.saveSettings('or935', { brokers: ['alpaca'] });
    expect(prefs.settingsFor('or935').autoTrade).toBe(false);
  });

  test('a setup that was never given one routes to nothing in particular', () => {
    expect(prefs.settingsFor('brand-new').brokers).toEqual([]);
  });
});

// ── the round trip ────────────────────────────────────────────────────────

test('what a setup stored is what route resolves', () => {
  // The two halves are written in different files and read at different times;
  // this is the join, which is the thing that would rot silently.
  broker.save({ enabled: true, destinations: [TTP, ALPACA] });
  prefs.saveSettings('or935', { brokers: ['alpaca'] });
  const r = broker.route(prefs.settingsFor('or935').brokers);
  expect(ids(r)).toEqual(['alpaca']);
  expect(r.cfgs[0].dialect).toBe('alpaca');
  expect(r.cfgs[0].webhookUrl).toBe(HOOK_B);
});
