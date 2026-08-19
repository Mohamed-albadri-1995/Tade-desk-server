#!/usr/bin/env node
/*
 * Point every tool at ONE Alpaca account.
 *
 * WHY IT IS NOT ONE UPDATE. getCredentials() looks in three places, in order:
 *
 *   1. the TOOL'S OWN database — trading_brokers, then the legacy settings rows
 *   2. the shared default database, data/tradedesk.db
 *
 * Nine tools have nine databases. A key written into one of them wins there and
 * nowhere else, and a STALE key left in another wins over the new shared one —
 * silently, because a wrong key is a 401 and a 401 is reported as "could not
 * ask", which every protective check treats as "carry on". That is how the
 * borrow check went unrun in eight tools out of nine without a word.
 *
 * So this writes the same credentials into every database it can find, and
 * deletes the legacy settings rows that could shadow them. One account, one
 * answer, from whichever process asks.
 *
 * THEN IT CHECKS. Keys that store cleanly and do not work are the failure this
 * is fixing, so it calls the account endpoint afterwards and prints the account
 * number that came back. Nothing here is believed until Alpaca has answered.
 *
 * Usage
 *   ALPACA_KEY=... ALPACA_SECRET=... node scripts/set-alpaca-keys.js
 *   node scripts/set-alpaca-keys.js <key> <secret>
 *   node scripts/set-alpaca-keys.js <key> <secret> --live
 */

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const ROOT = path.join(__dirname, '..');
const DATA = process.env.DATA_DIR || path.join(ROOT, 'data');

const args = process.argv.slice(2).filter(a => !a.startsWith('--'));
const KEY = process.env.ALPACA_KEY || args[0];
const SECRET = process.env.ALPACA_SECRET || args[1];
/*
 * PAPER UNLESS SAID OTHERWISE. The base URL decides which account a key even
 * addresses, and defaulting to live would point a desk at real money on a typo.
 */
const LIVE = process.argv.includes('--live');
const BASE = LIVE ? 'https://api.alpaca.markets' : 'https://paper-api.alpaca.markets';

if (!KEY || !SECRET) {
  console.error('usage: ALPACA_KEY=… ALPACA_SECRET=… node scripts/set-alpaca-keys.js');
  process.exit(1);
}

const say = (...a) => console.log(...a);

/** Every SQLite database under data/ — one per tool, plus the shared default. */
function databases() {
  let files = [];
  try {
    files = fs.readdirSync(DATA)
      .filter(f => f.endsWith('.db'))
      .map(f => path.join(DATA, f));
  } catch { /* no data dir yet */ }
  return files;
}

function writeInto(file) {
  const db = new Database(file);
  try {
    // The table belongs to the trading app's schema and may not exist in a
    // screener-only database. Created rather than skipped: the point is that
    // every process finds the same answer, including one that has never had a
    // broker profile.
    db.exec(`CREATE TABLE IF NOT EXISTS trading_brokers (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL,
      config TEXT NOT NULL DEFAULT '{}', enabled INTEGER NOT NULL DEFAULT 1,
      is_default INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL)`);
    db.exec(`CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY, value TEXT)`);

    const config = JSON.stringify({ key: KEY, secret: SECRET, paper: !LIVE });

    /*
     * ONE profile, not another one. Repeated runs must not leave a row per
     * attempt: getCredentials() takes is_default first and then the oldest, so
     * a pile of them makes which key wins a matter of insertion order.
     */
    const existing = db.prepare(
      "SELECT id FROM trading_brokers WHERE type = 'alpaca' ORDER BY is_default DESC, created_at ASC").all();
    if (existing.length) {
      db.prepare("UPDATE trading_brokers SET config = ?, enabled = 1 WHERE id = ?")
        .run(config, existing[0].id);
      // Any others are disabled rather than deleted — they may be a different
      // account somebody meant to keep, and they must not be able to win.
      for (const r of existing.slice(1)) {
        db.prepare('UPDATE trading_brokers SET enabled = 0 WHERE id = ?').run(r.id);
      }
    } else {
      db.prepare(`INSERT INTO trading_brokers (id, name, type, config, enabled, is_default, created_at)
                  VALUES (?, ?, 'alpaca', ?, 1, 1, ?)`)
        .run(`alpaca-${Date.now()}`, LIVE ? 'Alpaca (live)' : 'Alpaca (paper)',
             config, Date.now());
    }

    /*
     * THE LEGACY ROWS, updated to match rather than left behind. A profile wins
     * over them today, but a disabled profile falls through to these — and a
     * key from a different account sitting there is exactly the failure being
     * fixed.
     */
    const put = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) '
      + 'ON CONFLICT(key) DO UPDATE SET value = excluded.value');
    put.run('alpacaApiKey', KEY);
    put.run('alpacaApiSecret', SECRET);
    put.run('alpacaAccountUrl', BASE);

    const n = existing.length;
    return n ? `updated (${n} profile${n > 1 ? 's' : ''} found)` : 'created';
  } finally {
    db.close();
  }
}

(async () => {
  say('');
  say(`Pointing every tool at ${LIVE ? 'LIVE' : 'PAPER'}  ${BASE}`);
  say(`key ${KEY.slice(0, 6)}…${KEY.slice(-4)}`);
  say('');

  const files = databases();
  if (!files.length) {
    console.error(`no databases found in ${DATA}`);
    process.exit(1);
  }
  for (const f of files) {
    try {
      say(`  ${path.basename(f).padEnd(20)} ${writeInto(f)}`);
    } catch (err) {
      say(`  ${path.basename(f).padEnd(20)} FAILED: ${err.message}`);
    }
  }

  /*
   * AND NOW ASK ALPACA. Keys that store cleanly and do not work are the whole
   * problem: a 401 reads as "could not ask", and every protective check treats
   * that as permission to carry on.
   */
  say('');
  const res = await fetch(`${BASE}/v2/account`, {
    headers: { 'APCA-API-KEY-ID': KEY, 'APCA-API-SECRET-KEY': SECRET },
  }).catch(err => ({ ok: false, status: 0, text: async () => err.message }));

  const body = await res.text();
  if (!res.ok) {
    say(`ALPACA REFUSED THESE KEYS — ${res.status}: ${body.slice(0, 200)}`);
    say('They are stored, and nothing will work until they are right.');
    process.exitCode = 1;
    return;
  }
  const a = JSON.parse(body);
  say('ALPACA ANSWERED:');
  say(`  account   ${a.account_number}`);
  say(`  equity    ${a.equity}      cash ${a.cash}`);
  say(`  status    ${a.status}`);
  say('');
  say('  That is the account number to compare against the one SignalStack is');
  say('  connected to. If they match, both sides are finally the same account.');
  say('');
  say('  Restart so the running processes pick it up:  bash deploy.sh');
})();
