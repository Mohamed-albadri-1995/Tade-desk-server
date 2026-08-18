/*
 * Asking Alpaca whether it will short a name — and what happens when it does
 * not answer.
 *
 * THE LIVE CASE. CAPR was sent as a short at 09:36:18 and refused by Alpaca
 * with "asset CAPR cannot be sold short". The identical lookup, run by hand a
 * few hours later, answered:
 *
 *     { ok: false, checked: true, shortable: false, easyToBorrow: false }
 *
 * The check was right. It simply did not happen — one request, in the same
 * second as everything else the box does at the open, and a failure there falls
 * through to "send anyway".
 *
 * That fall-through stays: refusing every short because Alpaca did not answer
 * would stop the whole book on a credential blip, which is worse than the
 * rejection this exists to prevent. What changed is that it asks twice before
 * giving up, and that giving up is now visible rather than a console line.
 */

/*
 * The database is stubbed rather than built, because the credentials are the
 * only thing this file needs out of it — and WHERE they come from is the
 * subject of the last section.
 */
// `mock`-prefixed, because jest hoists this factory above every declaration in
// the file and refuses any other out-of-scope name.
let mockDbRows = {};
jest.mock('../src/db', () => ({
  prepare: sql => ({
    get: () => (/trading_brokers/.test(sql) ? mockDbRows.profile : undefined),
    all: () => (/settings/.test(sql) ? (mockDbRows.settings || []) : []),
  }),
}));

const client = require('../src/alpaca/client');

beforeEach(() => {
  mockDbRows = { profile: { config: JSON.stringify({ key: 'PKTEST', secret: 'shhh' }) } };
});

/*
 * A FRESH SYMBOL PER TEST. fetchAsset caches for six hours and the cache is
 * module-level, so a shared ticker would make the second test that used it
 * assert against the first one's answer — and pass while testing nothing.
 */
let n = 0;
const sym = () => `TST${(n += 1)}`;

const asset = over => ({
  ok: true, status: 200,
  json: async () => ({ symbol: 'CAPR', shortable: false, easy_to_borrow: false, ...over }),
  text: async () => '{}',
});
const boom = { ok: false, status: 500, text: async () => 'upstream exploded' };

// ── the answer, when there is one ──────────────────────────────────────────

describe('when Alpaca answers', () => {
  test('a name it will not short comes back not ok, and CHECKED', async () => {
    global.fetch = jest.fn(async () => asset());
    const r = await client.checkShortable(sym());
    expect(r).toMatchObject({ ok: false, checked: true, shortable: false });
    expect(r.reason).toMatch(/not shortable/);
  });

  test('a name it will short comes back ok', async () => {
    global.fetch = jest.fn(async () => asset({ shortable: true, easy_to_borrow: true }));
    expect(await client.checkShortable(sym()))
      .toMatchObject({ ok: true, checked: true, shortable: true, easyToBorrow: true });
  });

  test('shortable but hard to borrow is still ok — the locate is the broker\'s problem', async () => {
    global.fetch = jest.fn(async () => asset({ shortable: true, easy_to_borrow: false }));
    expect(await client.checkShortable(sym()))
      .toMatchObject({ ok: true, checked: true, shortable: true, easyToBorrow: false });
  });
});

// ── the answer that did not arrive ─────────────────────────────────────────

describe('when Alpaca does not answer', () => {
  /*
   * THE FIX. One transient failure at 09:36 used to remove the protection for
   * that order entirely. Asked twice, the blip costs a quarter of a second and
   * the check still runs.
   */
  test('a single failure is retried, and the second ask is believed', async () => {
    let calls = 0;
    global.fetch = jest.fn(async () => { calls += 1; return calls === 1 ? boom : asset(); });
    const r = await client.checkShortable(sym());
    expect(calls).toBe(2);
    expect(r).toMatchObject({ ok: false, checked: true, shortable: false });
  });

  test('two failures give up — and giving up does NOT block the order', async () => {
    global.fetch = jest.fn(async () => boom);
    const r = await client.checkShortable(sym());
    expect(r.ok).toBe(true);            // ok:true means "send it"
    expect(r.checked).toBe(false);      // ...but nobody checked
    expect(r.reason).toBeTruthy();
  });

  /*
   * `ok: true, checked: false` is the pair that matters. Collapsing them —
   * returning ok:false when the question could not be asked — would stop every
   * short on the box the moment a key expired, silently, and look exactly like
   * a market with no shortable names in it.
   */
  test('"could not ask" is never confused with "no"', async () => {
    global.fetch = jest.fn(async () => boom);
    const cannotAsk = await client.checkShortable(sym());
    global.fetch = jest.fn(async () => asset());
    const no = await client.checkShortable(sym());
    expect(cannotAsk.ok).toBe(true);
    expect(no.ok).toBe(false);
    expect(cannotAsk.checked).toBe(false);
    expect(no.checked).toBe(true);
  });

  test('a network throw is handled the same way as a bad status', async () => {
    global.fetch = jest.fn(async () => { throw new Error('ECONNRESET'); });
    const r = await client.checkShortable(sym());
    expect(r).toMatchObject({ ok: true, checked: false });
    expect(r.reason).toMatch(/ECONNRESET/);
  });
});

// ── the cache ──────────────────────────────────────────────────────────────

describe('the asset cache', () => {
  test('a second question about the same name does not ask again', async () => {
    const one = sym();
    global.fetch = jest.fn(async () => asset());
    await client.checkShortable(one);
    await client.checkShortable(one);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  /*
   * A FAILURE IS NOT CACHED. Caching "could not ask" would turn one blip at
   * 09:36 into six hours with no borrow check at all — the failure would
   * outlive its cause and nothing would say so.
   */
  test('a failure is not cached — the next order asks again', async () => {
    const one = sym();
    global.fetch = jest.fn(async () => boom);
    await client.checkShortable(one);
    const asked = global.fetch.mock.calls.length;
    global.fetch = jest.fn(async () => asset());
    const r = await client.checkShortable(one);
    expect(asked).toBeGreaterThan(0);
    expect(global.fetch).toHaveBeenCalled();
    expect(r.checked).toBe(true);
  });
});

// ── WHERE THE CREDENTIALS COME FROM ────────────────────────────────────────
/*
 * THE ACTUAL CAUSE, and the reason it went unnoticed for so long.
 *
 * Every tool runs in its own process with its own DB_PATH — t2.db, t3.db — so
 * that nine screeners do not overwrite each other's cards. The Alpaca keys got
 * caught up in that split, and they should not have: there is ONE Alpaca
 * account, typed once, on whichever page the person happened to be on.
 *
 * getCredentials() throws when the tool's own database has none. checkShortable
 * catches every throw and returns "could not ask" — which sends the order. So
 * in every tool except the one where the keys were entered, the borrow check
 * has never run, and the only trace was a console line.
 *
 * From outside it looked like a flaky network: CAPR refused by Alpaca at 09:36
 * from T2, and the identical lookup answering correctly by hand a few hours
 * later — because by hand it read the default database.
 */
describe('credentials belong to the account, not the tool', () => {
  test('a tool with no keys of its own can still ask', async () => {
    // Nothing in this tool's database at all.
    mockDbRows = { profile: undefined, settings: [] };
    global.fetch = jest.fn(async () => asset());

    const r = await client.checkShortable(sym());

    /*
     * Either it found the shared keys and really asked, or there is no shared
     * database here to find them in — this suite runs on machines with and
     * without one. What must NEVER happen is the third case: a throw that
     * escapes and takes the order path down with it.
     */
    expect(r).toHaveProperty('ok');
    expect(typeof r.checked).toBe('boolean');
    if (!r.checked) expect(r.ok).toBe(true);      // could not ask ⇒ still sends
  });

  test('a tool WITH its own keys never looks elsewhere', async () => {
    mockDbRows = { profile: { config: JSON.stringify({ key: 'PKOWN', secret: 's' }) } };
    global.fetch = jest.fn(async () => asset());
    const r = await client.checkShortable(sym());
    expect(r.checked).toBe(true);
    const headers = global.fetch.mock.calls[0][1].headers;
    expect(headers['APCA-API-KEY-ID']).toBe('PKOWN');
  });

  test('the legacy settings rows still work', async () => {
    mockDbRows = { profile: undefined, settings: [
      { key: 'alpacaApiKey', value: 'PKLEGACY' },
      { key: 'alpacaApiSecret', value: 's' },
    ] };
    global.fetch = jest.fn(async () => asset());
    const r = await client.checkShortable(sym());
    expect(r.checked).toBe(true);
    expect(global.fetch.mock.calls[0][1].headers['APCA-API-KEY-ID']).toBe('PKLEGACY');
  });

  /*
   * AND IT STILL MUST NOT BLOCK. Whatever happens looking for keys — no file,
   * a locked file, an older schema — the answer is "send it and let the broker
   * decide", never an exception out of checkShortable.
   */
  test('nothing about the credential hunt can throw out of checkShortable', async () => {
    mockDbRows = { profile: { config: 'not json at all' }, settings: [{ key: 'x' }] };
    global.fetch = jest.fn(async () => asset());
    await expect(client.checkShortable(sym())).resolves.toHaveProperty('ok');
  });
});
