/*
 * "What am I holding, and is anything going to close it?"
 *
 * WHY IT EXISTS. Two positions were found sitting in the Alpaca account by
 * opening the broker's app. Nothing on this box had said a word about them, and
 * nothing was ever going to.
 *
 * AND WHAT THE FIRST RUN OF IT FOUND. The two names the account actually held
 * were not the two that had been reported. Either answer alone is a problem;
 * together they mean the credentials on this box and the screen being read may
 * not be the same account — so the report now leads with the account number and
 * says plainly that nothing below it means anything if that number is wrong.
 *
 * THIS SCRIPT SENDS ORDERS, which is why it is tested in-process with the
 * Alpaca transport stubbed rather than shelled out. Everything below the
 * transport is the real thing: the real carriedOver(), the real ledger, the
 * real closePosition().
 */

const os = require('os');
const path = require('path');
const fs = require('fs');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'positions-'));
process.env.BROKER_FILE = path.join(DIR, 'broker.json');
process.env.BROKER_LEDGER = path.join(DIR, 'orders.jsonl');

/*
 * The stub answers live OUTSIDE the module registry.
 *
 * Each run has to re-evaluate the script — it does its work on require — and
 * that needs jest.resetModules(), which rebuilds this factory too. A stub set
 * on the module object would land on an instance the next run never sees, so
 * the factory reads from here instead and the answers survive the reset.
 */
const mockAlpaca = { positions: null, account: null };
jest.mock('../src/alpaca/account', () => ({
  positions: jest.fn(async () => mockAlpaca.positions),
  account: jest.fn(async () => mockAlpaca.account),
  orders: jest.fn(),
  fills: jest.fn(),
}));

const broker = require('../src/broker/signalstack');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'positions.js');
const HOOK = 'https://app.signalstack.com/hook/FAKEhook0000000000000a';
const TODAY = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

let sent;
let lines;
beforeEach(() => {
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
    sent.push(JSON.parse(opts.body));
    return { ok: true, status: 201, text: async () => '{"id":"C1","status":"filled"}' };
  });

  mockAlpaca.account = { ok: true, account: {
    number: 'PA3ABCDEF', base: 'https://paper-api.alpaca.markets', equity: 100000,
    cash: 100000, buyingPower: 100000, daytradeCount: 0, tradingBlocked: false,
    accountBlocked: false, patternDayTrader: false, status: 'ACTIVE' } };
  mockAlpaca.positions = { ok: true, positions: [] };
});
afterAll(() => { fs.rmSync(DIR, { recursive: true, force: true }); });

/** Run the script with these flags, capturing what it printed. */
async function run(args = []) {
  lines = [];
  const spy = jest.spyOn(console, 'log').mockImplementation((...a) => lines.push(a.join(' ')));
  const argv = process.argv;
  process.argv = [argv[0], SCRIPT, ...args];
  // The script does its work on require, so it has to be evaluated afresh.
  jest.resetModules();
  try {
    await require(SCRIPT);
  } finally {
    process.argv = argv;
    spy.mockRestore();
  }
  return lines.join('\n');
}

const holds = rows => { mockAlpaca.positions = { ok: true,
  positions: rows.map(r => ({ symbol: 'LHSW', qty: 3697, side: 'long', avgEntry: 1,
                              marketValue: 3697, unrealised: 0, current: 1, ...r })) }; };

const ledger = rows => fs.writeFileSync(process.env.BROKER_LEDGER,
  rows.map(r => JSON.stringify({
    date: TODAY, at: Date.now(), sent: true, symbol: 'LHSW', signal: 'LONG',
    action: 'buy', price: 1, quantity: 3697, setupId: 'S@09:35',
    destination: 'alp', ...r })).join('\n'));

// ── the line that has to come first ────────────────────────────────────────

describe('which account this is', () => {
  /*
   * NOT DECORATION. Two names were reported open and the API answered with two
   * different ones, and the account number is the single line that says whether
   * that is a credentials problem or a reading problem.
   */
  test('the number is printed before anything else', async () => {
    holds([{}]);
    const out = await run();
    expect(out).toMatch(/account PA3ABCDEF/);
    expect(out.indexOf('PA3ABCDEF')).toBeLessThan(out.indexOf('LHSW'));
  });

  test('paper and live are named, because the numbers cannot tell them apart', async () => {
    holds([{}]);
    expect(await run()).toMatch(/PAPER/);
  });

  test('it says outright that the rest is meaningless if the number is wrong', async () => {
    holds([{}]);
    expect(await run()).toMatch(/nothing below is either/);
  });

  test('a blocked account is said at the top, not discovered by an order', async () => {
    mockAlpaca.account = { ok: true, account: {
      number: 'PA1', base: 'https://paper-api.alpaca.markets', equity: 1,
      tradingBlocked: true, accountBlocked: false, status: 'ACCOUNT_UPDATED' } };
    holds([{}]);
    expect(await run()).toMatch(/THIS ACCOUNT IS BLOCKED/);
  });
});

// ── the three kinds of position ────────────────────────────────────────────

describe('what it says about each position', () => {
  test('a flat account says so, rather than printing nothing', async () => {
    mockAlpaca.positions = { ok: true, positions: [] };
    const out = await run();
    expect(out).toMatch(/holding nothing/);
  });

  test('one opened today is listed as normal, with the flatten time', async () => {
    ledger([{ date: TODAY }]);
    holds([{}]);
    const out = await run();
    expect(out).toMatch(/OPEN TODAY/);
    expect(out).toMatch(/These close at/);
  });

  test('one opened earlier is called out as left over, with the day', async () => {
    ledger([{ date: '2026-08-07' }]);
    holds([{}]);
    const out = await run();
    expect(out).toMatch(/LEFT OVER FROM AN EARLIER SESSION/);
    expect(out).toMatch(/opened 2026-08-07/);
  });

  /*
   * THE CASE THE ACCOUNT WAS ACTUALLY IN. Nothing in the ledger opened either
   * name — so nothing on this box will close them, and saying that plainly is
   * the entire value of the report.
   */
  test('one this desk never opened is named, and named as untouchable', async () => {
    fs.writeFileSync(process.env.BROKER_LEDGER, '');
    holds([{}]);
    const out = await run();
    expect(out).toMatch(/NOT THIS DESK'S TO CLOSE/);
    expect(out).toMatch(/will NOT be closed/);
    expect(out).toMatch(/LHSW/);
  });

  test('and it is not closed', async () => {
    fs.writeFileSync(process.env.BROKER_LEDGER, '');
    holds([{}]);
    await run();
    expect(sent).toHaveLength(0);
  });

  /*
   * An unreachable broker must never read as a flat account — that is the one
   * mistake here that would send somebody to bed holding something.
   */
  test('an unreachable Alpaca says so and stops', async () => {
    mockAlpaca.positions = { ok: false, error: 'timed out' };
    const out = await run();
    expect(out).toMatch(/Alpaca did not answer: timed out/);
    expect(out).toMatch(/Nothing below can be trusted/);
    expect(out).not.toMatch(/holding nothing/);
  });
});

// ── closing things ─────────────────────────────────────────────────────────

describe('--close-carried', () => {
  test('closes what this desk left open, to the account that opened it', async () => {
    ledger([{ date: '2026-08-07' }]);
    holds([{}]);
    await run(['--close-carried']);
    expect(sent).toEqual([{ symbol: 'LHSW', action: 'close' }]);
  });

  /*
   * ASKED TO CLOSE AND THERE WAS NOTHING TO CLOSE. Printing the same report
   * again reads as "done" — the flag was typed because something was expected
   * to happen. This was found by running it against the real account.
   */
  test('says nothing was there to close, rather than repeating the report', async () => {
    fs.writeFileSync(process.env.BROKER_LEDGER, '');
    holds([{}]);
    const out = await run(['--close-carried']);
    expect(out).toMatch(/nothing to do/);
    expect(sent).toHaveLength(0);
  });

  /* It never touches a position this desk did not open, whatever the flag. */
  test('it does not sweep a foreign position', async () => {
    fs.writeFileSync(process.env.BROKER_LEDGER, '');
    holds([{ symbol: 'ZCMD', qty: 40322 }]);
    await run(['--close-carried']);
    expect(sent).toHaveLength(0);
  });
});

describe('--close <SYMBOL>', () => {
  /*
   * ONE NAME AT A TIME, SPELLED OUT. There is deliberately no "close
   * everything": a position this desk never opened may be a trade taken by
   * hand, and a flag that swept the account would eventually take one out on a
   * morning nobody was reading carefully.
   */
  test('closes exactly the one named', async () => {
    fs.writeFileSync(process.env.BROKER_LEDGER, '');
    mockAlpaca.positions = { ok: true, positions: [
      { symbol: 'LHSW', qty: 3697, side: 'long' },
      { symbol: 'ZCMD', qty: 40322, side: 'long' },
    ] };
    await run(['--close', 'ZCMD']);
    expect(sent).toEqual([{ symbol: 'ZCMD', action: 'close' }]);
  });

  test('it works for a foreign position — the one the other flag will not touch', async () => {
    fs.writeFileSync(process.env.BROKER_LEDGER, '');
    holds([{}]);
    const out = await run(['--close', 'LHSW']);
    expect(sent).toEqual([{ symbol: 'LHSW', action: 'close' }]);
    expect(out).toMatch(/close sent/);
  });

  test('a name that is not held sends nothing, and says what IS held', async () => {
    fs.writeFileSync(process.env.BROKER_LEDGER, '');
    holds([{}]);
    const out = await run(['--close', 'NVDA']);
    expect(sent).toHaveLength(0);
    expect(out).toMatch(/not holding NVDA/);
    expect(out).toMatch(/It is holding: LHSW/);
  });

  test('the case typed does not matter', async () => {
    fs.writeFileSync(process.env.BROKER_LEDGER, '');
    holds([{}]);
    await run(['--close', 'lhsw']);
    expect(sent).toEqual([{ symbol: 'LHSW', action: 'close' }]);
  });

  /*
   * `close` flattens the whole symbol and SignalStack accepting it is not the
   * broker having done it — both live rejections so far arrived by email hours
   * later. So it says to go and look.
   */
  test('it says to check the app afterwards', async () => {
    fs.writeFileSync(process.env.BROKER_LEDGER, '');
    holds([{}]);
    expect(await run(['--close', 'LHSW'])).toMatch(/Check the app/);
  });

  test('a refusal is reported, not swallowed', async () => {
    fs.writeFileSync(process.env.BROKER_LEDGER, '');
    holds([{}]);
    broker.save({ armed: false });
    const out = await run(['--close', 'LHSW']);
    expect(out).toMatch(/NOT SENT/);
  });
});
