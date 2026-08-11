/*
 * API keys, entered once instead of nine times.
 *
 * Every tool owns its own database — that is the whole design, so one tool's
 * history can never leak into another's. A key is not history. It is the same
 * credential for the same third party, and keeping nine copies of it means
 * typing it nine times, on a phone, and then finding out weeks later that the
 * one on T6 was mistyped because that tool quietly stopped fetching news.
 *
 * So keys are read from one file outside any tool's database. A per-tool
 * setting still wins if it is present, because a tool that has been given a
 * specific key should keep using it — but nobody has to give one.
 *
 * The file lives beside the databases and is NOT in the repository. It holds
 * secrets; a key committed to a public repo is a key that has been published,
 * whatever the commit message says.
 *
 *   ~/Tade-desk-server/data/keys.json
 *   { "finnhubApiKey": "…", "alpacaApiKey": "…", "alpacaApiSecret": "…" }
 *
 * Order: the tool's own setting, then the shared file, then the environment.
 */

const fs = require('fs');
const path = require('path');
const config = require('./config');

const FILE = process.env.SHARED_KEYS_FILE
  || path.join(path.dirname(config.dbPath), 'keys.json');

// Re-read on a short cadence rather than caching forever: a key pasted into
// the file should start working without restarting nine processes, and reading
// a small file every thirty seconds costs nothing.
const TTL_MS = 30000;
let _cache = null;
let _readAt = 0;

function readShared() {
  const now = Date.now();
  if (_cache && now - _readAt < TTL_MS) return _cache;
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    _cache = (raw && typeof raw === 'object') ? raw : {};
  } catch {
    _cache = {};          // absent or unparseable — fall through to env
  }
  _readAt = now;
  return _cache;
}

/**
 * @param name   settings key, e.g. 'finnhubApiKey'
 * @param envVar environment variable to fall back to, e.g. 'FINNHUB_API_KEY'
 */
function getKey(name, envVar) {
  try {
    const db = require('./db');
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(name);
    if (row && row.value) return row.value;
  } catch { /* no db in this context — keep going */ }

  const shared = readShared();
  if (shared[name]) return shared[name];

  return (envVar && process.env[envVar]) || '';
}

/** Where a key came from, for the Settings screen — never the key itself. */
function keySource(name, envVar) {
  try {
    const db = require('./db');
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(name);
    if (row && row.value) return 'this tool';
  } catch { /* ignore */ }
  if (readShared()[name]) return 'shared file';
  if (envVar && process.env[envVar]) return 'environment';
  return null;
}

module.exports = { getKey, keySource, FILE };
