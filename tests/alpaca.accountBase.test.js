/*
 * THE FIELD THAT SAYS WHICH ACCOUNT ANSWERED MUST SAY WHICH ACCOUNT ANSWERED.
 *
 * Reported while diagnosing a live/paper mixup: "maybe by mistake I connect
 * account 2 to alpaca paper trading but his signalstack to live account with
 * no fund". The desk sized P at 566 shares against $100,000 of buying power
 * and all three legs came back "insufficient buying power" — which is what it
 * looks like when the balance is read from one account and the orders go to
 * another.
 *
 * The first thing anyone reaches for to settle that is `account.base`: paper
 * and live have the same shape and the same fields, and the URL is the only
 * thing that separates them. It read getAccountBaseUrl() — the ENV-WIDE
 * default — while the request itself had gone to the per-account URL chosen
 * from that destination's own `alpacaPaper` flag.
 *
 * So on a two-account desk, where every caller names an account, the one field
 * whose whole job is "paper or live" answered about neither, and answered
 * IDENTICALLY for both. A field that says the same thing whatever happened —
 * and this one would have been read as evidence in the very investigation it
 * was wrong about.
 */

const path = require('path');
const acct = require(path.join(__dirname, '..', 'src', 'alpaca', 'account'));

const PAPER = 'https://paper-api.alpaca.markets';
const LIVE = 'https://api.alpaca.markets';

describe('the base URL reported is the base URL used', () => {
  test('paper credentials report the paper API', () => {
    expect(acct.baseUrlFor({ keyId: 'k', secret: 's', paper: true })).toBe(PAPER);
  });

  test('live credentials report the live API', () => {
    expect(acct.baseUrlFor({ keyId: 'k', secret: 's', paper: false })).toBe(LIVE);
  });

  /*
   * THE TWO ACCOUNTS MUST NOT AGREE. This is the assertion the old code failed:
   * both answered with the env default, so a desk reading one account on paper
   * and trading another on live saw one URL and no way to tell.
   */
  test('a paper account and a live account do not report the same URL', () => {
    expect(acct.baseUrlFor({ keyId: 'a', secret: 'b', paper: true }))
      .not.toBe(acct.baseUrlFor({ keyId: 'c', secret: 'd', paper: false }));
  });

  /*
   * PAPER UNLESS TOLD OTHERWISE, matching credsOf: guessing wrong towards
   * paper queries a simulator, and guessing wrong the other way queries real
   * money.
   */
  test('an account with no paper flag is paper', () => {
    expect(acct.baseUrlFor({ keyId: 'k', secret: 's' })).toBe(PAPER);
  });

  /*
   * HALF A KEY PAIR IS NOT A CREDENTIAL — credsFor refuses it, so the desk-wide
   * default is what the request would use, and that is what must be reported.
   */
  test('half a key pair falls back to the desk default, as the request does', () => {
    expect(acct.baseUrlFor({ keyId: 'k', paper: false })).toBe(acct.baseUrlFor(null));
  });

  test('no account named at all reports the desk default', () => {
    expect(typeof acct.baseUrlFor(null)).toBe('string');
    expect(acct.baseUrlFor(null)).toMatch(/^https:\/\//);
  });

  test('it is exported, so the choice lives in one place', () => {
    expect(typeof acct.baseUrlFor).toBe('function');
  });
});

/* ── and the reader uses it, on the request it really makes ───────────── */

/*
 * DRIVEN THROUGH account() WITH THE NETWORK STUBBED, so the assertion is that
 * the URL REPORTED and the URL REQUESTED are the same string. A helper that
 * returns the right answer while the caller still prints the env default is
 * the original bug, unchanged — and only executing both halves can tell them
 * apart.
 */
describe('account() reports the URL its own request went to', () => {
  const realFetch = global.fetch;
  let hit = null;

  beforeEach(() => {
    hit = null;
    global.fetch = (url) => {
      hit = String(url);
      return Promise.resolve({
        ok: true,
        status: 200,
        // get() reads text() and parses it — a json() stub is never called,
        // and a test that only stubbed json() would assert on an empty body.
        text: () => Promise.resolve(JSON.stringify({
          account_number: 'PA123', equity: '100000', cash: '100000',
          buying_power: '100000', daytrade_count: 0, status: 'ACTIVE',
        })),
      });
    };
  });
  afterEach(() => { global.fetch = realFetch; });

  test('a live account reads as live, and was asked at the live API', async () => {
    const r = await acct.account({ account: { keyId: 'k', secret: 's', paper: false } });
    expect(r.ok).toBe(true);
    expect(hit.startsWith(LIVE)).toBe(true);
    expect(r.account.base).toBe(LIVE);
  });

  test('a paper account beside it reads as paper, and was asked at paper', async () => {
    const r = await acct.account({ account: { keyId: 'k', secret: 's', paper: true } });
    expect(hit.startsWith(PAPER)).toBe(true);
    expect(r.account.base).toBe(PAPER);
  });

  /*
   * THE ONE THAT MATTERS ON THIS DESK. Two accounts, one paper and one live,
   * read in the same process: the field has to separate them.
   */
  test('two accounts in one process do not report the same base', async () => {
    const a = await acct.account({ account: { keyId: 'a', secret: 'b', paper: true } });
    const b = await acct.account({ account: { keyId: 'c', secret: 'd', paper: false } });
    expect(a.account.base).not.toBe(b.account.base);
  });

  test('the reported base is always the one the request used', async () => {
    for (const paper of [true, false]) {
      // eslint-disable-next-line no-await-in-loop
      const r = await acct.account({ account: { keyId: 'k', secret: 's', paper } });
      expect(hit.startsWith(r.account.base)).toBe(true);
    }
  });

  test('and the account number still comes back beside it', async () => {
    const r = await acct.account({ account: { keyId: 'k', secret: 's', paper: true } });
    expect(r.account.number).toBe('PA123');
  });
});
