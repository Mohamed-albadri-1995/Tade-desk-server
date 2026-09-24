/*
 * THE ACCOUNT'S MONEY IS WHAT THE DESK IS TOLD, AND COMES BACK WHEN A TRADE CLOSES.
 *
 * Decided 2026-09-24, for the Trade The Pool evaluation: TTP is reached only
 * through SignalStack and can never be asked for a balance or a position, so
 * the Alpaca account is sized the way TTP will be — and the way the backtest
 * is ("credit everything that CLOSED before this entry").
 *
 *   money     = the standard account size × this account's "Size vs standard"
 *               (the account's own size when it has one; the old typed buying
 *               power only for a config that has neither)
 *   left      = money − the trades still OPEN, by the desk's own records:
 *               closed = a close this desk sent after the entry, or the
 *               backtest engine saying the trade is over (the manager's pass)
 *
 * EXEL, 2026-09-24: $100k account, DINO $41k (closed at 10:12), MGNI $56k
 * (open). EXEL at 10:45 got 54 shares — the old tally still counted DINO.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'capital-'));
process.env.BROKER_FILE = path.join(DIR, 'broker.json');
process.env.BROKER_LEDGER = path.join(DIR, 'orders.jsonl');
process.env.RISK_FILE = path.join(DIR, 'risk.json');
process.env.SESSION_LOG_DIR = path.join(DIR, 'history');

jest.mock('../src/alpaca/account', () => ({ account: jest.fn(), credsOf: () => null }));
const alpacaAccount = require('../src/alpaca/account');
const broker = require('../src/broker/signalstack');

const DAY = '2026-09-24';
const HOOK = 'https://app.signalstack.com/hook/FAKEhook0000000000000a';
const HOOK2 = 'https://app.signalstack.com/hook/TESTfake0000000000000000000';
const t = (hhmm) => Date.parse(`${DAY}T${hhmm}:00-04:00`);

function setup({ standard = 100000, ratio = 1, own = null, typed = null } = {}) {
  fs.writeFileSync(process.env.RISK_FILE, JSON.stringify(standard ? { accountSize: standard } : {}));
  broker.save({ enabled: true, destinations: [
    { id: 'alpaca2', name: 'Alpaca100ktest', dialect: 'alpaca', webhookUrl: HOOK,
      ratio, accountSize: own, buyingPower: typed, mode: 'auto', setups: [] },
    { id: 'ttp', name: 'TTP', dialect: 'ttp', webhookUrl: HOOK2,
      ratio: 0.05, mode: 'auto', setups: [] },
  ] });
  return broker.destinationCfg('alpaca2');
}
const entry = (symbol, at, quantity, price, extra = {}) => ({
  date: DAY, at: t(at), sent: true, symbol, signal: 'LONG', quantity, price,
  destination: 'alpaca2', setupId: 'Test@09:30', ...extra });
const close = (symbol, at, extra = {}) => ({
  date: DAY, at: t(at), kind: 'flatten', action: 'close', sent: true, symbol,
  destination: 'alpaca2', ...extra });
const ledger = (rows) => fs.writeFileSync(process.env.BROKER_LEDGER,
  rows.map(r => JSON.stringify(r)).join('\n') + '\n');
const pass = (at, positions) => {
  fs.mkdirSync(process.env.SESSION_LOG_DIR, { recursive: true });
  fs.appendFileSync(path.join(process.env.SESSION_LOG_DIR, `session-${DAY.slice(0, 7)}.jsonl`),
    `${JSON.stringify({ kind: 'pass', date: DAY, at: t(at), positions })}\n`);
};

beforeEach(() => {
  for (const f of [process.env.BROKER_LEDGER, process.env.BROKER_FILE, process.env.RISK_FILE]) {
    fs.rmSync(f, { force: true });
  }
  fs.rmSync(process.env.SESSION_LOG_DIR, { recursive: true, force: true });
  alpacaAccount.account.mockReset();
});
afterAll(() => fs.rmSync(DIR, { recursive: true, force: true }));

describe('how much money the account has', () => {
  test('the standard account size × this account\'s "Size vs standard"', () => {
    const cfg = setup({ standard: 100000, ratio: 0.9 });
    expect(broker.capitalFor(cfg)).toEqual({ amount: 90000, source: 'the account size 100000 × 0.9' });
    expect(broker.remaining(DAY, cfg)).toBe(90000);
  });

  test('an account\'s own size wins over the scaled standard', () => {
    expect(broker.capitalFor(setup({ own: 25000 })).amount).toBe(25000);
  });

  test('no size anywhere: the old typed buying power, and only then', () => {
    expect(broker.capitalFor(setup({ standard: null, typed: 20000 })).amount).toBe(20000);
    expect(broker.capitalFor(setup({ standard: 100000, typed: 20000 })).amount).toBe(100000);
  });

  test('nothing set at all: no cap from here', () => {
    expect(broker.remaining(DAY, setup({ standard: null }))).toBeNull();
  });
});

describe('money comes back when a trade closes', () => {
  test('EXEL, 2026-09-24: DINO closed, MGNI still open — only MGNI counts', () => {
    const cfg = setup();
    ledger([entry('DINO', '09:45', 384, 107.49), entry('MGNI', '09:51', 2297, 24.22),
            close('DINO', '10:12')]);
    const left = broker.remaining(DAY, cfg);
    expect(left).toBeCloseTo(100000 - 2297 * 24.22, 2);
    const fit = broker.fitQuantity({ quantity: 1757, price: 56.9, date: DAY, cfg });
    expect(fit.quantity).toBe(Math.floor(left / 56.9));           // 782, not 54
    expect(fit.quantity).toBeGreaterThan(700);
  });

  test('a close sent BEFORE the entry does not free it (an earlier round trip)', () => {
    const cfg = setup();
    ledger([close('MGNI', '09:40'), entry('MGNI', '09:51', 1000, 20)]);
    expect(broker.remaining(DAY, cfg)).toBe(80000);
  });

  test('the backtest engine saying it is over frees it — a stop the broker filled', () => {
    const cfg = setup();
    ledger([entry('EXEL', '10:45', 1000, 50)]);
    pass('11:39', [{ symbol: 'EXEL' }]);
    expect(broker.remaining(DAY, cfg)).toBe(50000);
    pass('11:40', [{ symbol: 'EXEL', flat: true }]);
    expect(broker.remaining(DAY, cfg)).toBe(100000);
  });

  test('Alpaca is never asked, for money or for positions', () => {
    const cfg = setup();
    ledger([entry('MGNI', '09:51', 1000, 20)]);
    broker.remaining(DAY, cfg);
    broker.fitQuantity({ quantity: 10, price: 20, date: DAY, cfg });
    expect(alpacaAccount.account).not.toHaveBeenCalled();
  });

  test('a refused order holds no money', () => {
    const cfg = setup();
    ledger([entry('MAZE', '09:35', 2040, 27.79, { sent: false })]);
    expect(broker.remaining(DAY, cfg)).toBe(100000);
  });

  test('the intent row written before a send is not a second position', () => {
    const cfg = setup();
    ledger([entry('U', '09:53', 1161, 41.95, { kind: 'intent' }), entry('U', '09:53', 1161, 41.95)]);
    expect(broker.remaining(DAY, cfg)).toBeCloseTo(100000 - 1161 * 41.95, 2);
  });

  test('another account\'s trades are not this account\'s', () => {
    const cfg = setup();
    ledger([entry('MGNI', '09:51', 1000, 20, { destination: 'ttp' })]);
    expect(broker.remaining(DAY, cfg)).toBe(100000);
  });

  test('a close in ANOTHER account does not free this one', () => {
    const cfg = setup();
    ledger([entry('MGNI', '09:51', 1000, 20), close('MGNI', '10:00', { destination: 'ttp' })]);
    expect(broker.remaining(DAY, cfg)).toBe(80000);
  });

  test('over-committed is zero, never negative', () => {
    const cfg = setup({ standard: 10000 });
    ledger([entry('MGNI', '09:51', 1000, 20)]);
    expect(broker.remaining(DAY, cfg)).toBe(0);
  });

  test('the cut says which number bit, so you go to the right setting', () => {
    const cfg = setup({ standard: 100000, ratio: 0.9 });
    ledger([entry('MGNI', '09:51', 3000, 20)]);
    const fit = broker.fitQuantity({ quantity: 5000, price: 20, date: DAY, cfg });
    expect(fit.reason).toMatch(/left of the account size 100000 × 0\.9, after the trades still open/);
  });
});

describe('arming asks for an account size, not a buying power', () => {
  test('arming with a standard size set is allowed with no buying power typed', () => {
    setup({ standard: 100000 });
    expect(() => broker.save({ armed: true })).not.toThrow();
  });
  test('arming with no size anywhere names the account and the setting', () => {
    setup({ standard: null });
    expect(() => broker.save({ armed: true })).toThrow(/Alpaca100ktest, TTP has no account size .*Standard account/);
  });
});

describe('the account card shows the money, calculated', () => {
  test('publicSettings carries it per account, with where it came from', () => {
    setup({ standard: 100000, ratio: 0.9 });
    const d = broker.publicSettings().destinations.find(x => x.id === 'alpaca2');
    expect(d.capital).toEqual({ amount: 90000, source: 'the account size 100000 × 0.9' });
  });
});
