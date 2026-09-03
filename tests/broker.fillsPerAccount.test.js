/*
 * THE JOURNAL'S FILLS, READ FROM EVERY ACCOUNT.
 *
 * Two Alpaca accounts, both with their own key pairs, both readable. And two
 * endpoints on the same desk that disagreed about how many accounts exist:
 *
 *   /api/broker/journal-trades  →  ok, accounts: [alpaca1, alpaca2]
 *   /api/broker/fills           →  the desk-wide pair, one account, alone
 *
 * `journal-trades` had been taught to walk destinations. `fillsFor` — which is
 * what the journal's status line and the fill line on every card read — still
 * called `alpaca.fills({ after, timeoutMs })` with no account, and that means
 * the shared credentials. Reported as "both alpaca1 and 2 are not connected to
 * journal", which was exactly right.
 *
 * The rule `confirmed()` states for itself applies here one step later:
 * pooling two accounts' fills lets one account's print answer for the other's
 * order. A card showing the fill price from the account that did NOT trade it
 * is a wrong number wearing a right one's clothes.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'fills-'));
process.env.BROKER_FILE = path.join(DIR, 'broker.json');
process.env.BROKER_LEDGER = path.join(DIR, 'orders.jsonl');

jest.mock('../src/alpaca/account', () => ({
  positions: jest.fn(),
  account: jest.fn(),
  fills: jest.fn(),
  credsOf: jest.requireActual('../src/alpaca/account').credsOf,
}));

const alpaca = require('../src/alpaca/account');
const broker = require('../src/broker/signalstack');
const reconcile = require('../src/broker/reconcile');

const HOOK1 = 'https://app.signalstack.com/hook/FAKEhook0000000000000a';
const HOOK2 = 'https://app.signalstack.com/hook/TESTfake0000000000000000000';
const K1 = 'PKFAKEACCOUNTAAAAAAA';
const S1 = 'fakesecretAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const K2 = 'PKFAKEACCOUNTBBBBBBB';
const S2 = 'fakesecretBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
const DAY = '2026-09-03';

/** One print, in the shape src/alpaca/account.fills returns. */
const fill = (symbol, side, qty, price) => ({ symbol, side, qty, price,
                                              at: `${DAY}T14:31:00Z` });

beforeEach(() => {
  fs.rmSync(process.env.BROKER_LEDGER, { force: true });
  fs.rmSync(process.env.BROKER_FILE, { force: true });
  broker.save({
    destinations: [
      { id: 'alpaca1', name: 'alpaca100k935', dialect: 'alpaca', webhookUrl: HOOK1,
        alpacaKeyId: K1, alpacaSecret: S1,
        buyingPower: 100000, ratio: 1, mode: 'auto', setups: [] },
      { id: 'alpaca2', name: 'Alpaca100ktest', dialect: 'alpaca', webhookUrl: HOOK2,
        alpacaKeyId: K2, alpacaSecret: S2,
        buyingPower: 100000, ratio: 1, mode: 'auto', setups: [] },
    ],
    enabled: true,
  });
  alpaca.fills.mockReset();
});

/** Answer each account with its own prints, keyed by the credentials used. */
function fillsByAccount(map) {
  alpaca.fills.mockImplementation(async ({ account }) => {
    const key = account && account.keyId;
    return { ok: true, fills: map[key] || [] };
  });
}

describe('the day\'s fills cover every readable account', () => {
  test('BOTH accounts are asked, each with its OWN keys', async () => {
    fillsByAccount({ [K1]: [fill('AAA', 'buy', 10, 5)],
                     [K2]: [fill('BBB', 'buy', 20, 7)] });
    const out = await reconcile.fillsFor(DAY);

    const used = alpaca.fills.mock.calls.map(c => c[0].account.keyId).sort();
    expect(used).toEqual([K1, K2]);
    expect(out.ok).toBe(true);
    expect(out.symbols.map(s => s.symbol).sort()).toEqual(['AAA', 'BBB']);
  });

  test('...and never with the desk-wide pair, which answers for one account', async () => {
    // `account: undefined` is the bug: it falls back to data/keys.json, which
    // points at whichever account those keys belong to and no other.
    fillsByAccount({ [K1]: [], [K2]: [] });
    await reconcile.fillsFor(DAY);
    for (const [args] of alpaca.fills.mock.calls) {
      expect(args.account).toBeTruthy();
    }
  });

  test('every fill carries the account that made it', async () => {
    fillsByAccount({ [K1]: [fill('AAA', 'buy', 10, 5)],
                     [K2]: [fill('BBB', 'buy', 20, 7)] });
    const out = await reconcile.fillsFor(DAY);
    const byS = Object.fromEntries(out.symbols.map(s => [s.symbol, s.account]));
    expect(byS).toEqual({ AAA: 'alpaca1', BBB: 'alpaca2' });
  });

  /*
   * THE SAME TICKER IN BOTH ACCOUNTS IS TWO POSITIONS. Grouping on the symbol
   * alone averages two entry prices into one neither account paid, and prints
   * it on the card as the fill.
   */
  test('one ticker held in both accounts stays two groups, at two prices', async () => {
    fillsByAccount({ [K1]: [fill('AAA', 'buy', 100, 10)],
                     [K2]: [fill('AAA', 'buy', 100, 20)] });
    const out = await reconcile.fillsFor(DAY);
    const aaa = out.symbols.filter(s => s.symbol === 'AAA');
    expect(aaa).toHaveLength(2);
    expect(aaa.map(g => g.avgBuy).sort((a, b) => a - b)).toEqual([10, 20]);
    // The average of the two would be 15 — a price nobody paid.
    expect(aaa.some(g => g.avgBuy === 15)).toBe(false);
  });

  test('the answer names which accounts it covers', async () => {
    fillsByAccount({ [K1]: [fill('AAA', 'buy', 10, 5)], [K2]: [] });
    const out = await reconcile.fillsFor(DAY);
    expect(out.accounts.sort()).toEqual(['alpaca1', 'alpaca2']);
  });

  /*
   * ONE ACCOUNT FAILING IS A PARTIAL ANSWER, NOT AN EMPTY ONE. A page that
   * showed the other account's names with no warning would read as the whole
   * day.
   */
  test('one account failing still returns the other, and says so', async () => {
    alpaca.fills.mockImplementation(async ({ account }) => (
      account.keyId === K1
        ? { ok: true, fills: [fill('AAA', 'buy', 10, 5)] }
        : { ok: false, error: 'timeout' }));
    const out = await reconcile.fillsFor(DAY);
    expect(out.ok).toBe(true);
    expect(out.symbols.map(s => s.symbol)).toEqual(['AAA']);
    expect(out.partial.join(' ')).toMatch(/alpaca2.*timeout/);
    expect(out.accounts).toEqual(['alpaca1']);
  });

  test('every account failing is a failure, not an empty day', async () => {
    // An empty fills list reads as "you traded nothing", which is the single
    // most misleading thing this could return.
    alpaca.fills.mockResolvedValue({ ok: false, error: 'timeout' });
    const out = await reconcile.fillsFor(DAY);
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/timeout/);
  });

  test('a thrown request is caught and named, not propagated', async () => {
    alpaca.fills.mockImplementation(async ({ account }) => {
      if (account.keyId === K2) throw new Error('socket hang up');
      return { ok: true, fills: [fill('AAA', 'buy', 10, 5)] };
    });
    const out = await reconcile.fillsFor(DAY);
    expect(out.ok).toBe(true);
    expect(out.partial.join(' ')).toMatch(/alpaca2.*socket hang up/);
  });

  test('no Alpaca account at all says so rather than returning nothing', async () => {
    broker.save({ destinations: [
      { id: 'ttp', name: 'TTP', dialect: 'ttp', webhookUrl: HOOK2,
        buyingPower: 5000, ratio: 0.05, mode: 'auto', setups: [] }], enabled: true });
    const out = await reconcile.fillsFor(DAY);
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/no Alpaca account/i);
  });

  test('the reading that showed this is recorded where the fix is', () => {
    // WHITESPACE-NORMALISED. The phrase wraps across two comment lines, and a
    // raw substring search cannot see it — the same trap this repo has now hit
    // several times. A check against prose has to read it the way a person does.
    const src = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'broker', 'reconcile.js'), 'utf8');
    expect(src.replace(/\s*\*\s*/g, ' ').replace(/\s+/g, ' '))
      .toContain('not connected to journal');
  });
});
