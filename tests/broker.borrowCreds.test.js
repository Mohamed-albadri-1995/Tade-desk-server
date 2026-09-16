/*
 * THE BORROW CHECK HAD NEVER RUN.
 *
 * 2026-09-16, asked directly:
 *
 *   {"ok":true,"checked":false,
 *    "reason":"Alpaca asset MMED 401: {\"message\": \"unauthorized.\"}"}
 *
 * 401. Not a rate limit, not an unlisted symbol — the credentials were not
 * accepted at all. fetchAsset used authHeaders(), which reads getCredentials():
 * the old desk-wide profile in the trading_brokers table. The accounts that
 * actually trade keep their keys in data/broker.json and are read through
 * src/alpaca/account.js, which answers for both of them fine — we read both
 * balances with it the same morning.
 *
 * AND THE FAILURE WAS BY DESIGN INVISIBLE. checkShortable's contract is that a
 * check which cannot run must never block an order:
 *
 *   "No credentials, a network blip or a symbol Alpaca does not list would
 *    otherwise silently stop every short on the box, which is a far worse
 *    failure than the emails this exists to prevent."
 *
 * That is right. But it means a 401 on every single call produced exactly what
 * a clean pass produces — an order on the wire — with the only trace a console
 * line in a PM2 log. So on 2026-09-15:
 *
 *   SHORT MMED 1886 sh · alpaca1: FAILED — asset "MMED" cannot be sold short
 *
 * The check exists precisely to catch that before the order goes out. It was
 * the failure its own comments warn about: a protective check that silently
 * did not happen looks exactly like one that passed.
 *
 * I had guessed the cause was easy_to_borrow being false. It was not. The
 * lookup was never authorised to ask.
 */

const path = require('path');

const client = require(path.join(__dirname, '..', 'src', 'alpaca', 'client'));

const PAPER = 'https://paper-api.alpaca.markets';
const LIVE = 'https://api.alpaca.markets';

const CREDS = { keyId: 'PKACCOUNTONE00000000', secret: 'secretone', paper: true };
const OTHER = { keyId: 'PKACCOUNTTWO00000000', secret: 'secrettwo', paper: true };

/** Asset payloads keyed by the API key that asked, so mixing them shows up. */
function stubFetch(byKey, seen = []) {
  global.fetch = (url, opts) => {
    const key = (opts && opts.headers && opts.headers['APCA-API-KEY-ID']) || null;
    seen.push({ url: String(url), key });
    const answer = byKey[key];
    if (!answer) {
      return Promise.resolve({
        ok: false, status: 401,
        text: () => Promise.resolve('{"message": "unauthorized."}'),
      });
    }
    return Promise.resolve({
      ok: true, status: 200,
      json: () => Promise.resolve(answer),
      text: () => Promise.resolve(JSON.stringify(answer)),
    });
  };
  return seen;
}

const realFetch = global.fetch;
let n = 0;
/** A fresh symbol per test — the asset cache lives for six hours. */
const sym = () => `SYM${(n += 1)}`;

afterEach(() => { global.fetch = realFetch; });

describe('the check asks with the account that is placing the order', () => {
  test("the account's own key is what authenticates the lookup", async () => {
    const s = sym();
    const seen = stubFetch({ [CREDS.keyId]: { symbol: s, shortable: true, easy_to_borrow: true } });
    const r = await client.checkShortable(s, CREDS);
    expect(r.checked).toBe(true);
    expect(seen[0].key).toBe(CREDS.keyId);
  });

  /*
   * THE ONE THAT WAS BROKEN. Without credentials the lookup falls back to the
   * desk-wide profile, which answers 401 — and 401 is reported as "could not
   * ask", which never blocks. This is the whole bug in one assertion.
   */
  test('an unauthorised lookup reports checked:false and does NOT block', async () => {
    const s = sym();
    stubFetch({});                                  // every key is refused
    const r = await client.checkShortable(s, CREDS);
    expect(r.checked).toBe(false);
    expect(r.ok).toBe(true);                        // it still lets the order go
    expect(r.reason).toMatch(/401/);
  });

  test('a shortable asset passes, and says so', async () => {
    const s = sym();
    stubFetch({ [CREDS.keyId]: { symbol: s, shortable: true, easy_to_borrow: true } });
    const r = await client.checkShortable(s, CREDS);
    expect(r).toMatchObject({ ok: true, checked: true, shortable: true, easyToBorrow: true });
  });

  /*
   * AND AN UNSHORTABLE ONE IS REFUSED — which is what MMED should have been on
   * 2026-09-15, before the order went anywhere.
   */
  test('an unshortable asset is refused before the order is sent', async () => {
    const s = sym();
    stubFetch({ [CREDS.keyId]: { symbol: s, shortable: false, easy_to_borrow: false } });
    const r = await client.checkShortable(s, CREDS);
    expect(r.ok).toBe(false);
    expect(r.checked).toBe(true);
  });

  test('shortable but hard to borrow is passed, and flagged', async () => {
    const s = sym();
    stubFetch({ [CREDS.keyId]: { symbol: s, shortable: true, easy_to_borrow: false } });
    const r = await client.checkShortable(s, CREDS);
    expect(r).toMatchObject({ ok: true, checked: true, easyToBorrow: false });
  });
});

describe('paper and live are different lists, and different questions', () => {
  test('paper credentials ask the paper API', async () => {
    const s = sym();
    const seen = stubFetch({ [CREDS.keyId]: { symbol: s, shortable: true } });
    await client.checkShortable(s, { ...CREDS, paper: true });
    expect(seen[0].url.startsWith(PAPER)).toBe(true);
  });

  test('live credentials ask the live API', async () => {
    const s = sym();
    const seen = stubFetch({ [CREDS.keyId]: { symbol: s, shortable: true } });
    await client.checkShortable(s, { ...CREDS, paper: false });
    expect(seen[0].url.startsWith(LIVE)).toBe(true);
  });
});

describe('the cache belongs to the account that asked', () => {
  /*
   * IT WAS KEYED ON THE SYMBOL ALONE. With one account that is harmless; with
   * two it serves one account's answer to the other, and "can I short this"
   * is a question about an ACCOUNT, not about a ticker.
   */
  test("one account's answer is not served to another", async () => {
    const s = sym();
    stubFetch({
      [CREDS.keyId]: { symbol: s, shortable: true, easy_to_borrow: true },
      [OTHER.keyId]: { symbol: s, shortable: false, easy_to_borrow: false },
    });
    const a = await client.checkShortable(s, CREDS);
    const b = await client.checkShortable(s, OTHER);
    expect(a.shortable).toBe(true);
    expect(b.shortable).toBe(false);
  });

  test('and the same account is asked only once', async () => {
    const s = sym();
    const seen = stubFetch({ [CREDS.keyId]: { symbol: s, shortable: true } });
    await client.checkShortable(s, CREDS);
    await client.checkShortable(s, CREDS);
    expect(seen.length).toBe(1);
  });
});

/* ── and the order path hands its own account's keys over ─────────────────── */

describe('the order path passes the destination credentials', () => {
  const fs = require('fs');
  const SRC = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'broker', 'signalstack.js'), 'utf8');

  test('checkShortable is called with credsOf(cfg), not bare', () => {
    expect(SRC).toMatch(
      /checkShortable\(\s*\n?\s*symbol, require\('\.\.\/alpaca\/account'\)\.credsOf\(cfg\)\)/);
  });

  /*
   * A BARE CALL IS THE BUG. It falls back to the desk-wide profile, and the
   * desk-wide profile is what answered 401.
   */
  test('and never with the symbol alone', () => {
    expect(SRC).not.toMatch(/checkShortable\(symbol\)/);
  });
});
