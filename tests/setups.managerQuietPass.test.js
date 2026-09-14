/*
 * A PASS WITH NOTHING TO WATCH IS STILL A PASS.
 *
 * The 2026-09-08 session log reads "36 passes, 09:35:45 to about 10:11" and
 * then nothing — on a day whose positions were not closed until the 15:50
 * flatten. Five hours in which a runner needed its exit rule watched, and no
 * way to tell from the record whether anything was watching it.
 *
 * The manager had not stopped. `check()` returned early when it found no open
 * position, and that return sat BEFORE the sessionLog.record at the end of the
 * function — so a pass that found nothing left no row at all. The log could not
 * tell these two apart:
 *
 *     the manager ran every minute and had nothing to do
 *     the manager stopped running
 *
 * Which is the one thing the log exists to tell apart. The answer had to come
 * from reading the source instead, and it cost a day.
 *
 * `heldAtBroker` rides on the empty pass too: "nothing is open and Alpaca
 * agrees" and "nothing is open and Alpaca was never asked" are different
 * mornings.
 */

const os = require('os');
const path = require('path');
const fs = require('fs');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mgr-quiet-'));
process.env.BROKER_FILE = path.join(DIR, 'broker.json');
process.env.BROKER_LEDGER = path.join(DIR, 'orders.jsonl');
process.env.DATA_DIR = DIR;
// tests/setup.env.js redirects SESSION_LOG_DIR globally so no test writes a
// real session log. Point it at this file's own directory, the way every other
// log test does, or the passes land somewhere this file cannot clear.
process.env.SESSION_LOG_DIR = path.join(DIR, 'history');

jest.mock('../src/setups/qpClient', () => ({ manage: jest.fn() }));
jest.mock('../src/setups/catalog', () => ({ list: jest.fn(async () => []) }));
jest.mock('../src/alerts/store', () => ({ publishFires: jest.fn() }));
jest.mock('../src/broker/reconcile', () => ({
  carriedOver: jest.fn(async () => ({ ok: false, error: 'not asked' })),
  flatSymbols: jest.fn(async () => null),
  alpacaDestinations: jest.fn(() => ['alp']),
}));

const broker = require('../src/broker/signalstack');
const sessionLog = require('../src/setups/sessionLog');
const manager = require('../src/setups/manager');

const HOOK = 'https://app.signalstack.com/hook/FAKEhook0000000000000a';

/** A Tuesday, 10:30 ET — inside the session, after the 09:35 decision. */
const AT = new Date('2026-09-08T14:30:00Z').getTime();
const DAY = '2026-09-08';

beforeEach(() => {
  for (const f of ['orders.jsonl']) {
    try { fs.unlinkSync(path.join(DIR, f)); } catch { /* absent */ }
  }
  fs.rmSync(path.join(DIR, 'history'), { recursive: true, force: true });
  broker.save({ enabled: true, armed: true, webhookUrl: HOOK, buyingPower: 100000 });
});
afterAll(() => { try { fs.rmSync(DIR, { recursive: true, force: true }); } catch { /* */ } });

describe('a quiet pass leaves a record', () => {
  test('with nothing open, the pass is still written down', async () => {
    const r = await manager.check(AT);
    expect(r.ran).toBe(true);
    expect(r.positions).toBe(0);

    const passes = sessionLog.passesOn(DAY);
    expect(passes).toHaveLength(1);
    expect(passes[0].positions).toEqual([]);
  });

  /*
   * AND IT CARRIES WHETHER THE BROKER WAS ASKED. reconcile is mocked here to
   * refuse — "not asked" — which is exactly the 2026-09-08 state, where every
   * pass recorded heldAtBroker: null. An empty pass that did not say so would
   * read as "Alpaca confirms you are flat", which is a different fact and the
   * one that lets a forgotten position sit all day.
   */
  test('...and says whether Alpaca was asked', async () => {
    await manager.check(AT);
    const p = sessionLog.passesOn(DAY)[0];
    expect(p).toHaveProperty('heldAtBroker');
    // null, not an empty list: reconcile is mocked to refuse here, and "Alpaca
    // says you hold nothing" must never be written by a pass that never asked.
    expect(p.heldAtBroker).toBeNull();
    expect(p.heldAtBroker).not.toEqual([]);
  });

  test('a minute later there are two passes, not one', async () => {
    await manager.check(AT);
    await manager.check(AT + 60000);
    expect(sessionLog.passesOn(DAY)).toHaveLength(2);
  });

  /*
   * A PASS THAT DID NOT RUN STILL LEAVES NOTHING. Not armed, or a weekend, is
   * not a pass — recording one would say the manager looked when it did not,
   * which is the same lie pointing the other way.
   */
  test('a disarmed desk records no pass at all', async () => {
    broker.save({ enabled: true, armed: false, webhookUrl: HOOK });
    const r = await manager.check(AT);
    expect(r.ran).toBe(false);
    expect(sessionLog.passesOn(DAY)).toHaveLength(0);
  });

  test('a weekend records no pass at all', async () => {
    // 2026-09-12 is a Saturday.
    const sat = new Date('2026-09-12T14:30:00Z').getTime();
    const r = await manager.check(sat);
    expect(r.ran).toBe(false);
    expect(sessionLog.passesOn('2026-09-12')).toHaveLength(0);
  });
});

/* ── a stored fill is not a position ─────────────────────────────────────── */

describe('the broker answering about an order is not an order', () => {
  /*
   * recordFill writes kind:'fill' rows into the same ledger. They carry no
   * setupId so openPositions already skips them, but the exclusion is named
   * explicitly beside flatten and callback: the next kind added must be a
   * decision, not something that quietly becomes a position to manage.
   */
  test('a fill row never becomes a position', () => {
    fs.appendFileSync(process.env.BROKER_LEDGER, JSON.stringify({
      at: 1, date: DAY, kind: 'fill', symbol: 'PL', orderId: 'o1',
      fillPrice: 17.515, confirmedBy: 'alpaca',
    }) + '\n');
    expect(manager.openPositions(DAY)).toEqual([]);

    const src = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'setups', 'manager.js'), 'utf8');
    expect(src).toMatch(/o\.kind === 'fill'/);
  });

  test('a real order still becomes one', () => {
    fs.appendFileSync(process.env.BROKER_LEDGER, JSON.stringify({
      at: 2, date: DAY, symbol: 'PL', signal: 'SHORT', setupId: 'or@09:35',
      sent: true, price: 17.75, stop: 17.935, destination: 'alp',
    }) + '\n');
    const open = manager.openPositions(DAY);
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ symbol: 'PL', side: 'short', price: 17.75 });
  });
});
