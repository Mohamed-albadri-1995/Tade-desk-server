/*
 * Notifications that arrive with the page closed.
 *
 * Every failure this can have is a SILENT one: the phone simply stays quiet,
 * and a quiet phone is indistinguishable from a quiet market. So the things
 * pinned here are the ones nobody would notice going wrong —
 *
 *   the VAPID keypair surviving a restart, because every subscription a browser
 *   has ever made is bound to the key it saw, and regenerating retires them all
 *   while leaving them listed;
 *
 *   the signature format, where one wrong option turns every push into a
 *   rejected one;
 *
 *   what counts as new, because pushing on restart would re-announce a trade
 *   that is twenty minutes old as though it were happening now.
 */

const os = require('os');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'push-'));
process.env.PUSH_KEYS_FILE = path.join(DIR, 'push-keys.json');
process.env.PUSH_SUBS_FILE = path.join(DIR, 'push-subs.json');
process.env.ALERT_FIRES_FILE = path.join(DIR, 'alert-fires.json');
process.env.ALERT_RULES_FILE = path.join(DIR, 'alert-rules.json');

const push = require('../src/alerts/push');
const watcher = require('../src/alerts/watcher');
const store = require('../src/alerts/store');
const { toETDate } = require('../src/utils/time');

const b64urlToBuf = s =>
  Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');

beforeEach(() => {
  for (const f of ['push-subs.json', 'alert-fires.json']) {
    try { fs.unlinkSync(path.join(DIR, f)); } catch { /* absent */ }
  }
});
afterAll(() => { fs.rmSync(DIR, { recursive: true, force: true }); });

// ── the keypair ───────────────────────────────────────────────────────────

test('the public key is a raw uncompressed P-256 point, which is what a browser wants', () => {
  const raw = b64urlToBuf(push.publicKey());
  expect(raw).toHaveLength(65);
  expect(raw[0]).toBe(4);
});

/*
 * The one that would be found in production, on a morning, with no clue.
 * A regenerated keypair leaves every subscription listed and every push
 * rejected — the page still reads "Notifications: on".
 */
test('the keypair survives a restart', () => {
  const first = push.publicKey();
  jest.resetModules();
  const again = require('../src/alerts/push');
  expect(again.publicKey()).toBe(first);
  expect(JSON.parse(fs.readFileSync(process.env.PUSH_KEYS_FILE, 'utf8')).publicKey)
    .toBe(first);
});

test('the private key is written where it is ignored by git, not beside the code', () => {
  expect(push.KEYS_FILE).toMatch(/push-keys\.json$/);
  const stored = JSON.parse(fs.readFileSync(push.KEYS_FILE, 'utf8'));
  expect(stored.privateKeyPem).toMatch(/BEGIN PRIVATE KEY/);
});

// ── the signature ─────────────────────────────────────────────────────────

describe('the VAPID header', () => {
  const header = () => push.authHeader('https://fcm.googleapis.com/fcm/send/abc123');

  test('names the push service it is for, so it cannot be replayed at another', () => {
    const jwt = /t=([^,]+)/.exec(header())[1];
    const claims = JSON.parse(b64urlToBuf(jwt.split('.')[1]));
    expect(claims.aud).toBe('https://fcm.googleapis.com');
    expect(claims.sub).toMatch(/^mailto:/);
    expect(claims.exp).toBeGreaterThan(Math.floor(Date.now() / 1000));
    // Push services reject anything more than 24h out.
    expect(claims.exp).toBeLessThan(Math.floor(Date.now() / 1000) + 24 * 3600);
  });

  test('carries the same public key the browser subscribed with', () => {
    expect(/k=(.+)$/.exec(header())[1]).toBe(push.publicKey());
  });

  /*
   * Node signs ECDSA as DER by default; push services want the raw 64-byte
   * r‖s. One option, and without it every push comes back rejected with
   * nothing on this side looking wrong.
   */
  test('is signed as raw r‖s and verifies against the advertised public key', () => {
    const [a, b, c] = /t=([^,]+)/.exec(header())[1].split('.');
    // DER would be ~70 bytes and variable. Push services want exactly 64.
    expect(b64urlToBuf(c)).toHaveLength(64);

    // Verified with the key taken from the header, not from the file — that is
    // what the push service does, and it is what catches the two halves
    // drifting apart.
    const raw = b64urlToBuf(push.publicKey());
    const pub = crypto.createPublicKey({
      key: {
        kty: 'EC', crv: 'P-256',
        x: raw.subarray(1, 33).toString('base64url'),
        y: raw.subarray(33, 65).toString('base64url'),
      },
      format: 'jwk',
    });
    expect(crypto.verify('sha256', Buffer.from(`${a}.${b}`),
      { key: pub, dsaEncoding: 'ieee-p1363' }, b64urlToBuf(c))).toBe(true);
  });
});

// ── who is subscribed ─────────────────────────────────────────────────────

test('subscribing twice from one browser is one subscriber, not two', () => {
  const sub = { endpoint: 'https://fcm.googleapis.com/fcm/send/abc' };
  push.subscribe(sub, 'phone');
  expect(push.subscribe(sub, 'phone again')).toBe(1);
  expect(push.list()).toHaveLength(1);
  // …and the newest label wins, so a re-subscribe is an update.
  expect(push.list()[0].label).toBe('phone again');
});

test('a subscription without an https endpoint is refused', () => {
  expect(() => push.subscribe({ endpoint: 'http://x/y' })).toThrow(/https/);
  expect(() => push.subscribe({})).toThrow();
  expect(push.list()).toHaveLength(0);
});

test('unsubscribing removes exactly one and reports it', () => {
  push.subscribe({ endpoint: 'https://a/1' });
  push.subscribe({ endpoint: 'https://b/2' });
  expect(push.unsubscribe('https://a/1')).toBe(1);
  expect(push.unsubscribe('https://a/1')).toBe(0);
  expect(push.list().map(s => s.endpoint)).toEqual(['https://b/2']);
});

// ── sending ───────────────────────────────────────────────────────────────

describe('sending', () => {
  const real = global.fetch;
  afterEach(() => { global.fetch = real; });

  test('a push carries no body — the worker fetches the alert itself', async () => {
    let seen = null;
    global.fetch = jest.fn(async (url, opts) => { seen = { url, opts }; return { status: 201 }; });
    await push.sendTo('https://fcm.googleapis.com/fcm/send/abc');
    expect(seen.opts.body).toBeUndefined();
    expect(seen.opts.headers['Content-Length']).toBe('0');
    // A setup is acted on within seconds, so it must not be batched or kept.
    expect(seen.opts.headers.Urgency).toBe('high');
    expect(Number(seen.opts.headers.TTL)).toBeLessThanOrEqual(600);
  });

  /*
   * A retired endpoint is retried on every alert forever, and a list of them
   * turns each fire into a burst of failing requests at the one moment latency
   * is the whole point.
   */
  test('endpoints the push service has retired are dropped', async () => {
    push.subscribe({ endpoint: 'https://a/gone' });
    push.subscribe({ endpoint: 'https://b/live' });
    global.fetch = jest.fn(async url =>
      ({ status: String(url).includes('gone') ? 410 : 201 }));

    const out = await push.notifyAll();
    expect(out).toMatchObject({ sent: 1, dropped: 1, subscribers: 2 });
    expect(push.list().map(s => s.endpoint)).toEqual(['https://b/live']);
  });

  test('a temporary failure keeps the subscription', async () => {
    push.subscribe({ endpoint: 'https://a/1' });
    global.fetch = jest.fn(async () => ({ status: 503 }));
    const out = await push.notifyAll();
    expect(out.failed).toBe(1);
    expect(push.list()).toHaveLength(1);
  });

  test('a push service that cannot be reached does not throw', async () => {
    push.subscribe({ endpoint: 'https://a/1' });
    global.fetch = jest.fn(async () => { throw new Error('ENOTFOUND'); });
    await expect(push.notifyAll()).resolves.toMatchObject({ sent: 0, failed: 1 });
    expect(push.list()).toHaveLength(1);
  });

  test('with nobody subscribed, nothing is sent and nothing fails', async () => {
    global.fetch = jest.fn();
    expect(await push.notifyAll()).toMatchObject({ sent: 0, subscribers: 0 });
    expect(global.fetch).not.toHaveBeenCalled();
  });
});

// ── what counts as news ───────────────────────────────────────────────────

describe('deciding what to wake a phone for', () => {
  const day = toETDate(Date.now());
  const fire = (over = {}) => ({
    ruleId: 'R', rule: 'Setup', ticker: 'AAA', toolId: 'T2',
    date: day, at: Date.now(), kind: 'setup', level: 'trade',
    detail: 'BUY 100 AAA', ...over,
  });

  test('a fresh trade is news', () => {
    watcher.seed();
    store.publishFires([fire()], day);
    expect(watcher.newFires()).toHaveLength(1);
  });

  test('the same fire is news exactly once', () => {
    watcher.seed();
    store.publishFires([fire()], day);
    expect(watcher.newFires()).toHaveLength(1);
    expect(watcher.newFires()).toHaveLength(0);
  });

  /*
   * The one that would be actively harmful. A deploy at 10:05 re-reads a file
   * holding the 10:00 trade; without the seed it would push it as though it
   * were firing now, and the trade is entered at market on sight.
   */
  test('everything already on the list at startup counts as delivered', () => {
    store.publishFires([fire(), fire({ ticker: 'BBB' })], day);
    expect(watcher.seed()).toBe(2);
    expect(watcher.newFires()).toHaveLength(0);
  });

  test('an old fire is not news even the first time it is seen', () => {
    watcher.seed();
    store.publishFires([fire({ at: Date.now() - 30 * 60 * 1000 })], day);
    expect(watcher.newFires()).toHaveLength(0);
  });

  /*
   * The setups publish "nothing qualified" on purpose, so silence is never
   * ambiguous. That is worth reading and is not worth waking someone for —
   * teach a person to swipe these away and they swipe away the trade too.
   */
  test('a trade or an error wakes the phone; a status line does not', () => {
    expect(watcher.worthWaking(fire({ level: 'trade' }))).toBe(true);
    expect(watcher.worthWaking(fire({ level: 'warn' }))).toBe(true);
    expect(watcher.worthWaking(fire({ level: 'error' }))).toBe(true);
    expect(watcher.worthWaking(fire({ level: 'info' }))).toBe(false);
  });

  test('two tools firing on the same ticker in the same minute are two alerts', () => {
    watcher.seed();
    const at = Date.now();
    store.publishFires([fire({ at, toolId: 'T2' })], day);
    store.publishFires([fire({ at, toolId: 'T7' })], day);
    expect(watcher.newFires()).toHaveLength(2);
  });
});
