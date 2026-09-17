/*
 * THE BORROW CHECK ASKED ABOUT THE TICKER. THE BROKER REFUSED THE ACCOUNT.
 *
 * 2026-09-17, the first morning the 09:35 setup ran after the restart loop was
 * fixed. It did everything right — 30 evaluated, 13 signalled, 2 picked — and
 * then:
 *
 *     SHORT CIFR 2089 sh @ 17.88 stop 18.12
 *       alpaca1: FAILED — only 0 of 2 legs went in
 *       From Alpaca: account is not allowed to short
 *
 * Read it carefully. Not "this asset cannot be sold short" — THE ACCOUNT is
 * not permitted to short, at all, for any symbol.
 *
 * checkShortable asked /v2/assets/CIFR and was told `shortable: true`, which
 * is the truth about the ticker and says nothing about whether this account
 * may act on it. So the protective check passed the order straight through to
 * the rejection it exists to prevent. It was answering the wrong question —
 * a number that is arithmetically correct about the wrong thing, in the code
 * written to stop exactly that.
 *
 * AND IT IS NOT ABOUT CIFR. The 09:35 setup shorts constantly: on 2026-09-15
 * all three of its picks were shorts. An account that cannot short makes every
 * short in the backtest unreachable in live, so the two can never agree —
 * which is the only thing this desk is being built to do.
 *
 * THE REFUSAL HAS TO NAME THE ACCOUNT. "CIFR cannot be sold short" sends you
 * to look at the ticker, and the ticker is fine. The setting is not.
 */

const path = require('path');

const PAPER = 'https://paper-api.alpaca.markets';
const LIVE = 'https://api.alpaca.markets';
const A = { keyId: 'PKACCOUNTONE00000000', secret: 'secretone', paper: true };
const B = { keyId: 'PKACCOUNTTWO00000000', secret: 'secrettwo', paper: true };

const realFetch = global.fetch;
let client;
let seen;

/**
 * Answer /v2/account and /v2/assets/* per API key.
 *
 * The module is reloaded for every test: checkShortable caches the account's
 * answer, and a cache that survives between tests makes the next one pass for
 * a reason that has nothing to do with what it asserts. The first version of
 * this suite did exactly that.
 */
function stub({ accounts = {}, assets = {} } = {}) {
  seen = [];
  jest.resetModules();
  client = require(path.join(__dirname, '..', 'src', 'alpaca', 'client'));
  global.fetch = (url, opts) => {
    const u = String(url);
    const key = (opts && opts.headers && opts.headers['APCA-API-KEY-ID']) || null;
    seen.push({ url: u, key });
    const body = u.includes('/v2/account')
      ? accounts[key]
      : (assets[key] || {})[u.split('/').pop()];
    if (body === undefined) {
      return Promise.resolve({ ok: false, status: 401,
        text: () => Promise.resolve('{"message": "unauthorized."}') });
    }
    if (body instanceof Error) return Promise.reject(body);
    return Promise.resolve({ ok: true, status: 200,
      json: () => Promise.resolve(body),
      text: () => Promise.resolve(JSON.stringify(body)) });
  };
}

afterEach(() => { global.fetch = realFetch; });

const CAN = { account_number: 'PA000001', shorting_enabled: true, multiplier: '2' };
const CANNOT = { account_number: 'PA000002', shorting_enabled: false, multiplier: '1' };
const SHORTABLE = { symbol: 'CIFR', shortable: true, easy_to_borrow: true };
const NOT_SHORTABLE = { symbol: 'MMED', shortable: false, easy_to_borrow: false };

describe('an account that may not short refuses every symbol', () => {
  /*
   * THE ONE THAT WAS BROKEN. CIFR is shortable as an asset; the account is not
   * allowed to short. This returned ok:true and the order went to Alpaca.
   */
  test('a shortable asset is still refused', async () => {
    stub({ accounts: { [A.keyId]: CANNOT },
           assets: { [A.keyId]: { CIFR: SHORTABLE } } });
    const r = await client.checkShortable('CIFR', A);
    expect(r.ok).toBe(false);
    expect(r.checked).toBe(true);
  });

  test('the reason names the ACCOUNT, not the ticker', async () => {
    stub({ accounts: { [A.keyId]: CANNOT },
           assets: { [A.keyId]: { CIFR: SHORTABLE } } });
    const r = await client.checkShortable('CIFR', A);
    expect(r.reason).toMatch(/account/i);
    expect(r.reason).toMatch(/not permitted to short/i);
    // Naming the symbol here is what sent a week of looking at the wrong thing.
    expect(r.reason).not.toMatch(/CIFR/);
  });

  test('and says the account number, so you know which one to fix', async () => {
    stub({ accounts: { [A.keyId]: CANNOT },
           assets: { [A.keyId]: { CIFR: SHORTABLE } } });
    expect((await client.checkShortable('CIFR', A)).reason).toMatch(/PA000002/);
  });

  test('it does not even ask about the asset — the answer cannot change', async () => {
    stub({ accounts: { [A.keyId]: CANNOT },
           assets: { [A.keyId]: { CIFR: SHORTABLE } } });
    await client.checkShortable('CIFR', A);
    expect(seen.some(s => s.url.includes('/v2/assets/'))).toBe(false);
  });
});

describe('an account that may short behaves exactly as before', () => {
  test('a shortable asset passes', async () => {
    stub({ accounts: { [A.keyId]: CAN },
           assets: { [A.keyId]: { CIFR: SHORTABLE } } });
    const r = await client.checkShortable('CIFR', A);
    expect(r).toMatchObject({ ok: true, checked: true, shortable: true, easyToBorrow: true });
  });

  /*
   * AND THE ASSET-LEVEL REFUSAL STILL NAMES THE ASSET — this is MMED on
   * 2026-09-15, a genuinely unshortable ticker, and that message must not be
   * replaced by the account one.
   */
  test('an unshortable asset is refused, and the reason names the symbol', async () => {
    stub({ accounts: { [A.keyId]: CAN },
           assets: { [A.keyId]: { MMED: NOT_SHORTABLE } } });
    const r = await client.checkShortable('MMED', A);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/MMED/);
    expect(r.reason).toMatch(/asset is not shortable/);
  });

  test('a passing check reports that the account was cleared too', async () => {
    stub({ accounts: { [A.keyId]: CAN },
           assets: { [A.keyId]: { CIFR: SHORTABLE } } });
    expect((await client.checkShortable('CIFR', A)).accountEnabled).toBe(true);
  });
});

describe('a question that could not be asked never blocks', () => {
  /*
   * NULL IS NEVER FALSE. An older API, a field Alpaca stops sending, or a
   * shape this does not expect must read as "could not ask" — which sends the
   * order — and never as "not allowed", which would silently stop every short
   * on the box. That is a far worse failure than the one being fixed.
   */
  test('an account payload with no shorting flag does not block', async () => {
    stub({ accounts: { [A.keyId]: { account_number: 'PA0', status: 'ACTIVE' } },
           assets: { [A.keyId]: { CIFR: SHORTABLE } } });
    const r = await client.checkShortable('CIFR', A);
    expect(r.ok).toBe(true);
    expect(r.accountEnabled).toBeNull();
  });

  test('a 401 on the account does not block', async () => {
    stub({ assets: { [A.keyId]: { CIFR: SHORTABLE } } });   // no account answer
    const r = await client.checkShortable('CIFR', A);
    expect(r.ok).toBe(true);
  });

  test('a network failure on the account does not block', async () => {
    stub({ accounts: { [A.keyId]: new Error('socket hang up') },
           assets: { [A.keyId]: { CIFR: SHORTABLE } } });
    expect((await client.checkShortable('CIFR', A)).ok).toBe(true);
  });

  /*
   * AND THE ASSET STILL DECIDES when the account could not be asked. Losing
   * the asset check because the account call failed would trade one silent
   * hole for another.
   */
  test('the asset check still runs when the account could not be asked', async () => {
    stub({ assets: { [A.keyId]: { MMED: NOT_SHORTABLE } } });
    const r = await client.checkShortable('MMED', A);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/MMED/);
  });

  test('a string instead of a boolean is not a refusal', async () => {
    stub({ accounts: { [A.keyId]: { shorting_enabled: 'false' } },
           assets: { [A.keyId]: { CIFR: SHORTABLE } } });
    expect((await client.checkShortable('CIFR', A)).ok).toBe(true);
  });
});

describe('the account is asked once, and the answer belongs to it', () => {
  test('thirty symbols ask the account once', async () => {
    stub({ accounts: { [A.keyId]: CAN },
           assets: { [A.keyId]: Object.fromEntries(
             Array.from({ length: 30 }, (_, i) => [`S${i}`, { shortable: true }])) } });
    for (let i = 0; i < 30; i += 1) await client.checkShortable(`S${i}`, A);
    expect(seen.filter(s => s.url.includes('/v2/account')).length).toBe(1);
  });

  /*
   * "CAN I SHORT" IS A QUESTION ABOUT AN ACCOUNT. Serving one account's answer
   * to another is the same fault the asset cache already had fixed.
   */
  test("one account's answer is not served to another", async () => {
    stub({ accounts: { [A.keyId]: CAN, [B.keyId]: CANNOT },
           assets: { [A.keyId]: { CIFR: SHORTABLE }, [B.keyId]: { CIFR: SHORTABLE } } });
    expect((await client.checkShortable('CIFR', A)).ok).toBe(true);
    expect((await client.checkShortable('CIFR', B)).ok).toBe(false);
  });

  test('paper and live are asked at their own URLs', async () => {
    stub({ accounts: { [A.keyId]: CAN }, assets: { [A.keyId]: { CIFR: SHORTABLE } } });
    await client.checkShortable('CIFR', { ...A, paper: true });
    expect(seen[0].url.startsWith(PAPER)).toBe(true);
    stub({ accounts: { [A.keyId]: CAN }, assets: { [A.keyId]: { CIFR: SHORTABLE } } });
    await client.checkShortable('CIFR', { ...A, paper: false });
    expect(seen[0].url.startsWith(LIVE)).toBe(true);
  });
});

describe('the answer is asked for again the same morning', () => {
  /*
   * AN ASSET'S SHORTABILITY IS A FACT ABOUT THE MARKET AND IS CACHED SIX
   * HOURS. This is a SETTING somebody changes at the broker, and the whole
   * point of finding it is that it gets changed — so it must be re-read the
   * same session, not the next day.
   */
  test('the account answer expires far sooner than the asset cache', async () => {
    stub({ accounts: { [A.keyId]: CAN }, assets: { [A.keyId]: { CIFR: SHORTABLE } } });
    const real = Date.now;
    try {
      await client.checkShortable('CIFR', A);
      const t0 = real();
      Date.now = () => t0 + 15 * 60 * 1000;                 // a quarter of an hour
      await client.checkShortable('CIFR', A);
      expect(seen.filter(s => s.url.includes('/v2/account')).length).toBe(2);
      // and the asset, unchanged in the same window, is NOT re-fetched
      expect(seen.filter(s => s.url.includes('/v2/assets/')).length).toBe(1);
    } finally { Date.now = real; }
  });
});

describe('the desk can state it before the open, not discover it at 09:34', () => {
  test('accountMayShort is exported', () => {
    stub({ accounts: { [A.keyId]: CAN } });
    expect(typeof client.accountMayShort).toBe('function');
  });

  test('it answers enabled true or false, with the account number', async () => {
    stub({ accounts: { [A.keyId]: CANNOT } });
    expect(await client.accountMayShort(A))
      .toMatchObject({ checked: true, enabled: false, account: 'PA000002' });
  });

  test('and says it could not ask rather than guessing', async () => {
    stub({});
    const r = await client.accountMayShort(A);
    expect(r.checked).toBe(false);
    expect(r.enabled).toBeUndefined();
    expect(r.reason).toMatch(/401/);
  });

  /*
   * IT MUST NOT THROW, EVER. Asking the account happens BEFORE checkShortable's
   * try block, so anything that throws here rejects the caller's promise
   * instead of degrading to "could not ask" — a protective check that crashes
   * the order path, which is worse than the hole it closes. That is exactly
   * what the first version of this did on a box with no Alpaca profile at all,
   * where assetAuth falls back to authHeaders() and authHeaders() throws.
   */
  test('it degrades rather than throwing when there are no credentials', async () => {
    stub({});
    await expect(client.accountMayShort(null)).resolves.toHaveProperty('checked');
  });

  test('and checkShortable still answers, rather than rejecting', async () => {
    stub({});
    await expect(client.checkShortable('CIFR', null)).resolves.toHaveProperty('ok');
  });
});

/* ── and the account report says so, beside the other two blockers ───────── */

describe('the account reporter carries the flag', () => {
  const fs = require('fs');
  const SRC = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'alpaca', 'account.js'), 'utf8');

  test('shortingEnabled is reported', () => {
    expect(SRC).toMatch(/shortingEnabled:/);
  });

  /*
   * null RATHER THAN false WHEN ALPACA DOES NOT SAY — the same rule as above,
   * in the other file that answers this question.
   */
  test('and it is null, not false, when Alpaca does not say', () => {
    expect(SRC).toMatch(/typeof a\.shorting_enabled === 'boolean'[\s\S]{0,60}: null/);
  });

  /*
   * MULTIPLIER 1 IS A CASH ACCOUNT, which cannot short and cannot be enabled
   * to. It is the difference between "turn it on at the broker" and "this
   * account will never run this strategy".
   */
  test('the multiplier is reported beside it', () => {
    expect(SRC).toMatch(/multiplier:/);
  });
});
