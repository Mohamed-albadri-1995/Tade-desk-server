/*
 * The intent, written before anything goes on the wire — and the half-placed
 * scale-out, which is not a success with a footnote.
 *
 * ── THE GAP THE INTENT ROW CLOSES ─────────────────────────────────────────
 *
 * The ledger row was written AFTER the whole call finished. Between the first
 * POST and that write there is a window in which an order exists at the broker
 * and NOTHING on this side records that it was ever attempted. A crash there —
 * a restart, a reboot, an OOM at 09:35 with nine tools scanning — and the
 * position is real and invisible: no row for the 15:50 flatten to close, no
 * position for the manager to watch.
 *
 * And it is worse than a lost record, because the ledger is also what the
 * repeat guard reads. `sentAlready` asks the ledger whether this setup has
 * already taken this name; after a crash mid-send the answer is "no", and the
 * next pass takes the name again. One crash, two positions.
 *
 * So: an intent goes down first, the outcome goes down after, both under one
 * id. An intent with no outcome is a call that started and never finished, and
 * it is the loudest thing this desk can say.
 *
 * The row is INERT to everything that counts — it carries no `sent`, so every
 * tally skips it exactly as it skips a refusal.
 *
 * ── AND THE PARTIAL ───────────────────────────────────────────────────────
 *
 * A half-placed scale-out was already on the trade line — "PARTIAL: only 1 of 3
 * legs went in" — appended to a message whose level is `trade`. It arrived
 * green, beside every healthy fill of the morning, reading as a success with a
 * footnote. It is not one: the position that exists is a different SHAPE from
 * the one that was tested, and which leg is missing decides whether what is
 * left is the runner or the target.
 */

const os = require('os');
const path = require('path');
const fs = require('fs');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'intent-'));
process.env.BROKER_FILE = path.join(DIR, 'broker.json');
process.env.BROKER_LEDGER = path.join(DIR, 'orders.jsonl');

const broker = require('../src/broker/signalstack');

const HOOK = 'https://app.signalstack.com/hook/FAKEhook0000000000000a';
const DAY = '2026-08-18';

let replies;          // one per POST, in order
let posted;

beforeEach(() => {
  fs.rmSync(process.env.BROKER_LEDGER, { force: true });
  fs.rmSync(process.env.BROKER_FILE, { force: true });
  broker.save({ webhookUrl: HOOK, enabled: true, buyingPower: 100000,
                allowShort: true, bracket: true });
  broker.save({ armed: true });
  posted = [];
  replies = [];
  global.fetch = jest.fn(async (url, opts) => {
    posted.push(JSON.parse(opts.body));
    const r = replies.shift() || { ok: true, status: 'filled', id: `ID${posted.length}` };
    return {
      ok: r.ok !== false,
      status: r.ok === false ? 402 : 201,
      text: async () => JSON.stringify(r.ok === false
        ? { message: r.message || 'refused' }
        : { status: r.status, id: r.id, price: r.price }),
    };
  });
});

const place = (over = {}) => broker.placeOrder({
  symbol: 'EYPT', signal: 'LONG', quantity: 100, price: 5.42, stop: 5.20,
  target: 5.90, date: DAY, setupId: 'or-vwap-0935', ...over,
});

const rowsOf = () => fs.readFileSync(process.env.BROKER_LEDGER, 'utf8')
  .trim().split('\n').filter(Boolean).map(JSON.parse);
const intents = () => rowsOf().filter(o => o.kind === 'intent');
const outcomes = () => rowsOf().filter(o => o.kind !== 'intent');

// ── it goes down first ─────────────────────────────────────────────────────

describe('the intent', () => {
  test('is written, once, for a call that sends', async () => {
    await place();
    expect(intents()).toHaveLength(1);
    expect(outcomes()).toHaveLength(1);
  });

  /*
   * BEFORE THE WIRE, which is the entire point. Written after the first POST it
   * would close no window at all.
   */
  test('is on disk before the first POST leaves', async () => {
    let atFirstPost = null;
    const real = global.fetch;
    global.fetch = jest.fn(async (...a) => {
      if (atFirstPost === null) atFirstPost = rowsOf();
      return real(...a);
    });
    await place();
    expect(atFirstPost.filter(o => o.kind === 'intent')).toHaveLength(1);
  });

  test('it and its outcome share one id', async () => {
    await place();
    expect(intents()[0].intentId).toBe(outcomes()[0].intentId);
    expect(intents()[0].intentId).toBeTruthy();
  });

  test('two calls do not share an id', async () => {
    await place();
    await place({ symbol: 'CAPR' });
    const ids = intents().map(o => o.intentId);
    expect(new Set(ids).size).toBe(2);
  });

  test('it names the symbol, the account and the shares about to go out', async () => {
    await place();
    expect(intents()[0]).toMatchObject({ symbol: 'EYPT', setupId: 'or-vwap-0935',
                                         signal: 'LONG', action: 'buy' });
    expect(intents()[0].legs[0].quantity).toBeGreaterThan(0);
  });

  /*
   * Nothing was sent, so there is nothing that could be at the broker and
   * nothing to reconcile. An intent here would be noise on the one signal that
   * must never be noisy.
   */
  test('nothing is written for a call that never reaches the wire', async () => {
    broker.save({ allowShort: false });
    await place({ signal: 'SHORT' });
    expect(intents()).toHaveLength(0);
    expect(posted).toHaveLength(0);
  });

  test('nothing is written when the desk is not armed', async () => {
    broker.save({ armed: false });
    await place();
    expect(intents()).toHaveLength(0);
  });
});

// ── it must change no tally ────────────────────────────────────────────────

describe('what the intent must not disturb', () => {
  /*
   * Every tally in this file filters on `sent`, and an intent has none. If any
   * of these moved, the intent row would be spending buying power or eating a
   * daily cap for an order that is also counted by its own outcome row.
   */
  test('it spends no buying power', async () => {
    await place();
    const committed = broker.committed(DAY);
    // The outcome row alone accounts for it: quantity × price, counted once.
    expect(committed).toBe(outcomes().filter(o => o.sent)
      .reduce((n, o) => n + o.quantity * o.price, 0));
  });

  test('it does not count as a trade', async () => {
    await place();
    expect(broker.tradesToday(DAY, 'or-vwap-0935')).toBe(1);
  });

  test('it does not take a name against the per-setup cap', async () => {
    broker.save({ armed: false });
    await place();
    expect(broker.positionsToday(DAY, 'or-vwap-0935')).toBe(0);
  });

  test('it does not make a position look open', async () => {
    broker.save({ armed: false });
    await place();
    expect(broker.openSymbols(DAY)).toEqual([]);
  });

  test('it does not tag a journal trade on its own', async () => {
    broker.save({ armed: false });
    await place();
    expect(broker.setupBySymbol(DAY)).toEqual({});
  });

  /*
   * reconciled() is what the broker page and the day report list. Counting the
   * intent there would show every order twice, once with no status.
   */
  test('it is not listed as an order', async () => {
    await place();
    expect(broker.reconciled(DAY)).toHaveLength(1);
  });
});

// ── the one it exists for ──────────────────────────────────────────────────

describe('a call that started and never finished', () => {
  /** The crash: an intent on disk with no outcome behind it. */
  function orphan(over = {}) {
    fs.appendFileSync(process.env.BROKER_LEDGER, `${JSON.stringify({
      kind: 'intent', intentId: 'i-crashed', at: 1, date: DAY, symbol: 'EYPT',
      signal: 'LONG', action: 'buy', setupId: 'or-vwap-0935', destination: 'alp',
      legs: [{ quantity: 60 }, { quantity: 40 }], asked: 100, ...over,
    })}\n`);
  }

  test('is found', () => {
    orphan();
    expect(broker.orphanIntents(DAY)).toHaveLength(1);
    expect(broker.orphanIntents(DAY)[0].symbol).toBe('EYPT');
  });

  test('a completed call is not one', async () => {
    await place();
    expect(broker.orphanIntents(DAY)).toEqual([]);
  });

  /*
   * A REFUSAL IS AN OUTCOME. The call finished, the broker said no, and nothing
   * is at large — reporting it as an orphan would send somebody to check a
   * broker for an order that was never accepted.
   */
  test('a call that finished with a refusal is not one', async () => {
    replies = [{ ok: false, message: 'no buying power' }];
    await place();
    expect(broker.orphanIntents(DAY)).toEqual([]);
  });

  test('another day\'s crash is another day\'s problem', () => {
    orphan({ date: '2026-08-17' });
    expect(broker.orphanIntents(DAY)).toEqual([]);
  });

  test('one crash among healthy calls is still found', async () => {
    await place();
    orphan();
    await place({ symbol: 'CAPR' });
    expect(broker.orphanIntents(DAY).map(o => o.intentId)).toEqual(['i-crashed']);
  });

  /*
   * THE SECOND HALF OF THE DAMAGE. The repeat guard reads `sent`, and an
   * orphan has none — so the setup is free to take the name again. This is the
   * fact the alert has to carry, and it is why the alert exists.
   */
  test('the repeat guard cannot see it, which is why it is announced', () => {
    orphan();
    expect(broker.sentAlready(DAY, 'or-vwap-0935', 'EYPT', 'alp')).toBe(false);
  });
});

// ── the half-placed scale-out ──────────────────────────────────────────────

describe('a partial placement', () => {
  const scaleOut = () => place({
    quantity: 100,
    // Half out at 2R, half riding the stop — the 09:35 shape.
    plan: { legs: [{ fraction: 0.5, price: 5.86, r_multiple: 2 }], runner: 0.5 },
  });

  test('the first leg goes in, the second is refused, and it stops there', async () => {
    replies = [{ ok: true, status: 'filled', id: 'ID1' }, { ok: false, message: 'no buying power' }];
    const out = await scaleOut();
    expect(out.partial).toBe(true);
    expect(out.sent).toBe(true);
  });

  test('the outcome still records which legs went and which did not', async () => {
    replies = [{ ok: true, status: 'filled', id: 'ID1' }, { ok: false, message: 'no buying power' }];
    const out = await scaleOut();
    expect(out.legs.filter(l => l.sent)).toHaveLength(1);
    expect(out.legs.filter(l => !l.sent)).toHaveLength(1);
    expect(out.error).toMatch(/only 1 of 2 legs/);
  });

  test('its intent recorded the whole shape, before any of it was sent', async () => {
    replies = [{ ok: true, status: 'filled', id: 'ID1' }, { ok: false, message: 'nope' }];
    await scaleOut();
    expect(intents()[0].legs).toHaveLength(2);
  });

  test('and it is not an orphan — the call finished', async () => {
    replies = [{ ok: true, status: 'filled', id: 'ID1' }, { ok: false, message: 'nope' }];
    await scaleOut();
    expect(broker.orphanIntents(DAY)).toEqual([]);
  });
});

// ── how each is escalated ──────────────────────────────────────────────────

describe('the escalation', () => {
  const RUNNER = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'setups', 'runner.js'), 'utf8');
  const MANAGER = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'setups', 'manager.js'), 'utf8');

  /*
   * A SEPARATE fire, at error level. It was already in the trade line, which is
   * level `trade` — green, beside every healthy fill, reading as a success with
   * a footnote.
   */
  test('a partial raises its own error-level alert', () => {
    const at = RUNNER.indexOf('HALF PLACED');
    expect(at).toBeGreaterThan(-1);
    expect(RUNNER.slice(at - 400, at)).toMatch(/level: 'error'/);
  });

  test('it says which legs went in and which did not', () => {
    expect(RUNNER).toMatch(/went\.map\(l => l\.quantity\)/);
    expect(RUNNER).toMatch(/missed\.map\(l => l\.quantity\)/);
  });

  /*
   * NOT UNWOUND AUTOMATICALLY, and the alert says so. Every leg goes out as its
   * own bracket, so what got in is protected — it is the wrong SIZE, not an
   * open risk — and closing it costs a certain round trip to undo an uncertain
   * problem. That is a decision about money.
   */
  test('it says plainly that nothing will be unwound for you', () => {
    expect(RUNNER).toMatch(/it will not be unwound for you/);
    expect(RUNNER).toMatch(/wrong SIZE rather than an open risk/);
  });

  test('the trade line still fires — the signal really did fire', () => {
    expect(RUNNER).toMatch(/fires\.push\(\{/);
    expect(RUNNER).toMatch(/level: 'trade'/);
  });

  /* And the orphan, from the loop that runs every minute. */
  test('an orphan is announced by the manager, at error level', () => {
    expect(MANAGER).toMatch(/broker\.orphanIntents\(day\)/);
    expect(MANAGER).toMatch(/STARTED AND NEVER FINISHED/);
  });

  /*
   * BEFORE the positions are looked at, because an orphan by definition
   * produces no position to look at — that is what makes it dangerous.
   */
  test('it is checked before the positions, not after', () => {
    expect(MANAGER.indexOf('orphanIntents'))
      .toBeLessThan(MANAGER.indexOf('const positions = openPositions(day)'));
  });

  /* Once per id. Told every minute, a person stops reading. */
  test('it is said once, not once a minute', () => {
    expect(MANAGER).toMatch(/if \(announced\.has\(o\.intentId\)\) continue;/);
    expect(MANAGER).toMatch(/announced\.add\(o\.intentId\);/);
  });

  test('the day report leads with it', () => {
    const TODAY = fs.readFileSync(
      path.join(__dirname, '..', 'scripts', 'today.js'), 'utf8');
    expect(TODAY).toMatch(/STARTED AND NEVER FINISHED/);
    // And it does not count intents as attempts.
    expect(TODAY).toMatch(/rows = rows\.filter\(o => o\.kind !== 'intent'\)/);
  });
});
