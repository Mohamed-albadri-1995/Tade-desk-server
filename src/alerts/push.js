/*
 * Notifications that arrive when the page is closed.
 *
 * THE PROBLEM. Everything else here works by having the tab open: the page
 * polls, and when a fire appears it calls new Notification(). Close the tab and
 * nothing runs — no poll, no notification. A setup that fires at 10:00:02 while
 * the phone is in a pocket is a setup that told nobody. For a system whose one
 * job is to reach you at a fixed minute, that is the whole thing failing.
 *
 * WHAT FIXES IT. A service worker, which the browser keeps registered after the
 * tab is gone, plus a push message from this server that wakes it. That is the
 * only mechanism a website has for reaching a closed page — there is no other,
 * and no amount of polling gets there, because polling needs something running.
 *
 * WHY THERE IS NO LIBRARY HERE. The usual one (web-push) exists mostly to
 * encrypt a PAYLOAD: the message body travels through Google's or Mozilla's
 * push service, so it has to be encrypted end-to-end with a key only the
 * browser holds. That is real work — ECDH, HKDF, AES128GCM.
 *
 * We send no payload. The push is an empty wake-up; the service worker then
 * fetches the fires from this server over the same HTTPS the page uses. So the
 * only cryptography left is VAPID — a signed JWT proving the push came from
 * this server — which is one ES256 signature that node's crypto does natively.
 *
 * That is not a shortcut, it is the better arrangement for this data: no trade,
 * no ticker and no price is ever handed to a third-party push service. What
 * Google sees is "this endpoint has something new".
 *
 *   data/push-keys.json   the VAPID keypair. Generated once, never rotated
 *                         casually — every subscription is bound to the public
 *                         key it was created with.
 *   data/push-subs.json   the browsers to wake. One per device, not per person.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DIR = process.env.DATA_DIR || path.join(__dirname, '..', '..', 'data');
const KEYS_FILE = process.env.PUSH_KEYS_FILE || path.join(DIR, 'push-keys.json');
const SUBS_FILE = process.env.PUSH_SUBS_FILE || path.join(DIR, 'push-subs.json');

// Push services want a way to contact whoever is sending. Nobody reads it, but
// some of them reject a subscription request without one.
const CONTACT = process.env.PUSH_CONTACT || 'mailto:alerts@trade-desk.local';

const b64url = buf => Buffer.from(buf).toString('base64')
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function readJSON(file, fallback) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    return raw && typeof raw === 'object' ? raw : fallback;
  } catch {
    return fallback;
  }
}

function writeJSON(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

/*
 * The VAPID keypair, made on first use and kept.
 *
 * Kept rather than regenerated because every subscription a browser has ever
 * created is bound to the public key it saw at the time. A new keypair silently
 * invalidates every phone that has already subscribed — they stay listed, the
 * pushes are rejected, and nothing arrives. So this file is written once and
 * the private key never leaves the box.
 */
let CACHE = null;
function keys() {
  if (CACHE) return CACHE;
  const stored = readJSON(KEYS_FILE, null);
  if (stored && stored.publicKey && stored.privateKeyPem) {
    CACHE = stored;
    return CACHE;
  }
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', {
    namedCurve: 'prime256v1',
  });
  // The raw uncompressed point (0x04 ‖ X ‖ Y) — what a browser expects as
  // applicationServerKey, and the last 65 bytes of the DER encoding.
  const raw = publicKey.export({ type: 'spki', format: 'der' }).subarray(-65);
  CACHE = {
    publicKey: b64url(raw),
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    createdAt: Date.now(),
  };
  writeJSON(KEYS_FILE, CACHE);
  return CACHE;
}

/** The half a browser is allowed to see. */
function publicKey() {
  return keys().publicKey;
}

/**
 * The VAPID Authorization header for one push service.
 *
 * Signed per audience — the token names the push service it is for, so one
 * cannot be replayed against another. Twelve hours, well inside the twenty-four
 * the spec allows, and re-signed per send because signing is microseconds.
 */
function authHeader(endpoint) {
  const { origin } = new URL(endpoint);
  const header = b64url(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const body = b64url(JSON.stringify({
    aud: origin,
    exp: Math.floor(Date.now() / 1000) + 12 * 3600,
    sub: CONTACT,
  }));
  const sig = crypto.sign('sha256', Buffer.from(`${header}.${body}`), {
    key: crypto.createPrivateKey(keys().privateKeyPem),
    // Push services want the raw 64-byte r‖s, not the DER wrapping node
    // produces by default. This one line is the difference between every push
    // working and every push being rejected as a bad signature.
    dsaEncoding: 'ieee-p1363',
  });
  return `vapid t=${header}.${body}.${b64url(sig)}, k=${publicKey()}`;
}

// ── who to wake ────────────────────────────────────────────────────────────

/** Every subscribed browser. */
function list() {
  const state = readJSON(SUBS_FILE, { subs: [] });
  return Array.isArray(state.subs) ? state.subs : [];
}

function save(subs) {
  writeJSON(SUBS_FILE, { subs, updatedAt: Date.now() });
}

/**
 * Remember a browser, keyed by its endpoint.
 *
 * The endpoint IS the identity — one per browser per device, reissued if the
 * user clears site data. Keyed on it so subscribing twice from the same phone
 * does not produce two notifications for one alert.
 */
function subscribe(sub, label) {
  if (!sub || typeof sub.endpoint !== 'string' || !/^https:\/\//.test(sub.endpoint)) {
    throw new Error('a subscription needs an https endpoint');
  }
  const subs = list().filter(s => s.endpoint !== sub.endpoint);
  subs.push({
    endpoint: sub.endpoint,
    label: String(label || '').slice(0, 60) || null,
    createdAt: Date.now(),
  });
  save(subs);
  return subs.length;
}

function unsubscribe(endpoint) {
  const before = list();
  const after = before.filter(s => s.endpoint !== endpoint);
  if (after.length !== before.length) save(after);
  return before.length - after.length;
}

// ── sending ────────────────────────────────────────────────────────────────

/**
 * Wake one browser. No body — see the note at the top.
 *
 * `urgency: high` matters: a setup fires at a fixed minute and the trade is
 * taken on sight, so the push service must not batch it behind a screen-on
 * event. TTL is deliberately short for the same reason — an alert delivered
 * forty minutes late is worse than one not delivered, because it reads as
 * current.
 */
async function sendTo(endpoint, { ttl = 600, urgency = 'high' } = {}) {
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: authHeader(endpoint),
      TTL: String(ttl),
      Urgency: urgency,
      'Content-Length': '0',
    },
  });
  return { status: res.status, ok: res.status >= 200 && res.status < 300 };
}

/**
 * Wake everything subscribed.
 *
 * A subscription the push service has retired (404/410) is removed here rather
 * than left to accumulate: a stale endpoint is retried on every alert forever,
 * and a list of them turns each fire into a burst of failing requests at the
 * one moment latency matters.
 */
async function notifyAll(opts = {}) {
  const subs = list();
  if (!subs.length) return { sent: 0, failed: 0, dropped: 0, subscribers: 0 };

  const results = await Promise.all(subs.map(async s => {
    try {
      return { endpoint: s.endpoint, ...(await sendTo(s.endpoint, opts)) };
    } catch (err) {
      return { endpoint: s.endpoint, status: 0, ok: false, error: err.message };
    }
  }));

  const gone = results.filter(r => r.status === 404 || r.status === 410);
  if (gone.length) {
    const dead = new Set(gone.map(r => r.endpoint));
    save(list().filter(s => !dead.has(s.endpoint)));
  }
  const sent = results.filter(r => r.ok).length;
  return {
    sent,
    failed: results.length - sent,
    dropped: gone.length,
    subscribers: subs.length,
    // Kept so a failure that is not a dead subscription can be read from the
    // health endpoint instead of guessed at.
    errors: results.filter(r => !r.ok && r.status !== 404 && r.status !== 410)
      .map(r => ({ status: r.status, error: r.error || null })),
  };
}

module.exports = {
  KEYS_FILE, SUBS_FILE,
  publicKey, authHeader, list, subscribe, unsubscribe, sendTo, notifyAll,
};
