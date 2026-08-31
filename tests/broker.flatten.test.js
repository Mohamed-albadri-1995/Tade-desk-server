/*
 * Closing what the box opened, before the bell.
 *
 * THE HOLE THIS FILLS. A strategy can leave part of a position with no exit the
 * broker can hold. "Take half at 2R and let the rest run" — the 09:35
 * opening-range setup does exactly this — sends a runner with a stop and no
 * target. A backtest closes it at the session's end. A broker does not: it sits
 * there overnight, in an account that is not allowed to hold overnight, and
 * nothing anywhere says so.
 */

const os = require('os');
const path = require('path');
const fs = require('fs');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'flatten-'));
process.env.BROKER_FILE = path.join(DIR, 'broker.json');
process.env.BROKER_LEDGER = path.join(DIR, 'orders.jsonl');
process.env.ALERT_RULES_FILE = path.join(DIR, 'rules.json');
process.env.ALERT_FIRES_FILE = path.join(DIR, 'fires.json');
process.env.ALERT_HISTORY_DIR = path.join(DIR, 'history');

jest.mock('../src/broker/reconcile', () => ({
  // Unasked by default: the flatten then behaves exactly as it did before the
  // broker was consulted at all — today's ledger and nothing else.
  carriedOver: jest.fn(async () => ({ ok: false, error: 'not asked' })),
  alpacaDestinations: jest.fn(() => ['alp']),
}));

const broker = require('../src/broker/signalstack');
const reconcile = require('../src/broker/reconcile');
const flattener = require('../src/alerts/flattener');
const store = require('../src/alerts/store');

const HOOK = 'https://app.signalstack.com/hook/FAKEhook0000000000000a';
const DAY = '2026-08-10';                       // a Monday
const ok = () => ({ ok: true, status: 201, text: async () => '{"id":"C1","status":"filled"}' });

let sent;
function armed(extra = {}) {
  broker.save({ webhookUrl: HOOK, buyingPower: 100000, enabled: true, ...extra });
  broker.save({ armed: true });
}

beforeEach(() => {
  for (const f of ['broker.json', 'orders.jsonl', 'fires.json']) {
    fs.rmSync(path.join(DIR, f), { force: true });
  }
  flattener.reset();
  sent = [];
  global.fetch = jest.fn(async (url, opts) => {
    sent.push(JSON.parse(opts.body)); return ok();
  });
  reconcile.carriedOver.mockReset();
  reconcile.carriedOver.mockResolvedValue({ ok: false, error: 'not asked' });
});
afterAll(() => { fs.rmSync(DIR, { recursive: true, force: true }); });

const buy = (symbol, over = {}) => broker.placeOrder({
  symbol, signal: 'LONG', quantity: 10, price: 29.05, stop: 27.68,
  date: DAY, ...over,
});

// ── what is believed to be open ───────────────────────────────────────────

test('a symbol that was bought is believed open', async () => {
  armed();
  await buy('LIFE');
  expect(broker.openSymbols(DAY)).toEqual(['LIFE']);
});

test('a symbol that was refused is not', async () => {
  armed();
  global.fetch = jest.fn(async () => ({
    ok: false, status: 400, text: async () => '{"status":"ValidationError","message":"no"}',
  }));
  await buy('LIFE');
  expect(broker.openSymbols(DAY)).toEqual([]);
});

test('a symbol already closed is not offered again', async () => {
  armed();
  await buy('LIFE');
  await broker.closePosition('LIFE', DAY);
  expect(broker.openSymbols(DAY)).toEqual([]);
});

/* A scale-out is several orders in one symbol and one position to close. */
test('a scale-out counts once', async () => {
  armed();
  await buy('LIFE', { quantity: 40, target: 31.79, plan: {
    runner: 0.5, legs: [{ fraction: 0.5, price: 31.79 }] } });
  expect(broker.openSymbols(DAY)).toEqual(['LIFE']);
});

test("yesterday's positions are not today's problem", async () => {
  armed();
  await buy('LIFE', { date: '2026-08-07' });
  expect(broker.openSymbols(DAY)).toEqual([]);
});

// ── closing ───────────────────────────────────────────────────────────────

test('close takes no quantity — the whole position goes', async () => {
  armed();
  await broker.closePosition('LIFE', DAY);
  expect(sent[0]).toEqual({ symbol: 'LIFE', action: 'close' });
});

test('nothing is closed when the box was never armed', async () => {
  broker.save({ webhookUrl: HOOK, buyingPower: 100, enabled: true });
  const out = await broker.closePosition('LIFE', DAY);
  expect(out.sent).toBe(false);
  expect(global.fetch).not.toHaveBeenCalled();
});

// ── the clock ─────────────────────────────────────────────────────────────

/** 15:50 ET on Monday 2026-08-10 (EDT, UTC−4). */
const AT_1550 = Date.UTC(2026, 7, 10, 19, 50);
const AT_1500 = Date.UTC(2026, 7, 10, 19, 0);
const SATURDAY = Date.UTC(2026, 7, 8, 19, 50);

test('it closes everything at the configured minute', async () => {
  armed();
  await buy('LIFE'); await buy('LSCC');
  sent = [];

  const out = await flattener.check(AT_1550);
  expect(out.closed.sort()).toEqual(['LIFE', 'LSCC']);
  expect(sent).toEqual([
    { symbol: 'LIFE', action: 'close' }, { symbol: 'LSCC', action: 'close' },
  ]);
  expect(broker.openSymbols(DAY)).toEqual([]);
});

test('it does nothing at any other minute', async () => {
  armed();
  await buy('LIFE');
  sent = [];
  expect((await flattener.check(AT_1500)).ran).toBe(false);
  expect(sent).toEqual([]);
});

test('it does not run at the weekend', async () => {
  armed();
  await buy('LIFE');
  sent = [];
  expect((await flattener.check(SATURDAY)).ran).toBe(false);
});

/* A minute tick can fire twice inside the same minute. Closing twice is not
 * harmful at the broker, but it is two alerts and two ledger lines saying
 * different things about one event. */
test('it runs once a session', async () => {
  armed();
  await buy('LIFE');
  await flattener.check(AT_1550);
  sent = [];
  expect((await flattener.check(AT_1550)).ran).toBe(false);
  expect(sent).toEqual([]);
});

test('it can be switched off, and then nothing closes', async () => {
  armed({ flatten: false });
  await buy('LIFE');
  sent = [];
  expect((await flattener.check(AT_1550)).ran).toBe(false);
});

test('the time is configurable and must look like a time', () => {
  armed();
  broker.save({ flattenAt: '15:45' });
  expect(broker.settings().flattenAt).toBe('15:45');
  expect(() => broker.save({ flattenAt: 'soon' })).toThrow(/15:50/);
});

// ── saying so ─────────────────────────────────────────────────────────────

test('a clean close is reported, not silent', async () => {
  armed();
  await buy('LIFE');
  await flattener.check(AT_1550);
  const f = store.recentFires(DAY).find(x => x.rule === 'End of session');
  expect(f.level).toBe('info');
  expect(f.detail).toMatch(/Closed at 15:50: LIFE/);
});

/*
 * The one that matters. A position that could not be closed is ten minutes from
 * being an overnight hold, and from a phone that must not look like the clean
 * case or like nothing having happened.
 */
test('a close that fails is an error alert naming the symbol', async () => {
  armed();
  await buy('LIFE');
  global.fetch = jest.fn(async () => ({
    ok: false, status: 400,
    text: async () => '{"status":"ExecutionError","message":"TradeThePool: no position"}',
  }));
  const out = await flattener.check(AT_1550);
  expect(out.failed).toHaveLength(1);

  const f = store.recentFires(DAY).find(x => x.rule === 'End of session');
  expect(f.level).toBe('error');
  expect(f.detail).toMatch(/COULD NOT CLOSE LIFE/);
  expect(f.detail).toMatch(/before the bell/);
});

test('a quiet day closes nothing and says nothing', async () => {
  armed();
  const out = await flattener.check(AT_1550);
  expect(out.closed).toEqual([]);
  expect(store.recentFires(DAY)).toHaveLength(0);
});

// ── the hole that let two positions sit in the account ─────────────────────
/*
 * WHAT WAS FOUND BY OPENING THE BROKER'S APP: two names still open that should
 * have been flat days earlier.
 *
 * This function read openSymbols(TODAY), and the ledger is keyed by day. A
 * position not closed on the day it was opened — this process down at 15:50,
 * the desk disarmed, a close refused — is invisible to every flatten that
 * follows: the next day asks about a new date, finds nothing, closes nothing.
 * Not missed once. Missed for good.
 *
 * So it now also asks Alpaca what is actually held, and closes what THIS DESK
 * opened on an earlier day. What it did not open, it names and leaves.
 */
describe('a position carried in from an earlier session', () => {
  const carried = (symbol = 'VIK', over = {}) => ({
    ok: true, running: [], foreign: [],
    carried: [{ symbol, qty: 100, side: 'long', openedOn: '2026-08-07',
                setupId: 'S@09:35', destinations: ['alp'], ...over }],
  });

  test('is closed, even though today\'s ledger is empty', async () => {
    armed();
    reconcile.carriedOver.mockResolvedValue(carried());
    const out = await flattener.check(AT_1550);
    expect(out.ran).toBe(true);
    expect(sent.map(b => b.symbol)).toEqual(['VIK']);
    expect(sent[0].action).toBe('close');
  });

  test('and the alert says it came from an earlier day', async () => {
    armed();
    reconcile.carriedOver.mockResolvedValue(carried());
    await flattener.check(AT_1550);
    const said = store.recentFires(DAY).find(f => f.rule === 'End of session');
    expect(said.detail).toMatch(/EARLIER session/);
    expect(said.detail).toMatch(/VIK/);
  });

  test('one already in today\'s ledger is not closed twice', async () => {
    armed();
    await buy('LIFE');
    reconcile.carriedOver.mockResolvedValue({
      ok: true, running: [], foreign: [],
      carried: [{ symbol: 'LIFE', qty: 10, openedOn: DAY, destinations: ['alp'] }],
    });
    sent.length = 0;
    await flattener.check(AT_1550);
    expect(sent.filter(b => b.symbol === 'LIFE' && b.action === 'close')).toHaveLength(1);
  });

  /*
   * A POSITION THIS DESK NEVER OPENED IS NOT THIS DESK'S TO CLOSE. It may be a
   * trade taken by hand. Named at error level, and left exactly where it is.
   */
  test('one nothing here opened is named and NOT closed', async () => {
    armed();
    reconcile.carriedOver.mockResolvedValue({
      ok: true, running: [], carried: [],
      foreign: [{ symbol: 'NVDA', qty: 50, why: 'nothing in this ledger ever opened it' }],
    });
    const out = await flattener.check(AT_1550);
    expect(out.ran).toBe(true);
    expect(sent).toHaveLength(0);
    const said = store.recentFires(DAY).find(f => f.rule === 'End of session');
    expect(said.level).toBe('error');
    expect(said.detail).toMatch(/ALPACA STILL HOLDS NVDA \(50\)/);
    expect(said.detail).toMatch(/NOT closed/);
  });

  /*
   * An unreachable broker must not read as a clean account. Today's ledger is
   * still closed — that half never depended on Alpaca — and the alert says the
   * other half could not be checked.
   */
  test('an unreachable Alpaca still closes today, and says what it could not check', async () => {
    armed();
    await buy('LIFE');
    reconcile.carriedOver.mockResolvedValue({ ok: false, error: 'timed out' });
    sent.length = 0;
    await flattener.check(AT_1550);
    expect(sent.map(b => b.symbol)).toEqual(['LIFE']);
    const said = store.recentFires(DAY).find(f => f.rule === 'End of session');
    expect(said.detail).toMatch(/could not ask Alpaca what is really open \(timed out\)/);
  });

  test('nothing anywhere is still nothing to do', async () => {
    armed();
    reconcile.carriedOver.mockResolvedValue({ ok: true, carried: [], foreign: [], running: [] });
    const out = await flattener.check(AT_1550);
    expect(out.closed).toEqual([]);
    expect(sent).toHaveLength(0);
  });
});

/*
 * ── THE FLATTEN MUST REACH EVERY ACCOUNT ──────────────────────────────────
 *
 * Everything above configures the desk-wide `webhookUrl` — the single-hook
 * shape this began as. That is why none of it caught the failure below, and
 * why these tests configure the shape the desk ACTUALLY runs: named
 * destinations, each with its own hook, and no desk-wide hook at all.
 *
 * TWO FAULTS, ONE ROOT. `flattenAll` closed every symbol through one `cfg`
 * defaulting to `settings()`, and the ledger's record of WHICH ACCOUNT holds
 * each name was thrown away by `openSymbols`.
 *
 *   nothing was sent at all. settings().webhookUrl is null once orders go to
 *   named destinations, so every close hit the "no webhook" guard and was
 *   recorded as "not armed" — while the desk was armed. The 15:50 flatten did
 *   nothing, on every account, every day.
 *
 *   and with a hook set it was still wrong: one cfg for every symbol means a
 *   name held in two accounts is closed in one.
 *
 * What that costs is not abstract. The half of an OR + VWAP position that
 * rides the stop has no target by design — the backtest closes it at the
 * session end and the broker does not — so it is held overnight, in an account
 * that is not allowed to hold one. carriedOver() finds it the NEXT morning by
 * asking Alpaca, which is a safety net, not a plan.
 */
describe('with named accounts and no desk-wide hook', () => {
  const HOOK_A = 'https://app.signalstack.com/hook/FAKEhook0000000000000a';
  const HOOK_B = 'https://app.signalstack.com/hook/FAKEhook0000000000000b';

  /** Two accounts, both running the same setup — the desk as it is configured. */
  function twoAccounts() {
    broker.save({
      enabled: true,
      destinations: [
        { id: 'pa', name: 'Paper A', dialect: 'alpaca', webhookUrl: HOOK_A,
          buyingPower: 100000, ratio: 1, mode: 'auto', setups: ['s1'] },
        { id: 'pb', name: 'Paper B', dialect: 'alpaca', webhookUrl: HOOK_B,
          buyingPower: 100000, ratio: 1, mode: 'auto', setups: ['s1'] },
      ],
    });
    broker.save({ armed: true });
  }

  /** One signal, taken in both accounts — which is what two accounts means. */
  async function buyBoth(symbol) {
    for (const id of ['pa', 'pb']) {
      await broker.placeOrder({
        symbol, signal: 'LONG', quantity: 10, price: 29.05, stop: 27.68,
        date: DAY, setupId: 's1', cfg: broker.destinationCfg(id),
      });
    }
  }

  test('the desk-wide hook really is null here — this is the live shape', () => {
    twoAccounts();
    expect(broker.settings().webhookUrl).toBeNull();
    expect(broker.settings().armed).toBe(true);
  });

  /*
   * THE LEDGER ROW ITSELF, not the return value.
   *
   * Everything downstream reads the ledger, not what closePosition handed
   * back: openByDestination, the manager's openPositions, and — the one that
   * matters most — reconcile.believedFor, which filters flatten rows by
   * account to build `closedHere`. Flatten rows carried no destination, so for
   * a named account that set was ALWAYS EMPTY, and the finding it feeds —
   * "closed here and still on, the close did not take" — could never fire.
   * The reconciliation test for it passed because its fixture typed in a
   * destination that production never wrote.
   */
  test('the close is recorded against the account it went to', async () => {
    twoAccounts();
    await buyBoth('WULF');
    await broker.closePosition('WULF', DAY, broker.destinationCfg('pa'));
    const row = broker.orders(DAY).filter(o => o.kind === 'flatten').pop();
    expect(row.destination).toBe('pa');
    expect(row.broker).toBe('Paper A');
  });

  /* ...and a refusal is recorded against it too, because "which account failed
     to close" is the whole content of that message at 15:50. */
  test('a refused close names the account as well', async () => {
    twoAccounts();
    broker.save({ armed: false });
    await broker.closePosition('WULF', DAY, broker.destinationCfg('pb'));
    const row = broker.orders(DAY).filter(o => o.kind === 'flatten').pop();
    expect(row.destination).toBe('pb');
    expect(row.sent).toBe(false);
  });

  test('the ledger knows which accounts hold the name', async () => {
    twoAccounts();
    await buyBoth('WULF');
    expect(broker.openByDestination(DAY)).toEqual({ WULF: ['pa', 'pb'] });
  });

  /* THE BUG. One position, two accounts, and the close went nowhere. */
  test('a close is sent to BOTH accounts, on their own hooks', async () => {
    twoAccounts();
    await buyBoth('WULF');
    sent.length = 0;
    const urls = [];
    global.fetch = jest.fn(async (url, opts) => {
      urls.push(url); sent.push(JSON.parse(opts.body)); return ok();
    });

    const out = await broker.flattenAll(DAY);

    expect(out).toHaveLength(2);
    expect(out.every(r => r.sent)).toBe(true);
    expect(out.map(r => r.destination).sort()).toEqual(['pa', 'pb']);
    // Each on its OWN hook. One hook twice would close one account twice and
    // leave the other holding the position.
    expect(urls.sort()).toEqual([HOOK_A, HOOK_B]);
    expect(sent).toEqual([{ symbol: 'WULF', action: 'close' },
                          { symbol: 'WULF', action: 'close' }]);
  });

  /*
   * Closing one account does not close the other. The old `closed` set was
   * keyed by SYMBOL, so one successful flatten anywhere hid the name from
   * every flatten that followed — including the next day's.
   */
  test('closing one account leaves the other still open', async () => {
    twoAccounts();
    await buyBoth('WULF');
    await broker.closePosition('WULF', DAY, broker.destinationCfg('pa'));

    expect(broker.openByDestination(DAY)).toEqual({ WULF: ['pb'] });
    // ...and the name is still open, because it IS still open somewhere.
    expect(broker.openSymbols(DAY)).toEqual(['WULF']);

    sent.length = 0;
    const out = await broker.flattenAll(DAY);
    expect(out.map(r => r.destination)).toEqual(['pb']);
  });

  test('and once both are closed, nothing is left', async () => {
    twoAccounts();
    await buyBoth('WULF');
    for (const id of ['pa', 'pb']) {
      await broker.closePosition('WULF', DAY, broker.destinationCfg(id));
    }
    expect(broker.openByDestination(DAY)).toEqual({});
    expect(broker.openSymbols(DAY)).toEqual([]);
  });

  /*
   * THE TWO REASONS NOTHING WAS SENT ARE NOT THE SAME REASON. "not armed"
   * pointed at a switch that was already on, at 15:50, with ten minutes left.
   */
  test('no webhook is reported as no webhook, not as "not armed"', async () => {
    twoAccounts();
    // settings() is the DESK, and the desk has no hook of its own once orders
    // go to named accounts. This is exactly the cfg flattenAll used to default
    // to, so this is the old failure reproduced rather than a contrived one.
    expect(broker.settings().webhookUrl).toBeNull();
    const out = await broker.closePosition('WULF', DAY, broker.settings());
    expect(out.sent).toBe(false);
    expect(out.skipped).not.toMatch(/not armed/);
    expect(out.skipped).toMatch(/no webhook|STILL OPEN/);
    // ...and it says the position may still be there, which is the fact that
    // matters at the cutoff.
    expect(out.error).toMatch(/may still be open/i);
  });

  test('a genuinely disarmed desk still says "not armed"', async () => {
    twoAccounts();
    broker.save({ armed: false });
    const out = await broker.closePosition('WULF', DAY, broker.destinationCfg('pa'));
    expect(out.skipped).toBe('not armed');
  });

  /*
   * A row from before destinations existed carries no `destination`. It comes
   * back under `null` and is closed through the fallback cfg, so an old ledger
   * behaves exactly as it always did.
   */
  /*
   * Every close already in the ledger was written before flatten rows carried
   * an account. Read as closing only the `null` account they would leave every
   * position ever closed reading as open again, and the next flatten would
   * re-send a close for each — safe at the broker, which no-ops a close on a
   * flat symbol, but a page of alerts about positions shut days ago.
   */
  test('a close from before accounts existed still closes the position', async () => {
    twoAccounts();
    await buyBoth('WULF');
    fs.appendFileSync(process.env.BROKER_LEDGER, `${JSON.stringify({
      at: Date.now(), date: DAY, symbol: 'WULF', kind: 'flatten',
      action: 'close', sent: true,          // the old shape: no destination
    })}\n`);
    expect(broker.openByDestination(DAY)).toEqual({});
  });

  test('a position from before destinations existed is still closed', async () => {
    twoAccounts();
    fs.appendFileSync(process.env.BROKER_LEDGER, `${JSON.stringify({
      at: Date.now(), date: DAY, symbol: 'OLDX', signal: 'LONG', action: 'buy',
      quantity: 10, sent: true, setupId: 's1',
    })}\n`);
    expect(broker.openByDestination(DAY).OLDX).toEqual([null]);
    sent.length = 0;
    const out = await broker.flattenAll(DAY, broker.destinationCfg('pa'));
    expect(out.find(r => r.symbol === 'OLDX').sent).toBe(true);
  });
});
