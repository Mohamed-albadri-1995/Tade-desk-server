#!/usr/bin/env node
/*
 * A REFUSED DESK-WIDE ALPACA KEY IS REPLACED WITH ONE THAT WORKS — ON DEPLOY.
 *
 * The desk-wide pair (data/keys.json) is what qp and every tool fall back to
 * for prices and the per-tool broker profile. It does not have to belong to
 * any particular account — any working paper pair will do. On 2026-09-24 it
 * was dead while each account's own pair, entered on Algo → Settings, was
 * placing orders all day. The fix was to copy one of those over, by hand.
 *
 * So the deploy does it:
 *
 *   1. Ask Alpaca about the desk-wide pair. Answered → nothing to do.
 *   2. REFUSED (401/403, on paper and live alike) → try each account's own
 *      pair; the first Alpaca answers for is written everywhere by
 *      scripts/set-alpaca-keys.js, and the account it came from is named.
 *   3. Anything else — no network, a 5xx, a timeout — changes nothing. Only a
 *      refusal is evidence the key is wrong.
 *
 * Never prints a key. Always exits 0: a deploy must not stop over this.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const DATA = process.env.DATA_DIR || path.join(ROOT, 'data');
const PAPER = 'https://paper-api.alpaca.markets';
const LIVE = 'https://api.alpaca.markets';

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

/** 'ok' | 'refused' | 'unknown' — for one pair at one base URL. */
async function ask(key, secret, base, fetchFn = fetch) {
  try {
    const r = await fetchFn(`${base}/v2/account`, {
      headers: { 'APCA-API-KEY-ID': key, 'APCA-API-SECRET-KEY': secret },
      signal: AbortSignal.timeout(8000),
    });
    if (r.ok) return 'ok';
    if (r.status === 401 || r.status === 403) return 'refused';
    return 'unknown';
  } catch { return 'unknown'; }
}

/** The desk-wide pair has no paper/live flag: refused means refused by both. */
async function askEither(key, secret, fetchFn) {
  const a = await ask(key, secret, PAPER, fetchFn);
  if (a !== 'refused') return a;
  return ask(key, secret, LIVE, fetchFn);
}

async function heal({ keysFile = process.env.SHARED_KEYS_FILE || path.join(DATA, 'keys.json'),
                      brokerFile = process.env.BROKER_FILE || path.join(DATA, 'broker.json'),
                      fetchFn = fetch, apply = applyPair, say = console.log } = {}) {
  const shared = readJson(keysFile) || {};
  const dests = ((readJson(brokerFile) || {}).destinations || [])
    .filter(d => d && d.dialect === 'alpaca' && d.alpacaKeyId && d.alpacaSecret);

  if (shared.alpacaApiKey && shared.alpacaApiSecret) {
    const now = await askEither(shared.alpacaApiKey, shared.alpacaApiSecret, fetchFn);
    if (now === 'ok') { say('  desk-wide Alpaca key: answered'); return { action: 'none' }; }
    if (now === 'unknown') {
      say('  desk-wide Alpaca key: Alpaca could not be asked — left as it is');
      return { action: 'none' };
    }
    say('  desk-wide Alpaca key: REFUSED by Alpaca');
  } else {
    say('  desk-wide Alpaca key: none set');
  }

  for (const d of dests) {
    if (d.alpacaKeyId === shared.alpacaApiKey) continue;       // the one just refused
    const base = d.alpacaPaper === false ? LIVE : PAPER;
    const r = await ask(d.alpacaKeyId, d.alpacaSecret, base, fetchFn);
    if (r !== 'ok') { say(`    ${d.name || d.id}'s own key: ${r}`); continue; }
    const done = apply(d.alpacaKeyId, d.alpacaSecret, base === LIVE);
    say(done
      ? `    → replaced with ${d.name || d.id}'s own key (${base === LIVE ? 'live' : 'paper'}), which Alpaca answered`
      : `    → could not write ${d.name || d.id}'s key — run scripts/set-alpaca-keys.js by hand`);
    return { action: done ? 'replaced' : 'failed', from: d.id };
  }
  say('    no account\'s own key was answered either — enter a working pair on Algo → Settings');
  return { action: 'none' };
}

/** Everywhere set-alpaca-keys.js writes; the key goes by environment, never argv. */
function applyPair(key, secret, live) {
  const r = spawnSync(process.execPath,
    [path.join(__dirname, 'set-alpaca-keys.js'), ...(live ? ['--live'] : [])],
    { env: { ...process.env, ALPACA_KEY: key, ALPACA_SECRET: secret }, encoding: 'utf8' });
  return r.status === 0;
}

module.exports = { heal, ask };

if (require.main === module) {
  heal().catch(err => console.log(`  desk-wide Alpaca key: not checked (${err.message})`))
    .finally(() => process.exit(0));
}
