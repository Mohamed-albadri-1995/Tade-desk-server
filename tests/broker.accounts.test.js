/*
 * WHICH ACCOUNTS RUN A SETUP, AND WHAT THEY MAY DO WITH IT.
 *
 * This replaces a routing model that had the arrow pointing both ways: a setup
 * named its brokers, an account named its capital, and a separate flag on the
 * setup said whether orders were automatic. Three places for one decision, and
 * they could disagree — which is how an account ends up holding a position
 * from a strategy that is not supposed to be running in it.
 *
 * One direction now. An ACCOUNT lists the setups it runs and declares one mode:
 *
 *   alert   nothing is ever sent here
 *   manual  it appears in the send picker and waits to be tapped
 *   auto    a fire places an order here by itself
 *
 * A setup knows nothing about brokers at all.
 */

const os = require('os');
const path = require('path');
const fs = require('fs');

const FILE = path.join(os.tmpdir(), `broker-acct-${process.pid}.json`);
const LEDGER = path.join(os.tmpdir(), `broker-acct-ledger-${process.pid}.jsonl`);
process.env.BROKER_FILE = FILE;
process.env.BROKER_LEDGER = LEDGER;

const broker = require('../src/broker/signalstack');

const HOOK_A = 'https://app.signalstack.com/hook/FAKEhookAAAAAAAAAAAAa';
const HOOK_B = 'https://app.signalstack.com/hook/FAKEhookBBBBBBBBBBBBb';

// One number each: what fraction of the standard account this one is.
const TTP = { id: 'ttp', name: 'Trade The Pool', dialect: 'ttp', webhookUrl: HOOK_A,
              ratio: 0.05, buyingPower: 5000 };
const ALPACA = { id: 'alpaca', name: 'Alpaca', dialect: 'alpaca', webhookUrl: HOOK_B,
                 ratio: 0.2, buyingPower: 20000 };

const ids = (list) => list.map(c => c.destinationId);
const setup = (extra) => broker.save({ enabled: true, destinations: extra });

beforeEach(() => {
  for (const f of [FILE, LEDGER]) { try { fs.unlinkSync(f); } catch { /* absent */ } }
});
afterAll(() => {
  for (const f of [FILE, LEDGER]) { try { fs.unlinkSync(f); } catch { /* absent */ } }
});

// ── the four arrangements a person wants ──────────────────────────────────

describe('the arrangements the modes have to express', () => {
  test('one setup, full auto in two accounts', () => {
    setup([{ ...TTP, mode: 'auto', setups: ['or935'] },
           { ...ALPACA, mode: 'auto', setups: ['or935'] }]);
    expect(ids(broker.autoRoute('or935').cfgs)).toEqual(['ttp', 'alpaca']);
  });

  test('full auto in one, alert only in the other', () => {
    setup([{ ...TTP, mode: 'alert', setups: ['or935'] },
           { ...ALPACA, mode: 'auto', setups: ['or935'] }]);
    expect(ids(broker.autoRoute('or935').cfgs)).toEqual(['alpaca']);
  });

  test('by hand only — nothing fires, but the picker offers it', () => {
    setup([{ ...ALPACA, mode: 'manual', setups: ['or935'] }]);
    expect(broker.autoRoute('or935').cfgs).toEqual([]);
    expect(ids(broker.accountsFor('or935', 'manual'))).toEqual(['alpaca']);
    expect(broker.manualCfg('alpaca').cfg.destinationId).toBe('alpaca');
  });

  test('alert only — the picker refuses it too', () => {
    // The mode is a standing instruction about an account, not a per-tap one.
    setup([{ ...ALPACA, mode: 'alert', setups: ['or935'] }]);
    expect(broker.manualCfg('alpaca').cfg).toBeNull();
    expect(broker.manualCfg('alpaca').error).toMatch(/alert only/);
  });

  test('the same setup, watched by hand in one account and automatic in another', () => {
    // The arrangement the old flag-on-the-setup model could not express at all.
    setup([{ ...TTP, mode: 'manual', setups: ['or935'] },
           { ...ALPACA, mode: 'auto', setups: ['or935'] }]);
    expect(ids(broker.autoRoute('or935').cfgs)).toEqual(['alpaca']);
    expect(ids(broker.accountsFor('or935', 'manual'))).toEqual(['ttp']);
  });
});

// ── a setup an account does not run ───────────────────────────────────────

describe('a setup no account claims', () => {
  beforeEach(() => setup([{ ...ALPACA, mode: 'auto', setups: ['or935'] }]));

  test('places nothing', () => {
    expect(broker.autoRoute('or10').cfgs).toEqual([]);
  });

  test('and the reason names the fix', () => {
    // A setup that quietly stopped trading looks exactly like a quiet week.
    expect(broker.autoRoute('or10').error).toMatch(/no account runs this setup/);
  });

  test('an account that runs it but not on auto says which mode it IS in', () => {
    setup([{ ...ALPACA, mode: 'manual', setups: ['or935'] }]);
    expect(broker.autoRoute('or935').error).toMatch(/Alpaca \(manual only\)/);
  });

  test('nothing configured at all is its own answer', () => {
    broker.save({ destinations: [] });
    expect(broker.autoRoute('or935').error).toMatch(/no broker account is configured/);
  });

  test('everything switched off is a different answer again', () => {
    setup([{ ...ALPACA, mode: 'auto', setups: ['or935'], enabled: false }]);
    expect(broker.autoRoute('or935').error).toMatch(/switched off or has no hook/);
  });
});

// ── the picker ────────────────────────────────────────────────────────────

describe('what the send picker may offer', () => {
  beforeEach(() => setup([
    { ...TTP, mode: 'manual', setups: ['or935'] },
    { ...ALPACA, mode: 'auto', setups: ['or10'] },
  ]));

  test('every account that can receive an order, whatever setup it lists', () => {
    /*
     * Deliberately not filtered to the accounts that run this setup. "Send this
     * one somewhere it does not normally go" is a decision a person is allowed
     * to make with their thumb on the button, in front of a preview showing
     * that account's own share count.
     */
    expect(broker.manualCfg('ttp').cfg).toBeTruthy();
    expect(broker.manualCfg('alpaca').cfg).toBeTruthy();
  });

  test('but never an account with no hook', () => {
    setup([{ ...TTP, mode: 'manual', webhookUrl: '' }]);
    expect(broker.manualCfg('ttp').error).toMatch(/switched off or has no hook/);
  });

  test('nor one that does not exist', () => {
    expect(broker.manualCfg('etrade').error).toMatch(/no account called etrade/);
  });

  test('accountsFor with no mode lists them all, for a picker to render', () => {
    expect(ids(broker.accountsFor(null))).toEqual(['ttp', 'alpaca']);
  });
});

// ── saving ────────────────────────────────────────────────────────────────

describe('saving an account', () => {
  test('an unknown mode is refused, never defaulted', () => {
    // Defaulting to 'auto' would be orders nobody asked for; defaulting to
    // 'alert' would be an account that looks armed and sends nothing.
    expect(() => setup([{ ...TTP, mode: 'live' }])).toThrow(/mode must be one of/);
  });

  test('a ratio outside its bounds is refused at both ends', () => {
    // Above 10 is a typo that would be a ten-fold position before anything
    // downstream questioned it. Below 0.0001 every trade floors to zero
    // shares — an account configured to do nothing while looking configured.
    expect(() => setup([{ ...TTP, ratio: 20 }])).toThrow(/between 0.0001 and 10/);
    expect(() => setup([{ ...TTP, ratio: 0 }])).toThrow(/between 0.0001 and 10/);
  });

  test('a ratio small enough for a real prop account is fine', () => {
    // $5,000 against a $100,000 standard. The old bound started at 0.25.
    setup([{ ...TTP, ratio: 0.05 }]);
    expect(broker.destinations()[0].ratio).toBe(0.05);
  });

  test('the setup list is deduplicated — the same trade twice is twice the risk', () => {
    setup([{ ...TTP, mode: 'auto', setups: ['or935', 'or935'] }]);
    expect(broker.destinations()[0].setups).toEqual(['or935']);
  });

  test('editing one field keeps the mode, the setups and the hook', () => {
    // The page cannot send a hook back — it never sees one — and a save that
    // dropped the mode would silently disarm an account mid-morning.
    setup([{ ...ALPACA, mode: 'auto', setups: ['or935'] }]);
    broker.save({ destinations: [{ id: 'alpaca', dialect: 'alpaca', buyingPower: 9999 }] });
    const d = broker.destinations()[0];
    expect(d.mode).toBe('auto');
    expect(d.setups).toEqual(['or935']);
    expect(d.webhookUrl).toBe(HOOK_B);
    expect(d.buyingPower).toBe(9999);
  });
});

// ── arming ────────────────────────────────────────────────────────────────

describe('arming the box', () => {
  test('refused with no account at all', () => {
    expect(() => broker.save({ armed: true })).toThrow(/add a broker account/);
  });

  test('refused when every account is alert only', () => {
    // It would be a switch that reads LIVE and can do nothing.
    setup([{ ...TTP, mode: 'alert' }]);
    expect(() => broker.save({ armed: true })).toThrow(/every account is set to alert only/);
  });

  test('refused when a sending account has no buying power, and names it', () => {
    setup([{ ...TTP, mode: 'auto', buyingPower: undefined }]);
    expect(() => broker.save({ armed: true })).toThrow(/Trade The Pool has no buying power/);
  });

  test('an alert-only account does not block arming the others', () => {
    setup([{ ...TTP, mode: 'alert', buyingPower: undefined },
           { ...ALPACA, mode: 'auto' }]);
    expect(() => broker.save({ armed: true })).not.toThrow();
  });
});

// ── the config that existed before any of this ────────────────────────────

describe('a single hook configured before accounts existed', () => {
  test('reads as one account, on manual', () => {
    /*
     * Never more permissive than it was. Before modes, an order went out when
     * the box was armed AND the setup carried autoTrade; that flag is gone, so
     * migrating to 'auto' would hand every setup a permission only some of
     * them had. Manual keeps the hook usable from the first minute.
     */
    broker.save({ webhookUrl: HOOK_A, buyingPower: 5000 });
    const [d, ...rest] = broker.destinations();
    expect(rest).toEqual([]);
    expect(d.mode).toBe('manual');
    expect(d.setups).toEqual([]);
    expect(d.ratio).toBeNull();          // it IS the standard account
  });

  test('and it can still be armed', () => {
    broker.save({ webhookUrl: HOOK_A, buyingPower: 5000 });
    expect(() => broker.save({ armed: true })).not.toThrow();
  });

  test('but nothing fires by itself until an account says so', () => {
    broker.save({ webhookUrl: HOOK_A, buyingPower: 5000, armed: true });
    expect(broker.autoRoute('or935').cfgs).toEqual([]);
  });
});
