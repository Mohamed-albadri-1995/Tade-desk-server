/*
 * ONE ALPACA ACCOUNT PER DESTINATION.
 *
 * THE FAILURE THIS PREVENTS, which is worse than a gap.
 *
 * The desk held ONE Alpaca key pair however many Alpaca accounts were
 * configured. Every position, every fill and every account read therefore
 * answered for exactly one of them, and nothing in the answer said which.
 *
 * Confirmation matches an order to a fill by symbol, side and time. Two
 * accounts running the same desk see the same symbols in the same seconds — so
 * account B's order would match account A's fill and take A's price. Not a
 * missing number: a confident wrong one, in the record that measures execution.
 *
 * reconcile.credentialScope() refused to answer at all rather than answer
 * wrongly. This is what lets it answer.
 *
 * Every key in this file is invented. The real ones live in data/broker.json,
 * which is gitignored, and never leave the box.
 */

const os = require('os');
const path = require('path');
const fs = require('fs');

const BROKER = path.join(os.tmpdir(), `broker-percct-${process.pid}.json`);
process.env.BROKER_FILE = BROKER;
process.env.BROKER_LEDGER = path.join(os.tmpdir(), `broker-percct-${process.pid}.jsonl`);
afterAll(() => {
  for (const f of [BROKER, process.env.BROKER_LEDGER]) {
    try { fs.unlinkSync(f); } catch { /* absent */ }
  }
});

const alpaca = require('../src/alpaca/account');
const broker = require('../src/broker/signalstack');

// Invented, and long enough to pass the length check the save path applies.
const KEY_A = 'PKFAKEACCOUNTAAAAAAA';
const SEC_A = 'fakesecretAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const KEY_B = 'PKFAKEACCOUNTBBBBBBB';
const SEC_B = 'fakesecretBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
const HOOK_A = 'https://app.signalstack.com/hook/FAKEhookAAAAAAAAAAAAa';
const HOOK_B = 'https://app.signalstack.com/hook/FAKEhookBBBBBBBBBBBBb';

const write = (o) => fs.writeFileSync(BROKER, JSON.stringify(o));

describe('the credentials a destination carries', () => {
  test('a destination with both keys yields a credential', () => {
    const c = alpaca.credsOf({ alpacaKeyId: KEY_A, alpacaSecret: SEC_A });
    expect(c).toEqual({ keyId: KEY_A, secret: SEC_A, paper: true });
  });

  // PAPER UNLESS TOLD OTHERWISE. Guessing wrong towards paper queries a
  // simulator; guessing wrong the other way queries real money.
  test('paper is the default, and live has to be said', () => {
    expect(alpaca.credsOf({ alpacaKeyId: KEY_A, alpacaSecret: SEC_A }).paper).toBe(true);
    expect(alpaca.credsOf({ alpacaKeyId: KEY_A, alpacaSecret: SEC_A, alpacaPaper: false })
      .paper).toBe(false);
  });

  // Null is the signal to fall back to the desk-wide pair — correct while
  // there is one Alpaca account, refused by credentialScope when there is more.
  test('no keys yields null, not a half credential', () => {
    expect(alpaca.credsOf({ alpacaKeyId: KEY_A })).toBeNull();
    expect(alpaca.credsOf({ alpacaSecret: SEC_A })).toBeNull();
    expect(alpaca.credsOf({})).toBeNull();
    expect(alpaca.credsOf(null)).toBeNull();
  });
});

describe('a read is refused rather than answered by the wrong account', () => {
  /*
   * HALF A PAIR MUST NOT FALL BACK. Falling back here would answer for a
   * DIFFERENT account than the caller named, silently — which is the exact
   * failure the parameter exists to prevent, arriving through the door marked
   * "safe default".
   */
  test('half a key pair is an error, not a silent fallback', async () => {
    const r = await alpaca.positions({ account: { keyId: KEY_A }, timeoutMs: 50 });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/half an Alpaca key pair/);
  });

  test('...on every one of the four reads', async () => {
    const half = { account: { secret: SEC_A }, timeoutMs: 50 };
    for (const fn of ['positions', 'orders', 'fills', 'account']) {
      const r = await alpaca[fn](half);
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/half an Alpaca key pair/);
    }
  });
});

describe('two accounts, stored side by side', () => {
  beforeEach(() => {
    write({
      enabled: true,
      destinations: [
        { id: 'paperA', name: 'Paper A', dialect: 'alpaca', mode: 'auto',
          webhookUrl: HOOK_A, enabled: true, setups: ['OR + VWAP 09:35@09:35'],
          alpacaKeyId: KEY_A, alpacaSecret: SEC_A },
        { id: 'paperB', name: 'Paper B', dialect: 'alpaca', mode: 'auto',
          webhookUrl: HOOK_B, enabled: true, setups: ['Test@09:30'],
          alpacaKeyId: KEY_B, alpacaSecret: SEC_B },
      ],
    });
  });

  test('each destination carries its own key pair', () => {
    const [a, b] = broker.destinations();
    expect(alpaca.credsOf(a).keyId).toBe(KEY_A);
    expect(alpaca.credsOf(b).keyId).toBe(KEY_B);
    expect(alpaca.credsOf(a).secret).not.toBe(alpaca.credsOf(b).secret);
  });

  test('and its own setup list, so one setup runs in one account', () => {
    expect(broker.accountsFor('OR + VWAP 09:35@09:35').map(c => c.destinationId))
      .toEqual(['paperA']);
    expect(broker.accountsFor('Test@09:30').map(c => c.destinationId))
      .toEqual(['paperB']);
  });

  test('the cfg handed to an order carries the keys too', () => {
    const cfg = broker.destinationCfg('paperB');
    expect(alpaca.credsOf(cfg).keyId).toBe(KEY_B);
  });
});

/*
 * THE SECRET NEVER LEAVES THE PROCESS.
 *
 * publicSettings() is what the page reads, and a page can be photographed and
 * has been pasted into a chat window. A hook is masked because its tail is
 * useful for checking it against SignalStack; a secret has no such use, so the
 * only safe number of places it appears is one.
 */
describe('what the page is allowed to see', () => {
  beforeEach(() => {
    write({
      enabled: true,
      destinations: [
        { id: 'paperA', name: 'Paper A', dialect: 'alpaca', mode: 'auto',
          webhookUrl: HOOK_A, enabled: true, setups: [],
          alpacaKeyId: KEY_A, alpacaSecret: SEC_A },
      ],
    });
  });

  test('the secret is DELETED, not masked', () => {
    const pub = broker.publicSettings();
    const json = JSON.stringify(pub);
    expect(json).not.toContain(SEC_A);
    expect(pub.destinations[0].alpacaSecret).toBeUndefined();
  });

  // The key id IS shown, shortened: it is how two accounts are told apart on
  // screen, and it cannot place an order on its own.
  test('the key id is shortened, never whole', () => {
    const d = broker.publicSettings().destinations[0];
    expect(d.alpacaKeyId).not.toBe(KEY_A);
    expect(d.alpacaKeyId).toMatch(/…/);
    expect(d.alpacaKeyId).toContain(KEY_A.slice(-4));
  });

  // What the page actually needs: can this account be read at all?
  test('...and a plain yes/no on whether the account has keys', () => {
    expect(broker.publicSettings().destinations[0].hasAlpacaKeys).toBe(true);
  });

  test('an account with no keys says so', () => {
    write({ enabled: true, destinations: [
      { id: 'ttp', name: 'TTP', dialect: 'ttp', mode: 'auto',
        webhookUrl: HOOK_A, enabled: true, setups: [] }] });
    expect(broker.publicSettings().destinations[0].hasAlpacaKeys).toBe(false);
  });

  // The whole hook is still never exposed either — the existing rule, re-checked
  // here because this file adds a second secret to the same object.
  test('the hook is still masked beside it', () => {
    const d = broker.publicSettings().destinations[0];
    expect(d.webhookUrl).not.toBe(HOOK_A);
    expect(d.hasWebhook).toBe(true);
  });
});

describe('saving them', () => {
  beforeEach(() => {
    write({ enabled: true, destinations: [
      { id: 'paperA', name: 'Paper A', dialect: 'alpaca', mode: 'auto',
        webhookUrl: HOOK_A, enabled: true, setups: [] }] });
  });

  const saveDest = (patch) => broker.save({
    destinations: [{ id: 'paperA', name: 'Paper A', dialect: 'alpaca',
                     webhookUrl: HOOK_A, ...patch }],
  });

  test('a valid pair is stored', () => {
    saveDest({ alpacaKeyId: KEY_A, alpacaSecret: SEC_A });
    expect(broker.destinations()[0].alpacaKeyId).toBe(KEY_A);
  });

  /*
   * HALF A PAIR AUTHENTICATES NOTHING, and it would read on the page as "this
   * account has its own keys" — the claim reconciliation relies on to attribute
   * a fill to an account.
   */
  test('half a pair is refused', () => {
    expect(() => saveDest({ alpacaKeyId: KEY_A })).toThrow(/needs its secret/);
    expect(() => saveDest({ alpacaSecret: SEC_A })).toThrow(/needs its key id/);
  });

  // A key pasted with its quotes fails at the first request with a 401, hours
  // later, in a log nobody is reading. Caught at the door instead.
  test('quotes are refused at the door', () => {
    expect(() => saveDest({ alpacaKeyId: `"${KEY_A}"`, alpacaSecret: SEC_A }))
      .toThrow(/quotes or spaces/);
    expect(() => saveDest({ alpacaKeyId: KEY_A, alpacaSecret: `${SEC_A.slice(0, 20)} ${SEC_A.slice(20)}` }))
      .toThrow(/quotes or spaces/);
  });

  // SURROUNDING whitespace is TRIMMED, not refused. Copying a key out of the
  // Alpaca dashboard picks up a trailing space or newline constantly, and
  // rejecting that would be an error message about something the desk can
  // simply fix. Whitespace INSIDE the key is a different thing and still throws.
  test('...but a trailing newline from a copy-paste is just trimmed', () => {
    saveDest({ alpacaKeyId: `  ${KEY_A}\n`, alpacaSecret: `${SEC_A}  ` });
    expect(broker.destinations()[0].alpacaKeyId).toBe(KEY_A);
    expect(broker.destinations()[0].alpacaSecret).toBe(SEC_A);
  });

  test('something far too short is refused', () => {
    expect(() => saveDest({ alpacaKeyId: 'abc', alpacaSecret: SEC_A }))
      .toThrow(/does not look like/);
  });

  // NOT MENTIONED KEEPS WHAT IS THERE. Saving a rename must not silently drop
  // the credentials and put the account back on the desk-wide pair.
  test('a save that does not mention the keys keeps them', () => {
    saveDest({ alpacaKeyId: KEY_A, alpacaSecret: SEC_A });
    broker.save({ destinations: [{ id: 'paperA', name: 'Renamed',
                                   dialect: 'alpaca', webhookUrl: HOOK_A }] });
    expect(broker.destinations()[0].alpacaKeyId).toBe(KEY_A);
    expect(broker.destinations()[0].name).toBe('Renamed');
  });

  // ...and an EMPTY STRING is removal, which is how an account is deliberately
  // put back on the desk-wide pair.
  test('an empty string removes them', () => {
    saveDest({ alpacaKeyId: KEY_A, alpacaSecret: SEC_A });
    saveDest({ alpacaKeyId: '', alpacaSecret: '' });
    expect(broker.destinations()[0].alpacaKeyId).toBeNull();
    expect(broker.destinations()[0].alpacaSecret).toBeNull();
  });

  test('paper is the stored default, and live is explicit', () => {
    saveDest({ alpacaKeyId: KEY_A, alpacaSecret: SEC_A });
    expect(broker.destinations()[0].alpacaPaper).toBe(true);
    saveDest({ alpacaKeyId: KEY_A, alpacaSecret: SEC_A, alpacaPaper: false });
    expect(broker.destinations()[0].alpacaPaper).toBe(false);
  });
});

/*
 * NOTHING ELSE MOVED. The market-data side of alpaca/client.js is deliberately
 * untouched: bars and shortability are facts about the MARKET, not about an
 * account, and any valid key answers them identically. Threading a per-account
 * credential through them would be churn that could only introduce a fault.
 */
describe('the market-data path is left alone', () => {
  test('client.js still exposes the shared credential helpers', () => {
    const client = require('../src/alpaca/client');
    for (const fn of ['fetchIntradayBars', 'fetchDailyBars', 'checkShortable',
                      'authHeaders', 'getAccountBaseUrl']) {
      expect(typeof client[fn]).toBe('function');
    }
  });

  test('and takes no account argument', () => {
    // Length is the signature: a per-account variant would have added one.
    expect(require('../src/alpaca/client').authHeaders.length).toBe(0);
  });
});

/*
 * ── THE ONE THAT COSTS MONEY ─────────────────────────────────────────────
 *
 * Confirmation matches an order to a fill by symbol, side and time. Two
 * accounts running the same desk fire the same symbol in the same second, so
 * pooling their fills and matching every row against the pool would confirm
 * account B's order with account A's print — at A's price — and the match
 * would look perfect.
 *
 * Each account's rows are confirmed ONLY against fills fetched with that
 * account's own credentials.
 */
describe("an account's fills confirm only its own orders", () => {
  const reconcile = require('../src/broker/reconcile');
  const DAY = '2026-09-01';

  // Same symbol, same side, same second, DIFFERENT prices — the shape that
  // makes a pooled match succeed and be wrong.
  const FILLS = {
    paperA: [{ id: 'fa', orderId: 'oa', symbol: 'WULF', side: 'sell_short',
               qty: 100, price: 15.37, at: `${DAY}T13:36:02Z`, type: 'fill' }],
    paperB: [{ id: 'fb', orderId: 'ob', symbol: 'WULF', side: 'sell_short',
               qty: 100, price: 99.99, at: `${DAY}T13:36:02Z`, type: 'fill' }],
  };

  let asked;
  beforeEach(() => {
    write({
      enabled: true,
      destinations: [
        { id: 'paperA', name: 'Paper A', dialect: 'alpaca', mode: 'auto',
          webhookUrl: HOOK_A, enabled: true, setups: [],
          alpacaKeyId: KEY_A, alpacaSecret: SEC_A },
        { id: 'paperB', name: 'Paper B', dialect: 'alpaca', mode: 'auto',
          webhookUrl: HOOK_B, enabled: true, setups: [],
          alpacaKeyId: KEY_B, alpacaSecret: SEC_B },
      ],
    });
    asked = [];
    // Answer as whichever account the CREDENTIALS name. Anything that reaches
    // Alpaca with the wrong key gets the wrong account's prints, which is
    // precisely what is being tested.
    jest.spyOn(alpaca, 'fills').mockImplementation(async ({ account: acct }) => {
      const who = acct && acct.keyId === KEY_B ? 'paperB'
        : (acct && acct.keyId === KEY_A ? 'paperA' : 'shared');
      asked.push(who);
      if (who === 'shared') return { ok: false, error: 'desk-wide pair used' };
      return { ok: true, fills: FILLS[who] };
    });
    // The ledger's own shape: `action` (not `signal`) and `sent`, which is what
    // confirmFromFills matches on. A fixture that invented its own field names
    // would pass by never matching anything at all.
    const at = Date.parse(`${DAY}T13:36:00Z`);
    jest.spyOn(broker, 'reconciled').mockReturnValue([
      { id: 'oa', date: DAY, symbol: 'WULF', action: 'sell', quantity: 100,
        at, sent: true, status: 'accepted', destination: 'paperA' },
      { id: 'ob', date: DAY, symbol: 'WULF', action: 'sell', quantity: 100,
        at, sent: true, status: 'accepted', destination: 'paperB' },
    ]);
  });
  afterEach(() => jest.restoreAllMocks());

  test('BOTH accounts are asked, each with its own key', async () => {
    await reconcile.confirmed(DAY);
    expect(asked.sort()).toEqual(['paperA', 'paperB']);
  });

  test("each order takes ITS OWN account's price", async () => {
    const out = await reconcile.confirmed(DAY);
    const a = out.rows.find(r => r.id === 'oa');
    const b = out.rows.find(r => r.id === 'ob');
    expect(a.finalPrice).toBe(15.37);
    expect(b.finalPrice).toBe(99.99);
    expect([a.confirmedBy, b.confirmedBy]).toEqual(['alpaca', 'alpaca']);
  });

  test('...and the run reports itself verified', async () => {
    const out = await reconcile.confirmed(DAY);
    expect(out.ok).toBe(true);
    expect(out.verifiable).toBe(true);
    expect(out.ambiguous).toBeUndefined();
  });

  /*
   * ONE UNREADABLE ACCOUNT MUST NOT POISON THE OTHER. Its rows come back
   * unconfirmed and named; the account that CAN be read is still confirmed,
   * because a day report that went dark over one account would be a worse
   * failure than one that says which prices are missing.
   */
  test('an account with no keys is named, and the other still confirms', async () => {
    write({
      enabled: true,
      destinations: [
        { id: 'paperA', name: 'Paper A', dialect: 'alpaca', mode: 'auto',
          webhookUrl: HOOK_A, enabled: true, setups: [],
          alpacaKeyId: KEY_A, alpacaSecret: SEC_A },
        { id: 'paperB', name: 'Paper B', dialect: 'alpaca', mode: 'auto',
          webhookUrl: HOOK_B, enabled: true, setups: [] },
      ],
    });
    const out = await reconcile.confirmed(DAY);
    expect(out.ok).toBe(false);
    expect(out.ambiguous).toBe(true);
    expect(out.error).toMatch(/paperB/);
    // A confirmed, at its own price. B untouched rather than given A's.
    expect(out.rows.find(r => r.id === 'oa').finalPrice).toBe(15.37);
    // NOT given A's price — left unconfirmed, which is the whole point.
    expect(out.rows.find(r => r.id === 'ob').finalPrice).toBeUndefined();
    expect(out.rows.find(r => r.id === 'ob').confirmed).toBeUndefined();
    // ...and the readable account was still asked.
    expect(asked).toContain('paperA');
    expect(asked).not.toContain('shared');
  });

  test('the scope names which accounts are readable and which are blind', () => {
    write({
      enabled: true,
      destinations: [
        { id: 'paperA', name: 'Paper A', dialect: 'alpaca', mode: 'auto',
          webhookUrl: HOOK_A, enabled: true, setups: [],
          alpacaKeyId: KEY_A, alpacaSecret: SEC_A },
        { id: 'paperB', name: 'Paper B', dialect: 'alpaca', mode: 'auto',
          webhookUrl: HOOK_B, enabled: true, setups: [] },
      ],
    });
    const scope = reconcile.credentialScope();
    expect(scope.readable).toEqual(['paperA']);
    expect(scope.blind).toEqual(['paperB']);
    expect(scope.ambiguous).toBe(true);
  });

  // THE SINGLE-ACCOUNT DESK IS UNCHANGED. One Alpaca account with no keys of
  // its own is exactly what the desk-wide pair is, and it must keep working
  // without anyone typing a key in.
  test('one keyless Alpaca account still reads, on the desk-wide pair', () => {
    write({ enabled: true, destinations: [
      { id: 'alp', name: 'Alpaca', dialect: 'alpaca', mode: 'auto',
        webhookUrl: HOOK_A, enabled: true, setups: [] }] });
    const scope = reconcile.credentialScope();
    expect(scope.readable).toEqual(['alp']);
    expect(scope.ambiguous).toBe(false);
    expect(scope.reason).toBeNull();
  });
});
