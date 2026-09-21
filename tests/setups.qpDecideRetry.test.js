/*
 * A DECISION THAT NEVER GOT AN ANSWER MAY BE ASKED AGAIN. AN ANSWER MAY NOT.
 *
 * 2026-09-03, the whole day for one strategy:
 *
 *     OR + VWAP 09:35   1 run · FAILED · timeout of 45000ms exceeded
 *
 * A clock setup decides on ONE bar. The scheduler's window for it is a minute
 * wide, so when that single attempt timed out the strategy did not trade at
 * all — and the timeout was 45 seconds, which is most of the minute the order
 * had to land in. Two attempts of eighteen fit, with room left for the order.
 *
 * The dangerous half of a retry is the other direction. qp answering "no
 * signal", or answering with a 500, is an ANSWER; asking again would not be a
 * retry, it would be a second opinion, and a desk that asks twice and takes
 * the friendlier answer is not running the strategy that was backtested. So
 * what this file mostly checks is what is NOT retried.
 */

const axios = require('axios');
const qp = require('../src/setups/qpClient');

const ARGS = { strategyId: 'S', symbols: ['AAA'], date: '2026-09-03' };

function timeout() {
  const e = new Error('timeout of 18000ms exceeded');
  e.code = 'ECONNABORTED';
  return e;
}

afterEach(() => { jest.restoreAllMocks(); });

/*
 * ── THE BUDGET WAS RAISED AND THE RETRY REMOVED, 2026-09-21 ──────────────
 *
 * Eighteen seconds twice was the wrong shape, and measurement showed why:
 *
 *     47 cards, measured on the box   12114ms      the real cost
 *     the budget                      18000ms      a 1.5x margin
 *     two attempts                    36000ms      of a 60s minute
 *
 * `OR + VWAP 09:35` failed every attempt that day and did not trade at all.
 * The card list had grown from 30 to 47 — 30 cost 7825ms and fitted. No code
 * had changed.
 *
 * And the retry was not a second chance. qp's decide endpoint is SYNCHRONOUS,
 * so an attempt that times out keeps computing after the client hangs up; the
 * second attempt then competes with the first for the one core the box has.
 * Two 18s goes were one chance made slower.
 */
describe('the budget', () => {
  test('it covers the measured cost with real room, not a sliver', () => {
    // 12114ms is what 47 cards actually cost. A budget under twice that is a
    // deadline that a normal morning walks into.
    expect(qp.DECIDE_TIMEOUT_MS).toBeGreaterThanOrEqual(24000);
  });

  test('and still cannot spend the minute it has to act inside', () => {
    /*
     * The window is sixty seconds and the order still has to be placed after
     * the answer. 45s was tried once and rejected for that reason: a fill at
     * 09:35:44 is three quarters of the way through the bar it was meant to
     * open on, which is worse than the backtest assumed.
     */
    expect(qp.DECIDE_TIMEOUT_MS).toBeLessThanOrEqual(30000);
    expect(qp.DECIDE_TIMEOUT_MS * qp.DECIDE_ATTEMPTS).toBeLessThanOrEqual(30000);
  });

  test('one attempt, because the second one competed with the first', () => {
    expect(qp.DECIDE_ATTEMPTS).toBe(1);
  });

  test('the per-attempt timeout is what reaches axios, not the total budget',
    async () => {
      jest.spyOn(axios, 'post').mockResolvedValue({ data: { ok: true, picks: [] } });
      await qp.decide(ARGS);
      expect(axios.post.mock.calls[0][2].timeout).toBe(qp.DECIDE_TIMEOUT_MS);
    });
});

describe('what may be asked again', () => {
  /*
   * neverAnswered() STAYS, and is still exercised, even though decide() no
   * longer retries. It is the difference between "qp did not answer" and "qp
   * answered something unwelcome", and that distinction is what the alert text
   * and the session log are written from. Deleting it with the retry would
   * have taken the vocabulary with the mechanism.
   */
  test('a timeout never got an answer', () => {
    expect(qp.neverAnswered(timeout())).toBe(true);
  });

  test('...and so does a refused connection — qp was not there', () => {
    const e = new Error('connect ECONNREFUSED 127.0.0.1:8765');
    e.code = 'ECONNREFUSED';
    expect(qp.neverAnswered(e)).toBe(true);
  });

  test('a timeout reported only by message is still a timeout — axios does '
    + 'not always set the code', () => {
    expect(qp.neverAnswered(new Error('timeout of 18000ms exceeded'))).toBe(true);
  });

  /*
   * THE HALF THAT MATTERS. Each of these is qp having reached a conclusion.
   */
  test('a 500 IS an answer — qp got there and failed, and asking again is a '
    + 'second opinion', () => {
    const e = new Error('Request failed with status code 500');
    e.response = { status: 500, data: {} };
    expect(qp.neverAnswered(e)).toBe(false);
  });

  test('a 400 is an answer too', () => {
    const e = new Error('Request failed with status code 400');
    e.response = { status: 400, data: { error: 'unknown metric' } };
    expect(qp.neverAnswered(e)).toBe(false);
  });

  test('ok:false is an answer — the flag says so', () => {
    const e = new Error("no strategy for 'X'");
    e.qpAnswered = true;
    expect(qp.neverAnswered(e)).toBe(false);
  });

  test('an unknown error is NOT retried — the default is to ask once', () => {
    expect(qp.neverAnswered(new Error('something else'))).toBe(false);
    expect(qp.neverAnswered(null)).toBe(false);
  });
});

describe('what decide actually does with that rule', () => {
  test('a timeout is NOT asked again', async () => {
    /*
     * The reverse of what this asserted until 2026-09-21, and the reason is
     * that the second ask was never a second chance. qp's decide endpoint is
     * synchronous: an attempt that times out keeps computing after the client
     * hangs up, so the retry competed with the attempt it was covering for, on
     * the one core the box has. Two 18s goes were one chance made slower.
     *
     * The budget is 30s in one go instead — more patient than both of them
     * together were useful, and it leaves half the minute for the order.
     */
    jest.spyOn(axios, 'post')
      .mockRejectedValueOnce(timeout())
      .mockResolvedValueOnce({ data: { ok: true, picks: [{ ticker: 'AAA' }] } });
    await expect(qp.decide(ARGS)).rejects.toThrow(/timeout/);
    expect(axios.post).toHaveBeenCalledTimes(1);
  });

  test('an answer on the first ask does not claim an attempt count', async () => {
    jest.spyOn(axios, 'post').mockResolvedValue({ data: { ok: true, picks: [] } });
    const out = await qp.decide(ARGS);
    expect(axios.post).toHaveBeenCalledTimes(1);
    expect(out.attempts).toBeUndefined();
  });

  test('a timeout gives up — a second ask would be a different minute',
    async () => {
      jest.spyOn(axios, 'post').mockRejectedValue(timeout());
      await expect(qp.decide(ARGS)).rejects.toThrow(/timeout/);
      expect(axios.post).toHaveBeenCalledTimes(qp.DECIDE_ATTEMPTS);
    });

  test('ok:false is asked ONCE — qp said no and no is the answer', async () => {
    jest.spyOn(axios, 'post')
      .mockResolvedValue({ data: { ok: false, error: "no strategy for 'S'" } });
    await expect(qp.decide(ARGS)).rejects.toThrow(/no strategy/);
    expect(axios.post).toHaveBeenCalledTimes(1);
  });

  test('a 500 is asked ONCE', async () => {
    const e = new Error('Request failed with status code 500');
    e.response = { status: 500, data: {} };
    jest.spyOn(axios, 'post').mockRejectedValue(e);
    await expect(qp.decide(ARGS)).rejects.toThrow(/500/);
    expect(axios.post).toHaveBeenCalledTimes(1);
  });

  test('the body is built once and sent as given', () => {
    /*
     * This checked that a RETRY sent the same body — a second ask with a
     * different question would be a second strategy wearing the first one's
     * name. There is no retry now, so what is left to guard is that the one
     * request carries what the caller asked for and nothing invented.
     */
    const fn = require('fs').readFileSync(
      require('path').join(__dirname, '..', 'src', 'setups', 'qpClient.js'), 'utf8');
    const body = fn.slice(fn.indexOf('const body = {'), fn.indexOf('const tries'));
    expect(body).toContain('symbols, date, tf, feed');
    expect(body).toContain('metric, direction, ctx');
    // strategy_id OR strategies, never both, never neither.
    expect(body).toContain('if (strategies) body.strategies = strategies;');
    expect(body).toContain('else body.strategy_id = strategyId;');
  });

  test('attempts can be pinned to one by the caller, and then a timeout is '
    + 'final', async () => {
    jest.spyOn(axios, 'post').mockRejectedValue(timeout());
    await expect(qp.decide({ ...ARGS, attempts: 1 })).rejects.toThrow(/timeout/);
    expect(axios.post).toHaveBeenCalledTimes(1);
  });
});
