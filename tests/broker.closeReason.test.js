/*
 * A CLOSE MUST SAY WHO CLOSED IT AND WHY.
 *
 * `closePosition` stamped `source: 'end of session'` on every row it wrote, and
 * the MANAGER calls it too. So every position the manager closed — acting on a
 * strategy's exit rule, mid-morning — was filed as a 15:50 flatten. Read back,
 * four live sessions looked like this:
 *
 *     2026-09-08 09:55:45 PL   flatten  end of session
 *     2026-09-08 10:10:46 DOCU flatten  end of session
 *     2026-09-09 09:45:47 AXTI flatten  end of session
 *     2026-09-10 11:50:47 SIG  flatten  end of session
 *
 * Not one of those is an end of session. The flattener runs at 15:50.
 *
 * It cost two wrong diagnoses in a row — first that the manager had stopped
 * running, then that it was closing positions far too early — and neither could
 * be settled from the record, because the one field that would have answered it
 * said the same thing on every row. The manager had in fact been working, and
 * its exit times matched the backtest on six of nine trades.
 *
 * The reason is the caller's to give now. It is NOT defaulted to 'end of
 * session': a default that is a lie for every caller but one is how this
 * started. A caller that says nothing records 'unstated' — visible, obviously
 * wrong, and impossible to mistake for a fact.
 */

const os = require('os');
const path = require('path');
const fs = require('fs');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'closewhy-'));
process.env.BROKER_FILE = path.join(DIR, 'broker.json');
process.env.BROKER_LEDGER = path.join(DIR, 'orders.jsonl');

const broker = require('../src/broker/signalstack');

const HOOK = 'https://app.signalstack.com/hook/FAKEhook0000000000000a';
const DAY = '2026-09-10';

const rows = () => fs.readFileSync(process.env.BROKER_LEDGER, 'utf8')
  .trim().split('\n').filter(Boolean).map(JSON.parse);

beforeEach(() => {
  try { fs.unlinkSync(process.env.BROKER_LEDGER); } catch { /* absent */ }
  broker.save({ enabled: true, armed: true, webhookUrl: HOOK, buyingPower: 100000 });
  global.fetch = jest.fn(async () => ({
    ok: true, status: 200,
    text: async () => JSON.stringify({ id: 'c1', status: 'accepted' }),
  }));
});
afterAll(() => { try { fs.rmSync(DIR, { recursive: true, force: true }); } catch { /* */ } });

describe('the ledger records why a position was closed', () => {
  test('the manager\'s own reason reaches the row', async () => {
    await broker.closePosition('SIG', DAY, broker.settings(),
                               { reason: 'the exit rule fired 2 bar(s) ago' });
    expect(rows()[0]).toMatchObject({
      symbol: 'SIG', kind: 'flatten', action: 'close',
      source: 'the exit rule fired 2 bar(s) ago',
    });
  });

  test('a trailing-stop breach says that instead', async () => {
    await broker.closePosition('LIFE', DAY, broker.settings(),
                               { reason: 'the trailing stop at 39.27 was breached' });
    expect(rows()[0].source).toMatch(/trailing stop at 39\.27/);
  });

  test('the flattener still says end of session', async () => {
    await broker.closePosition('VRT', DAY, broker.settings(),
                               { reason: 'end of session' });
    expect(rows()[0].source).toBe('end of session');
  });

  /*
   * AND NO REASON IS NOT 'end of session'. That default is exactly what made
   * every manager close read as the flattener's work. 'unstated' is wrong in a
   * way that is obvious on sight, which is the point.
   */
  test('a caller that gives no reason records "unstated", not a lie', async () => {
    await broker.closePosition('PL', DAY, broker.settings());
    expect(rows()[0].source).toBe('unstated');
    expect(rows()[0].source).not.toBe('end of session');
  });

  /*
   * THE REASON SURVIVES A REFUSAL, because "which account failed to close, and
   * what was it trying to do" is the whole content of that row.
   */
  test('a disarmed desk still records what it was closing for', async () => {
    broker.save({ enabled: true, armed: false, webhookUrl: HOOK });
    const out = await broker.closePosition('SIG', DAY, broker.settings(),
                                           { reason: 'the exit rule fired' });
    expect(out.sent).toBe(false);
    expect(rows()[0]).toMatchObject({
      source: 'the exit rule fired', skipped: 'not armed',
    });
  });
});

/* ── every caller now states one ──────────────────────────────────────────── */

describe('the three callers each say why', () => {
  const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

  test('the manager passes the reason it already computed', () => {
    const src = read('src/setups/manager.js');
    expect(src).toMatch(/closePosition\(pos\.symbol, day, cfg,[\s\S]{0,80}reason: why/);
    // `why` is the sentence the alert carries — "the exit rule fired N
    // bar(s) ago", "the trailing stop at X was breached", and now "the
    // backtest's stop was hit". It comes from closeVerdict(), which reads
    // qp's `close_now` — the backtest engine's answer — and falls back to the
    // old `exit_now` contract for an older qp. The sentences themselves are
    // run, not grepped, in tests/setups.manager.test.js.
    expect(src).toMatch(/const \{ why, reason \} = closeVerdict\(answer\)/);
  });

  // The flattener no longer sends closes of its own (leftovers are reported,
  // since 2026-09-24): every 15:50 close goes through flattenAll, below.
  test('the flattener closes only through flattenAll', () => {
    const src = read('src/alerts/flattener.js');
    expect(src).toMatch(/broker\.flattenAll\(day, cfg\)/);
    expect(src).not.toMatch(/broker\.closePosition\(/);
  });

  test('flattenAll says it too', () => {
    const src = read('src/broker/signalstack.js');
    expect(src).toMatch(/closePosition\(sym, date, use,[\s\S]{0,90}reason: 'end of session'/);
  });

  test('and the hardcoded source is gone', () => {
    const src = read('src/broker/signalstack.js');
    expect(src).toMatch(/source: reason \|\| 'unstated'/);
    expect(src).not.toMatch(/source: 'end of session' \};/);
  });
});
