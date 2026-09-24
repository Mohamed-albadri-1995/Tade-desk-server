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
  /*
   * The AFTER picture, which is a different question from carriedOver's
   * before. Flat by default, because that is the normal end of a normal day —
   * a default of "still held" would make every test below assert on an error
   * path none of them are about.
   */
  heldNow: jest.fn(async () => ({ ok: true, verifiable: true, positions: [] })),
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
  reconcile.heldNow.mockReset();
  reconcile.heldNow.mockResolvedValue({ ok: true, verifiable: true, positions: [] });
});
afterAll(() => { fs.rmSync(DIR, { recursive: true, force: true }); });

/*
 * THE CLOCK IS THE ONLY THING STUBBED.
 *
 * The flatten waits four, six and ten seconds before deciding a close did not
 * land, stopping at the first look that comes back flat — which is right on a
 * desk and is twenty seconds per test here. `sleep` is replaced and the three
 * ATTEMPTS are kept, so what is exercised is the real polling, not a shortcut
 * past it.
 */
const check = (at, over = {}) => flattener.check(at,
  { verify: { sleep: async () => {}, ...over } });

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

  const out = await check(AT_1550);
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
  expect((await check(AT_1500)).ran).toBe(false);
  expect(sent).toEqual([]);
});

test('it does not run at the weekend', async () => {
  armed();
  await buy('LIFE');
  sent = [];
  expect((await check(SATURDAY)).ran).toBe(false);
});

/* A minute tick can fire twice inside the same minute. Closing twice is not
 * harmful at the broker, but it is two alerts and two ledger lines saying
 * different things about one event. */
test('it runs once a session', async () => {
  armed();
  await buy('LIFE');
  await check(AT_1550);
  sent = [];
  expect((await check(AT_1550)).ran).toBe(false);
  expect(sent).toEqual([]);
});

test('it can be switched off, and then nothing closes', async () => {
  armed({ flatten: false });
  await buy('LIFE');
  sent = [];
  expect((await check(AT_1550)).ran).toBe(false);
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
  await check(AT_1550);
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
  const out = await check(AT_1550);
  expect(out.failed).toHaveLength(1);

  const f = store.recentFires(DAY).find(x => x.rule === 'End of session');
  expect(f.level).toBe('error');
  expect(f.detail).toMatch(/COULD NOT CLOSE LIFE/);
  expect(f.detail).toMatch(/before the bell/);
});

/*
 * A QUIET DAY CLOSES NOTHING AND SAYS SO.
 *
 * This used to assert SILENCE — `recentFires(DAY)` empty — which is what the
 * code did, and it was wrong in a way only a real day showed.
 *
 * 2026-09-22: the manager closed all five positions during the session, 15:50
 * arrived with nothing to do, the early return fired, and the record for that
 * day contains no End of session line at all. From a phone that is
 * indistinguishable from the flatten never having run — on the one process
 * standing between this desk and an overnight position in an account that may
 * not hold one. Which is the failure of 2026-09-21, one step further back.
 *
 * "Nothing was open" is a RESULT. It is the result on most days, and a result
 * only reported when it is interesting is a result nobody can rely on. The
 * flattener's own comment already said so, four lines below the early return:
 * "from a phone the two must not look the same as each other OR AS SILENCE."
 */
test('a quiet day closes nothing and says so', async () => {
  armed();
  const out = await check(AT_1550);
  expect(out.closed).toEqual([]);

  const f = store.recentFires(DAY).find(x => x.rule === 'End of session');
  expect({ published: !!f }).toEqual({ published: true });
  // INFO: nothing went wrong. It is a receipt, not an alarm.
  expect(f.level).toBe('info');
  expect(f.detail).toMatch(/nothing was open/);
  // And it must not claim a broker confirmation it never asked for.
  expect(f.detail).not.toMatch(/confirms it is flat/);
  expect(f.detail).not.toMatch(/could not confirm/);
});

test('and it sends nothing while saying it', async () => {
  // The receipt costs one line to read. It must not cost an order.
  armed();
  sent.length = 0;
  await check(AT_1550);
  expect(sent).toEqual([]);
});

test('a quiet day does not spend twenty seconds asking Alpaca', async () => {
  /*
   * stillHeld([]) returns immediately — there is nothing to verify when
   * nothing was closed. Otherwise the commonest day of all would pay the full
   * verification budget for an answer that cannot be anything but empty.
   */
  armed();
  await check(AT_1550);
  expect(reconcile.heldNow).not.toHaveBeenCalled();
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
 * So it asks Alpaca what is actually held. Since 2026-09-24 it REPORTS what
 * this desk opened on an earlier day and does not close it: Trade The Pool can
 * never be asked, and the Alpaca account behaves as the TTP evaluation will —
 * the orders sent depend on the desk's own records only.
 */
describe('a position carried in from an earlier session', () => {
  const carried = (symbol = 'VIK', over = {}) => ({
    ok: true, running: [], foreign: [],
    carried: [{ symbol, qty: 100, side: 'long', openedOn: '2026-08-07',
                setupId: 'S@09:35', destinations: ['alp'], ...over }],
  });

  test('is NOT closed — the desk sends only what its own records say', async () => {
    armed();
    reconcile.carriedOver.mockResolvedValue(carried());
    const out = await check(AT_1550);
    expect(out.ran).toBe(true);
    expect(sent.filter(b => b.symbol === 'VIK')).toHaveLength(0);
  });

  test('and the alert says, at error level, to close it by hand', async () => {
    armed();
    reconcile.carriedOver.mockResolvedValue(carried());
    await check(AT_1550);
    const said = store.recentFires(DAY).find(f => f.rule === 'End of session');
    expect(said.level).toBe('error');
    expect(said.detail).toMatch(/VIK IS STILL OPEN at Alpaca from an EARLIER session/);
    expect(said.detail).toMatch(/CLOSE IT YOURSELF/);
  });

  test('one already in today\'s ledger is not closed twice', async () => {
    armed();
    await buy('LIFE');
    reconcile.carriedOver.mockResolvedValue({
      ok: true, running: [], foreign: [],
      carried: [{ symbol: 'LIFE', qty: 10, openedOn: DAY, destinations: ['alp'] }],
    });
    sent.length = 0;
    await check(AT_1550);
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
    const out = await check(AT_1550);
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
    await check(AT_1550);
    expect(sent.map(b => b.symbol)).toEqual(['LIFE']);
    const said = store.recentFires(DAY).find(f => f.rule === 'End of session');
    expect(said.detail).toMatch(/could not ask Alpaca what is really open \(timed out\)/);
  });

  test('nothing anywhere is still nothing to do', async () => {
    armed();
    reconcile.carriedOver.mockResolvedValue({ ok: true, carried: [], foreign: [], running: [] });
    const out = await check(AT_1550);
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

/*
 * ══ AND THEN IT ASKS WHETHER IT WORKED ════════════════════════════════════
 *
 * 2026-09-21, 15:57 ET, found by opening the broker's app: 1,045 shares of U
 * still on, seven minutes after the flatten ran. The desk's own alert, sent at
 * 15:50:04, read "Closed at 15:50: U" at level INFO — the level that means
 * nothing failed.
 *
 * It could not have known. `sent` is SignalStack's answer to the webhook,
 * taken in the same second it was posted. What the BROKER does with it happens
 * afterwards. SignalStack accepted this close and then emailed:
 *
 *     Request:  {"symbol":"U","action":"close"}
 *     Response: From Alpaca: insufficient qty available for order
 *               (requested: 1045, available: 0)
 *
 * available: 0 with 1,045 held is the position's own protective stop holding
 * every share. None of that reaches this process — the only place it appeared
 * was an inbox.
 *
 * So the flatten asks Alpaca again after it sends. The line it has to get
 * right is the difference between three answers that were all one answer
 * before:
 *
 *     Alpaca says flat            the close worked
 *     Alpaca says still held      IT DID NOT — act, now
 *     Alpaca did not answer       nobody knows, and that is not "flat"
 */
describe('the close is confirmed, not assumed', () => {
  const held = (over = {}) => ({
    ok: true, verifiable: true,
    positions: [{ symbol: 'LIFE', qty: 1045, side: 'long', account: 'alp', ...over }],
  });

  test('still held after the close is an ERROR, by name and share count', async () => {
    armed();
    await buy('LIFE');
    reconcile.heldNow.mockResolvedValue(held());
    const out = await check(AT_1550);

    const said = store.recentFires(DAY).find(f => f.rule === 'End of session');
    expect(said.level).toBe('error');
    expect(said.detail).toMatch(/STILL HELD AFTER THE CLOSE/);
    expect(said.detail).toContain('LIFE 1045 sh');
    expect(said.detail).toContain('alp');
    // The position count is what you act on, so it is in the alert and not
    // only in a log line on a box you are not looking at.
    expect(out.stillHeld.map(p => p.symbol)).toEqual(['LIFE']);
  });

  test('and the alert does NOT lead with "closed"', async () => {
    /*
     * "Closed at 15:50: LIFE" with "still held" further down the same
     * paragraph reads as a success on a phone, which is where it is read.
     */
    armed();
    await buy('LIFE');
    reconcile.heldNow.mockResolvedValue(held());
    await check(AT_1550);
    const said = store.recentFires(DAY).find(f => f.rule === 'End of session');
    expect(said.detail.startsWith('STILL HELD')).toBe(true);
    expect(said.detail).not.toMatch(/^Closed at/);
  });

  test('it names the cause it has actually seen', async () => {
    // Not a guess: Alpaca's own words were "insufficient qty available for
    // order (requested: 1045, available: 0)" while 1,045 were held, which is
    // the stop order reserving them. The instruction is cancel, then close.
    armed();
    await buy('LIFE');
    reconcile.heldNow.mockResolvedValue(held());
    await check(AT_1550);
    const said = store.recentFires(DAY).find(f => f.rule === 'End of session');
    expect(said.detail).toMatch(/cancel the working order first/i);
  });

  test('a clean close says Alpaca confirmed it, and stays INFO', async () => {
    armed();
    await buy('LIFE');
    const out = await check(AT_1550);
    const said = store.recentFires(DAY).find(f => f.rule === 'End of session');
    expect(said.level).toBe('info');
    expect(said.detail).toMatch(/Alpaca confirms it is flat/);
    expect(out.verified).toBe(true);
    expect(out.stillHeld).toEqual([]);
  });

  test('it stops looking as soon as the position is gone', async () => {
    // A market order at 15:50 fills in seconds, and three round trips on every
    // clean day is three requests for nothing.
    armed();
    await buy('LIFE');
    await check(AT_1550);
    expect(reconcile.heldNow).toHaveBeenCalledTimes(1);
  });

  test('a slow fill is not an alert — it looks again', async () => {
    /*
     * An alert that cries wolf on every slow fill is one that stops being
     * read, which is the same outcome as not having it at all. Held on the
     * first look, flat on the second.
     */
    armed();
    await buy('LIFE');
    reconcile.heldNow
      .mockResolvedValueOnce(held())
      .mockResolvedValue({ ok: true, verifiable: true, positions: [] });
    const out = await check(AT_1550);
    expect(reconcile.heldNow).toHaveBeenCalledTimes(2);
    expect(out.stillHeld).toEqual([]);
    expect(store.recentFires(DAY).find(f => f.rule === 'End of session').level)
      .toBe('info');
  });

  test('it gives up after the third look, not the first', async () => {
    armed();
    await buy('LIFE');
    reconcile.heldNow.mockResolvedValue(held());
    await check(AT_1550);
    expect(reconcile.heldNow).toHaveBeenCalledTimes(3);
  });

  test('a cached answer from BEFORE the close would be the old picture', async () => {
    // heldNow caches for eight seconds and the flatten already called it
    // (through carriedOver) moments earlier. A cached read here confirms the
    // state the close was meant to change.
    armed();
    await buy('LIFE');
    await check(AT_1550);
    expect(reconcile.heldNow).toHaveBeenCalledWith({ maxAgeMs: 0 });
  });

  test('a broker that did not answer is NOT "it is flat"', async () => {
    /*
     * AN ERROR IS NEVER A ZERO, and on this alert the zero is an overnight
     * position. "Alpaca says you hold nothing" and "Alpaca did not say" are
     * opposite facts.
     */
    armed();
    await buy('LIFE');
    reconcile.heldNow.mockResolvedValue({ ok: false, error: '401 unauthorized' });
    const out = await check(AT_1550);
    const said = store.recentFires(DAY).find(f => f.rule === 'End of session');
    expect(out.verified).toBe(false);
    expect(said.detail).toMatch(/could not confirm the close landed/);
    expect(said.detail).toContain('401 unauthorized');
    expect(said.detail).not.toMatch(/confirms it is flat/);
  });

  test('a throw on the way to Alpaca is the same kind of unknown', async () => {
    armed();
    await buy('LIFE');
    reconcile.heldNow.mockRejectedValue(new Error('socket hang up'));
    const out = await check(AT_1550);
    expect(out.verified).toBe(false);
    expect(store.recentFires(DAY).find(f => f.rule === 'End of session').detail)
      .toContain('socket hang up');
  });

  test('a desk with no Alpaca account says so, once, and is not an error', async () => {
    // TTP5k is behind TraderEvolution with no position feed. That is a fact
    // about the desk, not a failure of tonight's close.
    armed();
    await buy('LIFE');
    reconcile.heldNow.mockResolvedValue({
      ok: true, verifiable: false, reason: 'no Alpaca account configured',
      positions: null });
    const out = await check(AT_1550);
    const said = store.recentFires(DAY).find(f => f.rule === 'End of session');
    expect(out.verified).toBe(false);
    expect(said.level).toBe('info');
    expect(said.detail).toContain('no Alpaca account configured');
  });

  test('a day with nothing to close does not ask at all', async () => {
    // No position, no close, no question — and no twenty seconds spent on it.
    armed();
    const out = await check(AT_1550);
    expect(out.closed).toEqual([]);
    expect(reconcile.heldNow).not.toHaveBeenCalled();
  });

  test('it only reports names this flatten actually closed', async () => {
    /*
     * The account may hold something else entirely — a trade taken by hand.
     * Reporting it here as "still held after the close" would blame this
     * flatten for a position it never touched, and `foreign` is the line that
     * already says the true thing about it.
     */
    armed();
    await buy('LIFE');
    reconcile.heldNow.mockResolvedValue(held({ symbol: 'NVDA' }));
    const out = await check(AT_1550);
    expect(out.stillHeld).toEqual([]);
    expect(store.recentFires(DAY).find(f => f.rule === 'End of session').level)
      .toBe('info');
  });

  test('a zero-quantity row is not a held position', async () => {
    armed();
    await buy('LIFE');
    reconcile.heldNow.mockResolvedValue(held({ qty: 0 }));
    const out = await check(AT_1550);
    expect(out.stillHeld).toEqual([]);
  });

  test('a short that did not close is still held, and the size reads positive', async () => {
    // A short is a negative quantity. "-1045 sh" in an alert is a share count
    // that reads as a direction, on the line that says how much trouble you
    // are in.
    armed();
    await buy('LIFE');
    reconcile.heldNow.mockResolvedValue(held({ qty: -1045, side: 'short' }));
    await check(AT_1550);
    const said = store.recentFires(DAY).find(f => f.rule === 'End of session');
    expect(said.detail).toContain('LIFE 1045 sh');
    expect(said.detail).not.toContain('-1045');
  });
});

/*
 * A CLOSE THAT WAS SENT AND DID NOT TAKE IS THIS DESK'S TO FINISH.
 *
 * carriedOver() used to return those inside `foreign` — the bucket the flatten
 * reports and never touches, under a sentence reading "nothing here opened
 * it". Both halves were wrong about U on 2026-09-21: this desk opened it, and
 * closing it is the most obviously correct thing to do with it.
 */
describe('a close that did not take', () => {
  const notClosed = (symbol = 'VIK') => ({
    ok: true, carried: [], foreign: [], running: [],
    notClosed: [{ symbol, qty: 1045, side: 'long', openedOn: '2026-08-07',
                  closedOn: '2026-08-07', destinations: ['alp'],
                  why: 'this desk closed it and it is still on — the close did not take' }],
  });

  test('is not sent again — reported, to close by hand', async () => {
    armed();
    reconcile.carriedOver.mockResolvedValue(notClosed());
    await check(AT_1550);
    expect(sent.filter(b => b.symbol === 'VIK' && b.action === 'close')).toHaveLength(0);
  });

  test('and is not described as somebody else\'s trade', async () => {
    armed();
    reconcile.carriedOver.mockResolvedValue(notClosed());
    await check(AT_1550);
    const said = store.recentFires(DAY).find(f => f.rule === 'End of session');
    expect(said.detail).not.toMatch(/nothing here opened it/);
    expect(said.detail).toMatch(/the close did not take/);
    expect(said.detail).toMatch(/cancel its stop order first/);
    expect(said.detail).toContain('VIK');
  });

  test('a carried-over position keeps its own, different sentence', async () => {
    // "Left open from an earlier session" points at the 15:50 that did not
    // run. "A close was sent and it is still on" points at the broker. One
    // sentence covering both sends you to the wrong place.
    armed();
    reconcile.carriedOver.mockResolvedValue({
      ok: true, foreign: [], running: [], notClosed: [],
      carried: [{ symbol: 'VIK', qty: 100, openedOn: '2026-08-07',
                  destinations: ['alp'] }],
    });
    await check(AT_1550);
    const said = store.recentFires(DAY).find(f => f.rule === 'End of session');
    expect(said.detail).toMatch(/EARLIER session/);
    expect(said.detail).not.toMatch(/did not take/);
  });

  test('one already in today\'s ledger is not closed twice in one run', async () => {
    // flattenAll already covers today's ledger. A second close on the same
    // symbol in the same run is two sells of one position.
    armed();
    await buy('LIFE');
    reconcile.carriedOver.mockResolvedValue(notClosed('LIFE'));
    sent.length = 0;
    await check(AT_1550);
    expect(sent.filter(b => b.symbol === 'LIFE' && b.action === 'close')).toHaveLength(1);
  });
});
