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

describe('the budget', () => {
  test('one attempt cannot spend the whole minute it has to act inside', () => {
    // The window is sixty seconds and the order still has to be placed after
    // the answer. Two attempts plus the order must fit inside one minute.
    expect(qp.DECIDE_TIMEOUT_MS).toBeLessThanOrEqual(20000);
    expect(qp.DECIDE_TIMEOUT_MS * qp.DECIDE_ATTEMPTS).toBeLessThan(60000);
  });

  test('and there is more than one attempt', () => {
    expect(qp.DECIDE_ATTEMPTS).toBeGreaterThanOrEqual(2);
  });

  test('the per-attempt timeout is what reaches axios, not the total budget',
    async () => {
      jest.spyOn(axios, 'post').mockResolvedValue({ data: { ok: true, picks: [] } });
      await qp.decide(ARGS);
      expect(axios.post.mock.calls[0][2].timeout).toBe(qp.DECIDE_TIMEOUT_MS);
    });
});

describe('what may be asked again', () => {
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
  test('a timeout is asked again, and the second answer is returned',
    async () => {
      jest.spyOn(axios, 'post')
        .mockRejectedValueOnce(timeout())
        .mockResolvedValueOnce({ data: { ok: true, picks: [{ ticker: 'AAA' }] } });
      const out = await qp.decide(ARGS);
      expect(axios.post).toHaveBeenCalledTimes(2);
      expect(out.picks).toHaveLength(1);
      // SAID OUT LOUD. A decision that needed a retry nearly did not happen,
      // and that is worth seeing before the day it does not.
      expect(out.attempts).toBe(2);
    });

  test('an answer on the first ask does not claim an attempt count', async () => {
    jest.spyOn(axios, 'post').mockResolvedValue({ data: { ok: true, picks: [] } });
    const out = await qp.decide(ARGS);
    expect(axios.post).toHaveBeenCalledTimes(1);
    expect(out.attempts).toBeUndefined();
  });

  test('two timeouts give up — a third ask would be a different minute',
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

  test('the retry asks the SAME question — a second body would be a second '
    + 'strategy wearing the first one\'s name', async () => {
    jest.spyOn(axios, 'post')
      .mockRejectedValueOnce(timeout())
      .mockResolvedValueOnce({ data: { ok: true, picks: [] } });
    await qp.decide({ ...ARGS, tf: '1m', feed: 'yahoo' });
    const [urlA, bodyA] = axios.post.mock.calls[0];
    const [urlB, bodyB] = axios.post.mock.calls[1];
    expect(urlB).toBe(urlA);
    expect(bodyB).toEqual(bodyA);
  });

  test('attempts can be pinned to one by the caller, and then a timeout is '
    + 'final', async () => {
    jest.spyOn(axios, 'post').mockRejectedValue(timeout());
    await expect(qp.decide({ ...ARGS, attempts: 1 })).rejects.toThrow(/timeout/);
    expect(axios.post).toHaveBeenCalledTimes(1);
  });
});
