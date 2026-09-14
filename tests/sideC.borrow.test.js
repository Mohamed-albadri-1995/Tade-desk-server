/*
 * CAN THIS NAME BE SHORTED — and is it in trouble at the clearing house.
 *
 * Backtest #354 made +$1,345.43 over twelve trades. XE, a short, was +$1,408.60
 * of it. Live: `alpaca1: FAILED — asset "XE" cannot be sold short`. Without XE
 * the run is -$63.17, so the whole result was one trade the broker will not
 * place. STKH and LBGJ went the same way on 2026-08-14, CAPR before them.
 *
 * The backtest can ask Alpaca at backtest time, but Alpaca keeps NO HISTORY —
 * that is today's flag applied to a past day. The register freezes a card per
 * name per trading day, so writing the flag onto the card is how a real, dated
 * borrow history gets built, for exactly the universe this desk trades.
 *
 * TWO FIELDS, TWO QUESTIONS, NEVER MERGED:
 *
 *   shortable   Alpaca, per symbol — what actually refuses the order.
 *   regSho      the exchange threshold list, one file a day for the whole
 *               market — a SYMPTOM of hard borrow, not a broker's permission.
 *
 * A name can be threshold-listed and still shortable, and unshortable without
 * ever appearing on the list. Collapsing them would be a number that is
 * arithmetically fine about the wrong question.
 */

const https = require('https');

jest.mock('https');

const borrow = require('../src/sideC/borrow');

/** Answer the next https.get with this status and body. */
function answers(map) {
  https.get.mockImplementation((url, opts, cb) => {
    const key = Object.keys(map).find(k => String(url).includes(k));
    const hit = map[key];
    const res = {
      statusCode: hit ? hit.status : 599,
      on(ev, fn) {
        if (ev === 'data' && hit && hit.body) fn(Buffer.from(hit.body));
        if (ev === 'end') fn();
        return res;
      },
    };
    if (hit && hit.throw) {
      const req = { on(ev, fn) { if (ev === 'error') setImmediate(() => fn(new Error(hit.throw))); return req; }, destroy() {} };
      return req;
    }
    setImmediate(() => cb(res));
    return { on() { return this; }, destroy() {} };
  });
}

const THRESHOLD = [
  'Symbol|Security Name|Market Category|Reg SHO Threshold Flag|Rule 4320',
  'XE|XE Corp|N|Y|N',
  'STKH|Steakholder|Q|Y|N',
  'File Creation Time: 09142026',
].join('\n');

const asset = (shortableFlag, easy = false) => JSON.stringify({
  symbol: 'XE', shortable: shortableFlag, easy_to_borrow: easy,
});

beforeEach(() => {
  borrow.forget();
  https.get.mockReset();
  process.env.APCA_API_KEY_ID = 'PKFAKEACCOUNTAAAAAAA';
  process.env.APCA_API_SECRET_KEY = 'fakesecretAAAAAAAAAAAAAAAAAAAAAA';
});

/* ── the broker's answer ──────────────────────────────────────────────────── */

describe('will the broker lend it', () => {
  test('a shortable asset comes back true', async () => {
    answers({ '/v2/assets/': { status: 200, body: asset(true, true) } });
    expect(await borrow.shortable('AAPL')).toMatchObject({
      shortable: true, easyToBorrow: true, reason: null,
    });
  });

  test('XE comes back false, with the reason', async () => {
    answers({ '/v2/assets/': { status: 200, body: asset(false) } });
    const r = await borrow.shortable('XE');
    expect(r.shortable).toBe(false);
    expect(r.reason).toMatch(/cannot be sold short/);
  });

  /*
   * A 404 IS AN ANSWER, and the strongest one: a symbol the broker does not
   * list cannot be traded there at all.
   */
  test('a symbol the broker does not list is false, not unknown', async () => {
    answers({ '/v2/assets/': { status: 404, body: '' } });
    const r = await borrow.shortable('NOPE');
    expect(r.shortable).toBe(false);
    expect(r.reason).toMatch(/not an asset at this broker/);
  });

  /*
   * AND EVERY OTHER FAILURE IS null, NOT false. A card that recorded an
   * unreachable lookup as "not shortable" would retire a name from the short
   * book on the strength of a timeout.
   */
  test('a 500 is null — unanswered, not refused', async () => {
    answers({ '/v2/assets/': { status: 500, body: '' } });
    const r = await borrow.shortable('XE');
    expect(r.shortable).toBeNull();
    expect(r.shortable).not.toBe(false);
    expect(r.reason).toMatch(/answered 500/);
  });

  test('a network error is null too, and says so', async () => {
    answers({ '/v2/assets/': { throw: 'socket hang up' } });
    const r = await borrow.shortable('XE');
    expect(r.shortable).toBeNull();
    expect(r.reason).toMatch(/socket hang up/);
  });

  test('a body that is not JSON is null', async () => {
    answers({ '/v2/assets/': { status: 200, body: '<html>nope</html>' } });
    expect((await borrow.shortable('XE')).shortable).toBeNull();
  });

  test('no credentials is null, and is NOT cached', async () => {
    delete process.env.APCA_API_KEY_ID;
    delete process.env.APCA_API_SECRET_KEY;
    expect((await borrow.shortable('XE')).shortable).toBeNull();
    expect(https.get).not.toHaveBeenCalled();
    // Keys can arrive later in the life of a process; remembering the refusal
    // would keep the answer null all day.
    process.env.APCA_API_KEY_ID = 'PKFAKEACCOUNTAAAAAAA';
    process.env.APCA_API_SECRET_KEY = 'fakesecretAAAAAAAAAAAAAAAAAAAAAA';
    answers({ '/v2/assets/': { status: 200, body: asset(true) } });
    expect((await borrow.shortable('XE')).shortable).toBe(true);
  });

  test('a symbol is asked once per process', async () => {
    answers({ '/v2/assets/': { status: 200, body: asset(false) } });
    await borrow.shortable('XE');
    await borrow.shortable('xe');
    expect(https.get).toHaveBeenCalledTimes(1);
  });
});

/* ── the threshold list ───────────────────────────────────────────────────── */

describe('the Reg SHO threshold list', () => {
  test('the real file shape parses to its symbols', () => {
    const { symbols, rows } = borrow.parseThreshold(THRESHOLD);
    expect([...symbols].sort()).toEqual(['STKH', 'XE']);
    expect(rows).toBe(2);
  });

  /*
   * AN HTML ERROR PAGE MUST NOT READ AS A CLEAN MARKET. It parses to nothing,
   * and nothing is exactly what a genuinely short list looks like — so the row
   * count is what separates them, and thresholdList treats zero rows as
   * unanswered rather than as "no name is listed today".
   */
  test('an error page parses to nothing, and nothing is not an answer', () => {
    expect(borrow.parseThreshold('<html><body>Error</body></html>').rows).toBe(0);
  });

  test('one list answering is enough to mark the names on it', async () => {
    answers({
      nasdaqtrader: { status: 200, body: THRESHOLD },
      'nyse.com': { status: 500, body: '' },
    });
    const r = await borrow.thresholdList('20260914');
    expect(r.ok).toBe(true);
    expect(r.symbols.has('XE')).toBe(true);
    expect(r.sources.nasdaq).toMatchObject({ ok: true, rows: 2 });
    expect(r.sources.nyse).toMatchObject({ ok: false });
  });

  test('neither answering is ok:false, with a reason each', async () => {
    answers({ nasdaqtrader: { status: 404, body: '' }, 'nyse.com': { status: 503, body: '' } });
    const r = await borrow.thresholdList('20260913');
    expect(r.ok).toBe(false);
    expect(r.sources.nasdaq.reason).toMatch(/not published/);
    expect(r.sources.nyse.reason).toMatch(/503/);
  });

  test('the day is part of the URL, so the file really is historical', async () => {
    answers({ nasdaqtrader: { status: 200, body: THRESHOLD }, 'nyse.com': { status: 404, body: '' } });
    await borrow.thresholdList('20260908');
    expect(https.get.mock.calls.some(c => String(c[0]).includes('20260908'))).toBe(true);
  });
});

/* ── onto the card ────────────────────────────────────────────────────────── */

describe('what gets frozen onto the card', () => {
  const cards = () => ([
    { ticker: 'XE', stock: { price: 18.2 } },
    { ticker: 'AAPL', stock: { price: 240 } },
  ]);

  test('both readings land, and they are separate fields', async () => {
    https.get.mockImplementation((url, opts, cb) => {
      const u = String(url);
      const body = u.includes('nasdaqtrader') ? THRESHOLD
        : u.includes('nyse.com') ? ''
          : asset(!u.includes('/XE'));
      const status = u.includes('nyse.com') ? 404 : 200;
      const res = {
        statusCode: status,
        on(ev, fn) {
          if (ev === 'data' && body) fn(Buffer.from(body));
          if (ev === 'end') fn();
          return res;
        },
      };
      setImmediate(() => cb(res));
      return { on() { return this; }, destroy() {} };
    });

    const rows = cards();
    const out = await borrow.fill(rows, { day: '20260914' });
    const xe = rows.find(r => r.ticker === 'XE').stock;
    const aapl = rows.find(r => r.ticker === 'AAPL').stock;

    expect(xe.shortable).toBe(false);
    expect(xe.regSho).toBe(true);
    expect(aapl.shortable).toBe(true);
    expect(aapl.regSho).toBe(false);
    expect(out).toMatchObject({ checked: 2, listed: 1 });
  });

  /*
   * A NAME CAN BE THRESHOLD-LISTED AND STILL SHORTABLE. The two fields must be
   * able to disagree, or one of them is decoration.
   */
  test('the two fields are allowed to disagree', async () => {
    https.get.mockImplementation((url, opts, cb) => {
      const u = String(url);
      const body = u.includes('nasdaqtrader') ? THRESHOLD : asset(true, false);
      const res = {
        statusCode: u.includes('nyse.com') ? 404 : 200,
        on(ev, fn) {
          if (ev === 'data' && body && !u.includes('nyse.com')) fn(Buffer.from(body));
          if (ev === 'end') fn();
          return res;
        },
      };
      setImmediate(() => cb(res));
      return { on() { return this; }, destroy() {} };
    });
    const rows = [{ ticker: 'XE', stock: {} }];
    await borrow.fill(rows, { day: '20260914' });
    expect(rows[0].stock.shortable).toBe(true);
    expect(rows[0].stock.regSho).toBe(true);
  });

  /*
   * AND WHEN NEITHER LIST COULD BE READ, regSho IS null ON EVERY CARD. "Not on
   * the list" and "nobody read the list" are opposite facts, and the second
   * must never be frozen as the first — the card is permanent.
   */
  test('an unread threshold list writes null, never false', async () => {
    answers({
      nasdaqtrader: { status: 503, body: '' },
      'nyse.com': { status: 503, body: '' },
      '/v2/assets/': { status: 200, body: asset(true) },
    });
    const rows = cards();
    const out = await borrow.fill(rows, { day: '20260914' });
    for (const r of rows) {
      expect(r.stock.regSho).toBeNull();
      expect(r.stock.regSho).not.toBe(false);
      expect(r.stock.regShoNote).toMatch(/503/);
    }
    expect(out.regSho).toBe(0);
  });

  test('a card that already carries the reading is left alone', async () => {
    answers({
      nasdaqtrader: { status: 200, body: THRESHOLD },
      'nyse.com': { status: 404, body: '' },
    });
    const rows = [{ ticker: 'XE', stock: { shortable: true } }];
    await borrow.fill(rows, { day: '20260914' });
    expect(rows[0].stock.shortable).toBe(true);
    // the per-symbol asset call never happened
    expect(https.get.mock.calls.every(c => !String(c[0]).includes('/v2/assets/'))).toBe(true);
  });

  test('no cards is not an error', async () => {
    expect(await borrow.fill([])).toMatchObject({ checked: 0 });
    expect(https.get).not.toHaveBeenCalled();
  });
});

/* ── every tool, not one ──────────────────────────────────────────────────── */

describe('it runs in the pipeline every tool shares', () => {
  const src = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'src', 'pipeline.js'), 'utf8');

  test('the stage is wired in', () => {
    expect(src).toMatch(/stageWrapSoft\(report, 'borrow'/);
    expect(src).toMatch(/require\('\.\/sideC\/borrow'\)/);
  });

  /*
   * SOFT, beside shortInterest. Neither the broker nor an exchange file may
   * cost a scan — a screener that stopped finding stocks because nasdaqtrader
   * was down would be a far worse failure than a missing flag.
   */
  test('and it cannot fail a scan', () => {
    const at = src.indexOf("stageWrapSoft(report, 'borrow'");
    expect(at).toBeGreaterThan(-1);
    expect(src.slice(at - 400, at)).toMatch(/shortInterest/);
  });
});
