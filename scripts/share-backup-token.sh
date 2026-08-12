#!/usr/bin/env bash
#
# Copy T1's GitHub backup token into the shared keys file, so all nine tools
# have it.
#
# The token has been living in T1's own settings row. sharedKeys reads a tool's
# own setting first, so T1 kept working and the other eight had nothing — which
# is exactly how one tool ended up backing up and eight silently did not.
#
# This reads it out of T1's database and merges it into data/keys.json. Nothing
# is printed but a masked confirmation: a token echoed to a terminal ends up in
# scrollback, in a screenshot, and eventually in a chat window.
#
#     bash scripts/share-backup-token.sh
#
# T1's own row is LEFT ALONE. Removing it would be a second change with its own
# way to go wrong, and a tool's own setting is meant to win anyway.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

node - "$REPO" <<'JS'
const fs = require('fs');
const path = require('path');
const repo = process.argv[2];
const dbPath = path.join(repo, 'data', 'tradedesk.db');   // T1's
const keysPath = path.join(repo, 'data', 'keys.json');

if (!fs.existsSync(dbPath)) {
  console.error(`No T1 database at ${dbPath}`);
  process.exit(1);
}

const Database = require(path.join(repo, 'node_modules', 'better-sqlite3'));
const db = new Database(dbPath, { readonly: true });
const row = db.prepare("SELECT value FROM settings WHERE key = 'githubBackupToken'").get();
const token = row && row.value;
if (!token) {
  console.error('T1 has no githubBackupToken in its settings — nothing to copy.');
  console.error('Add it in T1 Settings first, or write keys.json by hand.');
  process.exit(1);
}

// Merge, never overwrite: keys.json already holds the Finnhub and Alpaca
// credentials, and replacing the file would take the screeners offline in a
// way that looks like an API outage.
let keys = {};
try { keys = JSON.parse(fs.readFileSync(keysPath, 'utf8')) || {}; } catch { /* new file */ }
if (typeof keys !== 'object' || Array.isArray(keys)) keys = {};

const had = keys.githubBackupToken;
keys.githubBackupToken = token;

fs.mkdirSync(path.dirname(keysPath), { recursive: true });
const tmp = keysPath + '.tmp';
fs.writeFileSync(tmp, JSON.stringify(keys, null, 2) + '\n', { mode: 0o600 });
fs.renameSync(tmp, keysPath);
fs.chmodSync(keysPath, 0o600);

const mask = t => t.slice(0, 4) + '…' + t.slice(-4) + ` (${t.length} chars)`;
console.log(had === token
  ? `already shared: ${mask(token)}`
  : `shared: ${mask(token)} → ${keysPath}`);
console.log(`keys.json now holds: ${Object.keys(keys).sort().join(', ')}`);
JS

echo
echo "All nine tools pick this up within 30 seconds — no restart needed."
echo "Next:  bash scripts/backup-all-tools.sh"
