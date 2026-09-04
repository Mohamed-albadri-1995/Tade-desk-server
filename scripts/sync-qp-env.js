#!/usr/bin/env node
/*
 * qp GETS ITS ALPACA KEYS FROM THE DESK, ON EVERY DEPLOY.
 *
 * The desk holds the Alpaca key pair once — data/keys.json, or a broker
 * destination — and qp reads its own from two environment variables sourced
 * out of quant-platform/.env. Two places to type the same secret is how one of
 * them ends up empty for a month: on 2026-09-04 qp had a polygon key and no
 * Alpaca key, so the one feed that can decide a live bar was not available to
 * the one program that decides.
 *
 * This copies the pair the desk already has into quant-platform/.env, keeping
 * every other line of that file (POLYGON_API_KEY lives there). It runs from
 * deploy-tools.sh before qp is restarted, and it never prints a value.
 *
 * Exit codes, read by the deploy:
 *     0  nothing to do — .env already carries what the desk has, or the desk has no pair
 *     3  .env CHANGED — qp must be restarted to see it
 *     1  could not write
 *
 * Both files are gitignored. Nothing here can put a key into the repository.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const ENV_FILE = process.env.QP_ENV_FILE || path.join(ROOT, 'quant-platform', '.env');

const VARS = { APCA_API_KEY_ID: 'key', APCA_API_SECRET_KEY: 'secret' };

/** Upsert `KEY=value` lines, keeping every other line as it was. */
function upsert(text, values) {
  const lines = String(text || '').split('\n');
  const seen = new Set();
  const out = lines.map((line) => {
    const m = /^\s*(?:export\s+)?([A-Z0-9_]+)\s*=/.exec(line);
    if (!m || !(m[1] in values)) return line;
    seen.add(m[1]);
    return `${m[1]}=${values[m[1]]}`;
  });
  // Drop a trailing empty line so appended vars do not leave a gap.
  while (out.length && out[out.length - 1].trim() === '') out.pop();
  for (const k of Object.keys(values)) if (!seen.has(k)) out.push(`${k}=${values[k]}`);
  return `${out.join('\n')}\n`;
}

function main() {
  const feeds = require('../src/setups/feeds');
  const creds = feeds.alpacaCreds();
  if (!creds) {
    console.log('  alpaca: no key pair on the desk (data/keys.json or a broker '
      + 'destination) — qp keeps whatever it has');
    return 0;
  }
  const values = { APCA_API_KEY_ID: creds.key, APCA_API_SECRET_KEY: creds.secret };
  let before = '';
  try { before = fs.readFileSync(ENV_FILE, 'utf8'); } catch { before = ''; }
  const after = upsert(before, values);
  if (after === (before.endsWith('\n') || before === '' ? before : `${before}\n`)) {
    console.log(`  alpaca: present (from ${creds.from}) — .env already carries it`);
    return 0;
  }
  try {
    fs.mkdirSync(path.dirname(ENV_FILE), { recursive: true });
    fs.writeFileSync(ENV_FILE, after, { mode: 0o600 });
  } catch (err) {
    console.error(`  alpaca: could not write ${ENV_FILE}: ${err.message}`);
    return 1;
  }
  console.log(`  alpaca: present (from ${creds.from}) — written to quant-platform/.env, `
    + 'qp will be restarted');
  return 3;
}

if (require.main === module) process.exit(main());

module.exports = { upsert, VARS, ENV_FILE };
