/*
 * The background EDGAR warmer — the thing that fills C and A.
 *
 * WHY THIS FILE EXISTS. Moving the CANSLIM tables out of the popup and onto
 * the card removed the only path that ever walked EDGAR. A background warmer
 * replaced it, and it was broken in a way nothing could see: the card route
 * awaits the CACHED read first, which stores {ok:false, 'not fetched yet'} for
 * every uncached symbol, and the warmer skipped anything already "in" the
 * cache. So it skipped every symbol it existed to fetch, queued nothing, and
 * still reported itself as having run. Every card read "not fetched yet"
 * forever.
 *
 * These tests drive the REAL functions against a stub qp, because that is the
 * only way the interaction between the two paths is visible at all.
 */

const oneil = require('../src/sideD/oneil');

const CACHED_MISS = {
  ok: false, cached: false, error: 'not fetched yet — EDGAR is walked nightly',
};
const REAL = { ok: true, cached: true, c: { rows: [{ eps_chg: 41 }] }, a: {} };

let calls;

/** A stub qp that answers the cached path with a miss and the building path
 *  with real tables — exactly what the live server does. */
function stubQp(building = REAL) {
  calls = [];
  global.fetch = async url => {
    calls.push(String(url));
    const u = new URL(String(url));
    const syms = (u.searchParams.get('symbols') || '').split(',').filter(Boolean);
    const cachedOnly = u.searchParams.get('cached_only') === '1';
    const stocks = {};
    for (const s of syms) stocks[s.toUpperCase()] = cachedOnly ? CACHED_MISS : building;
    return { json: async () => ({ ok: true, stocks }) };
  };
}

const settle = () => new Promise(r => setTimeout(r, 0));
const buildCalls = () => calls.filter(u => !u.includes('cached_only=1'));

beforeEach(() => { stubQp(); });
afterEach(() => { delete global.fetch; });

describe('a cached miss is not an answer', () => {
  test('the warmer queues a symbol the cached read has already missed', async () => {
    // The route's real order: cached read first, warmer second.
    await oneil.loadFundamentalsCached(['AAA']);
    expect(oneil.fundamentalsCache().stocks.AAA.ok).toBe(false);

    const res = oneil.warmFundamentals(['AAA']);
    expect(res.queued).toBeGreaterThan(0);         // was 0 — the whole bug
  });

  test('...and the building path actually reaches qp for it', async () => {
    await oneil.loadFundamentalsCached(['BBB']);
    oneil.warmFundamentals(['BBB']);
    await settle();
    // _qpBatch skips any symbol already in the cache, and a miss IS in the
    // cache, so the miss has to be dropped before the building call.
    expect(buildCalls().length).toBe(1);
    expect(buildCalls()[0]).toContain('BBB');
    expect(oneil.fundamentalsCache().stocks.BBB.ok).toBe(true);
  });

  test('a symbol that already has real tables is never re-walked', async () => {
    await oneil.loadFundamentals(['CCC']);         // building path, real answer
    calls = [];
    expect(oneil.warmFundamentals(['CCC']).queued).toBe(0);
    await settle();
    expect(buildCalls().length).toBe(0);
  });
});

describe('the warmer is bounded', () => {
  test('a name EDGAR has nothing for is walked ONCE, not on every scan', async () => {
    // ok:false from the BUILDING path is never cached by qp, so "re-queue
    // anything still missing" would walk this name again on every scan of
    // every tool, all day, for an answer that cannot change today.
    stubQp({ ok: false, error: 'no facts' });
    await oneil.loadFundamentalsCached(['DDD']);
    oneil.warmFundamentals(['DDD']);
    await settle();
    expect(buildCalls().length).toBe(1);

    oneil.warmFundamentals(['DDD']);               // a second scan, same name
    await settle();
    expect(buildCalls().length).toBe(1);
  });

  test('the same name asked for twice in one scan is fetched once', async () => {
    await oneil.loadFundamentalsCached(['EEE']);
    oneil.warmFundamentals(['EEE', 'EEE', 'eee']);
    await settle();
    expect(buildCalls().length).toBe(1);
  });

  test('qp being down leaves the cache empty rather than throwing', async () => {
    global.fetch = async () => { throw new Error('ECONNREFUSED'); };
    expect(() => oneil.warmFundamentals(['FFF'])).not.toThrow();
    await settle();
    expect(oneil.fundamentalsCache().stocks.FFF).toBeUndefined();
  });
});
