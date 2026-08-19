/*
 * "Is SignalStack sending to the account this desk is reading?"
 *
 * WHY THE QUESTION CAN EVEN BE ASKED, and it is the finding rather than the
 * script. There are TWO credentials and nothing had ever compared them:
 *
 *   the WRITE side   a SignalStack hook URL. SignalStack holds its own broker
 *                    connection behind it, configured in SignalStack. This desk
 *                    POSTs and is told "accepted". It is never told whose
 *                    account that was.
 *
 *   the READ side    an Alpaca API key in the tool database. Everything that
 *                    says what is held, what filled and what it cost.
 *
 * Configured in different places, by hand, at different times. With two paper
 * accounts on one login, pointing them at different accounts is an easy mistake
 * to make and an almost invisible one to have made: orders go out and are
 * accepted, the reader says the account is flat, and both are telling the truth
 * about different accounts.
 *
 * THE ONLY PROOF IS A ROUND TRIP. A hook is an opaque URL, so the answer cannot
 * be read off anywhere — it has to be sent and looked for. That makes the two
 * verdicts the whole of this file, and getting either of them wrong is worse
 * than having no script: a false "same account" retires the right suspicion.
 */

const os = require('os');
const path = require('path');
const fs = require('fs');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'same-acct-'));
process.env.BROKER_FILE = path.join(DIR, 'broker.json');
process.env.BROKER_LEDGER = path.join(DIR, 'orders.jsonl');

/*
 * The stub answers live outside the module registry — each run re-evaluates the
 * script, which needs resetModules(), which rebuilds this factory.
 *
 * `orders` may be a FUNCTION, because the round trip polls: the interesting
 * case is an answer that changes between one poll and the next, which is what
 * an order arriving actually looks like.
 */
const mockAlpaca = { account: null, positions: null, orders: null };
const answer = v => (typeof v === 'function' ? v() : v);
jest.mock('../src/alpaca/account', () => ({
  account: jest.fn(async () => answer(mockAlpaca.account)),
  positions: jest.fn(async () => answer(mockAlpaca.positions)),
  orders: jest.fn(async () => answer(mockAlpaca.orders)),
  fills: jest.fn(),
}));

const broker = require('../src/broker/signalstack');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'same-account.js');
const HOOK = 'https://app.signalstack.com/hook/FAKEhook0000000000000a';

let sent;
let lines;
beforeEach(() => {
  // Watch briefly: the verdicts are what is being tested, not the patience.
  process.env.SAME_ACCOUNT_WAIT_MS = '300';
  process.env.SAME_ACCOUNT_POLL_MS = '50';
  fs.rmSync(process.env.BROKER_LEDGER, { force: true });
  fs.rmSync(process.env.BROKER_FILE, { force: true });
  broker.save({
    destinations: [{ id: 'alp', name: 'Alpaca', dialect: 'alpaca', webhookUrl: HOOK,
                     buyingPower: 100000, ratio: 1, mode: 'auto', setups: [] }],
    enabled: true,
  });
  broker.save({ armed: true });

  sent = [];
  global.fetch = jest.fn(async (url, opts) => {
    sent.push({ url, body: JSON.parse(opts.body) });
    return { ok: true, status: 201,
             text: async () => '{"id":"NEW1","status":"accepted"}' };
  });

  mockAlpaca.account = { ok: true, account: {
    number: 'PA3ABCDEF', base: 'https://paper-api.alpaca.markets', equity: 100000,
    cash: 100000, tradingBlocked: false, accountBlocked: false, status: 'ACTIVE' } };
  mockAlpaca.positions = { ok: true, positions: [] };
  mockAlpaca.orders = { ok: true, orders: [] };
});
afterAll(() => { fs.rmSync(DIR, { recursive: true, force: true }); });

async function run(args = []) {
  lines = [];
  const spy = jest.spyOn(console, 'log').mockImplementation((...a) => lines.push(a.join(' ')));
  const argv = process.argv;
  process.argv = [argv[0], SCRIPT, ...args];
  jest.resetModules();
  try {
    await require(SCRIPT);
  } finally {
    process.argv = argv;
    spy.mockRestore();
  }
  return lines.join('\n');
}

// ── the rule that outranks the rest of the file ────────────────────────────

describe('what it must never print', () => {
  /*
   * A HOOK ID IS THE ABILITY TO PLACE ORDERS in the account behind it — there
   * is no password in front of it — and this output exists to be pasted into a
   * chat window while working out what is wrong.
   */
  test('the hook is masked', async () => {
    const out = await run();
    expect(out).not.toContain('FAKEhook0000000000000a');
    expect(out).toMatch(/hook …\/hook\/FAKE…000a/);
  });
});

// ── step one: identity, and it sends nothing ───────────────────────────────

describe('the read side', () => {
  test('names the account, its kind and its equity', async () => {
    const out = await run();
    expect(out).toMatch(/account\s+PA3ABCDEF/);
    expect(out).toMatch(/PAPER/);
    expect(out).toMatch(/equity\s+100000/);
  });

  test('lists what that account holds, so it can be compared with the app', async () => {
    mockAlpaca.positions = { ok: true,
      positions: [{ symbol: 'LHSW', qty: 3697, avgEntry: 1 }] };
    expect(await run()).toMatch(/LHSW\s+3697/);
  });

  test('a flat account says so rather than printing an empty list', async () => {
    expect(await run()).toMatch(/none\. This account is flat/);
  });

  /* WITHOUT --send it is a read. Nothing may leave. */
  test('nothing is sent', async () => {
    await run();
    expect(sent).toHaveLength(0);
  });

  test('it stops early when the read key does not work', async () => {
    mockAlpaca.account = { ok: false, error: '401 unauthorized' };
    const out = await run(['--send']);
    expect(out).toMatch(/could not ask: 401/);
    expect(out).toMatch(/Fix that first/);
    expect(sent).toHaveLength(0);
  });

  /*
   * The honest answer to "which account is the hook on" is that this side
   * cannot know. Guessing from the hook id would invent a fact.
   */
  test('it says outright that the hook\'s account cannot be read off', async () => {
    expect(await run()).toMatch(/never tells this side which account/);
  });

  test('a LIVE read key warns before you send a share through it', async () => {
    mockAlpaca.account = { ok: true, account: {
      number: 'A1', base: 'https://api.alpaca.markets', equity: 1, status: 'ACTIVE' } };
    expect(await run()).toMatch(/LIVE account.*real money/s);
  });
});

// ── step two: the round trip, which is the only proof ──────────────────────

describe('the round trip', () => {
  test('one share, buy, through the LIVE hook — not the test one', async () => {
    broker.save({ testWebhookUrl: 'https://app.signalstack.com/hook/PREVIEWonly0000000000' });
    await run(['--send']);
    expect(sent).toHaveLength(1);
    expect(sent[0].url).toBe(HOOK);
    expect(sent[0].body).toMatchObject({ symbol: 'AAPL', action: 'buy', quantity: 1 });
  });

  test('the symbol can be chosen', async () => {
    await run(['--send', '--symbol', 'f']);
    expect(sent[0].body.symbol).toBe('F');
  });

  /*
   * SAME ACCOUNT: SignalStack accepted it AND the read key saw it appear.
   */
  test('an order that appears on the read side is proof they match', async () => {
    // Empty when the snapshot is taken, present on the next poll — which is
    // exactly what an order arriving looks like.
    let polls = 0;
    mockAlpaca.orders = () => (polls++ === 0
      ? { ok: true, orders: [] }
      : { ok: true, orders: [{ id: 'NEW1', symbol: 'AAPL', side: 'buy', qty: 1,
                               status: 'filled', filledAvg: 250 }] });
    const out = await run(['--send']);
    expect(out).toMatch(/SAME ACCOUNT/);
    expect(out).toMatch(/PA3ABCDEF is both written to and read from/);
  });

  test('and it tells you to close the share it just bought', async () => {
    let polls = 0;
    mockAlpaca.orders = () => (polls++ === 0
      ? { ok: true, orders: [] }
      : { ok: true, orders: [{ id: 'NEW1', symbol: 'AAPL', side: 'buy', qty: 1,
                               status: 'filled' }] });
    expect(await run(['--send'])).toMatch(/positions\.js --close AAPL/);
  });

  /*
   * AN ORDER THAT WAS ALREADY THERE IS NOT PROOF. The account may have traded
   * the symbol earlier, and matching on the symbol alone would answer "same
   * account" to a question nobody asked — retiring the right suspicion.
   */
  test('an order that was already there is not counted as the new one', async () => {
    mockAlpaca.orders = { ok: true, orders: [
      { id: 'OLD', symbol: 'AAPL', side: 'buy', qty: 1, status: 'filled' }] };
    expect(await run(['--send'])).toMatch(/DIFFERENT ACCOUNTS/);
  });

  /*
   * THE FINDING THIS EXISTS FOR. Accepted by SignalStack, never seen by the
   * reader — and both explanations are named, because they need opposite fixes.
   */
  test('accepted and never seen names both explanations', async () => {
    const out = await run(['--send']);
    expect(out).toMatch(/DIFFERENT ACCOUNTS/);
    expect(out).toMatch(/wired to your OTHER paper account/);
    expect(out).toMatch(/no working broker connection/);
  });

  /*
   * A REFUSAL PROVES NOTHING. It never left, so it says nothing about which
   * account it would have reached — and reporting that as "different accounts"
   * would send somebody rewiring a hook that was fine.
   */
  test('a refused send says it proves nothing, rather than guessing', async () => {
    global.fetch = jest.fn(async () => ({ ok: false, status: 402,
      text: async () => '{"message":"no buying power"}' }));
    const out = await run(['--send']);
    expect(out).toMatch(/REFUSED/);
    expect(out).toMatch(/says nothing about which account/);
    expect(out).not.toMatch(/DIFFERENT ACCOUNTS/);
  });

  /*
   * A prop-firm account has no position feed, so the reader could never see the
   * order whatever happened. Answering "different accounts" there would be a
   * false positive by construction.
   */
  test('a non-Alpaca destination is refused as unprovable', async () => {
    broker.save({ destinations: [{ id: 'ttp', name: 'TTP', dialect: 'ttp',
      webhookUrl: 'https://app.signalstack.com/hook/TESTfake0000000000000000000',
      buyingPower: 5000, ratio: 1, mode: 'auto', setups: [] }], enabled: true });
    const out = await run(['--send']);
    expect(out).toMatch(/not Alpaca/);
    expect(out).toMatch(/proves nothing/);
    expect(sent).toHaveLength(0);
  });

  test('no hook anywhere is said plainly, not treated as a mismatch', async () => {
    broker.save({ destinations: [], enabled: true });
    const out = await run(['--send']);
    expect(out).toMatch(/Nothing sends anywhere/);
    expect(sent).toHaveLength(0);
  });
});
