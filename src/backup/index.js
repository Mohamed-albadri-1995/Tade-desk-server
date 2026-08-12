const https = require('https');
const db = require('../db');
const config = require('../config');
const sharedKeys = require('../sharedKeys');

const BACKUP_REPO = 'Mohamed-albadri-1995/trade-desk-data';
const BACKUP_BRANCH = 'fresh';
const BACKUP_VERSION = '1';

/*
 * One token for nine tools.
 *
 * This used to read only THIS tool's settings row, so backing up meant pasting
 * the same token into nine screens on a phone — and in practice that meant one
 * tool backed up and eight did not, silently, because a tool with no token
 * throws inside a cron job nobody watches.
 *
 * sharedKeys resolves the tool's own setting first (a tool given a specific
 * token keeps using it), then data/keys.json, then the environment. Same order
 * as every other credential here.
 */
function getGithubToken() {
  return sharedKeys.getKey('githubBackupToken', 'GITHUB_BACKUP_TOKEN');
}

/*
 * WHERE THIS TOOL'S BACKUP LIVES, and why it is not one flat folder.
 *
 * Every tool exports the same table names from its own database. Written to
 * `backups/<date>.json` they would all be the SAME path, so nine tools sharing
 * one token would overwrite each other all evening and the file would hold
 * whichever finished last — with nothing to show it had happened. That failure
 * did not exist while only T1 had a token; sharing the token is precisely what
 * would have created it.
 *
 * T1 keeps the flat path it has always used, so its existing history stays
 * exactly where it is and stays restorable.
 */
function backupDir() {
  const id = String(config.toolId || 'T1').toUpperCase();
  return id === 'T1' ? 'backups' : `backups/${id}`;
}

// ─── GitHub API helpers ───────────────────────────────────────────────────────

function githubRequest(method, path, token, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const options = {
      hostname: 'api.github.com',
      path,
      method,
      headers: {
        'User-Agent': 'trade-desk-backup/1.0',
        'Authorization': `token ${token}`,
        'Accept': 'application/vnd.github.v3+json',
        'Content-Type': 'application/json',
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, body: data });
        }
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

async function getFileSha(token, filePath) {
  const res = await githubRequest('GET', `/repos/${BACKUP_REPO}/contents/${filePath}?ref=${BACKUP_BRANCH}`, token);
  if (res.status === 200 && res.body.sha) return res.body.sha;
  return null;
}

async function pushFile(token, filePath, content, message, attempt = 0) {
  // Always re-read the current SHA right before the PUT so we commit against
  // the file as it stands now.
  const sha = await getFileSha(token, filePath);
  const body = {
    message,
    content: Buffer.from(content).toString('base64'),
    branch: BACKUP_BRANCH,
    ...(sha ? { sha } : {}),
  };
  const res = await githubRequest('PUT', `/repos/${BACKUP_REPO}/contents/${filePath}`, token, body);
  // 409 (ref moved) / 422 (stale sha): another commit landed on the branch
  // between our GET and PUT. Back off, re-fetch the fresh SHA, and retry.
  if ((res.status === 409 || res.status === 422) && attempt < 4) {
    await delay(400 * (attempt + 1));
    return pushFile(token, filePath, content, message, attempt + 1);
  }
  if (res.status !== 200 && res.status !== 201) {
    throw new Error(`GitHub push failed (${res.status}): ${JSON.stringify(res.body)}`);
  }
  return res.body;
}

async function fetchFile(token, filePath) {
  const res = await githubRequest('GET', `/repos/${BACKUP_REPO}/contents/${filePath}?ref=${BACKUP_BRANCH}`, token);
  if (res.status !== 200) throw new Error(`GitHub fetch failed (${res.status}): ${res.body.message || ''}`);
  return Buffer.from(res.body.content, 'base64').toString('utf8');
}

// ─── Export DB ────────────────────────────────────────────────────────────────

function exportDb() {
  const settings = db.prepare('SELECT key, value FROM settings').all();
  const shortlist = db.prepare('SELECT * FROM shortlist ORDER BY date').all();
  const r1 = db.prepare('SELECT * FROM r1_frozen ORDER BY date, ticker').all();
  const r2 = db.prepare('SELECT * FROM r2_market_snapshots ORDER BY date, slot').all();
  const r3a = db.prepare('SELECT * FROM r3a ORDER BY date, ticker').all();
  const r3b = db.prepare('SELECT * FROM r3b ORDER BY date, ticker').all();

  return JSON.stringify({
    version: BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    tables: { settings, shortlist, r1_frozen: r1, r2_market_snapshots: r2, r3a, r3b },
  }, null, 2);
}

// ─── Import DB ────────────────────────────────────────────────────────────────

function importDb(jsonStr) {
  const backup = JSON.parse(jsonStr);
  if (!backup.tables) throw new Error('Invalid backup format: missing tables');

  const { settings, shortlist, r1_frozen, r2_market_snapshots, r3a, r3b } = backup.tables;

  db.transaction(() => {
    // Settings: merge — don't wipe, update/insert each key
    if (Array.isArray(settings)) {
      const upsert = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
      for (const row of settings) upsert.run(row.key, row.value);
    }

    // Shortlist: replace all
    if (Array.isArray(shortlist)) {
      db.prepare('DELETE FROM shortlist').run();
      const ins = db.prepare('INSERT OR REPLACE INTO shortlist (date, items, exported, exported_at) VALUES (?, ?, ?, ?)');
      for (const row of shortlist) ins.run(row.date, row.items, row.exported, row.exported_at);
    }

    // R1 frozen
    if (Array.isArray(r1_frozen)) {
      db.prepare('DELETE FROM r1_frozen').run();
      const ins = db.prepare('INSERT OR REPLACE INTO r1_frozen (date, ticker, data, captured_at) VALUES (?, ?, ?, ?)');
      for (const row of r1_frozen) ins.run(row.date, row.ticker, row.data, row.captured_at);
    }

    // R2 market snapshots
    if (Array.isArray(r2_market_snapshots)) {
      db.prepare('DELETE FROM r2_market_snapshots').run();
      const ins = db.prepare('INSERT INTO r2_market_snapshots (date, slot, captured_at, data) VALUES (?, ?, ?, ?)');
      for (const row of r2_market_snapshots) ins.run(row.date, row.slot, row.captured_at, row.data);
    }

    // R3a
    if (Array.isArray(r3a)) {
      db.prepare('DELETE FROM r3a').run();
      const ins = db.prepare('INSERT OR REPLACE INTO r3a (date, ticker, entry_price_a, hh_a, ll_a, atr14, up_r_a, down_r_a, captured_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
      for (const row of r3a) ins.run(row.date, row.ticker, row.entry_price_a, row.hh_a, row.ll_a, row.atr14, row.up_r_a, row.down_r_a, row.captured_at);
    }

    // R3b
    if (Array.isArray(r3b)) {
      db.prepare('DELETE FROM r3b').run();
      const ins = db.prepare('INSERT OR REPLACE INTO r3b (date, ticker, entry_price_b, hh_b, ll_b, atr14, up_r_b, down_r_b, captured_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
      for (const row of r3b) ins.run(row.date, row.ticker, row.entry_price_b, row.hh_b, row.ll_b, row.atr14, row.up_r_b, row.down_r_b, row.captured_at);
    }
  })();

  return backup.exportedAt;
}

// ─── Push backup to GitHub ────────────────────────────────────────────────────

async function pushBackup() {
  const token = getGithubToken();
  if (!token) throw new Error('No GitHub backup token configured. Add it in Settings.');

  const payload = exportDb();
  const date = new Date().toISOString().slice(0, 10);
  const ts = new Date().toISOString();
  const msg = `Backup ${date} — auto export at ${ts}`;

  // Push sequentially, NOT in parallel: both files commit to the same branch,
  // and two concurrent Contents-API commits race on the branch HEAD → 409.
  await pushFile(token, `${backupDir()}/${date}.json`, payload, msg);
  await pushFile(token, `${backupDir()}/latest.json`, payload, msg);

  // Record last backup time in settings
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('lastBackupAt', ts);

  return { date, exportedAt: ts };
}

// ─── Restore from GitHub ─────────────────────────────────────────────────────

async function restoreBackup(backupDate) {
  const token = getGithubToken();
  if (!token) throw new Error('No GitHub backup token configured. Add it in Settings.');

  const filePath = backupDate
    ? `${backupDir()}/${backupDate}.json`
    : `${backupDir()}/latest.json`;
  const jsonStr = await fetchFile(token, filePath);
  const exportedAt = importDb(jsonStr);

  return { restoredFrom: filePath, exportedAt };
}

/**
 * Merge specific dates out of a backup into the live DB, without deleting
 * anything.
 *
 * restoreBackup()/importDb() replace whole tables, so pulling an old snapshot
 * to recover a few pruned days would wipe every day captured since. This
 * inserts only the requested dates and uses INSERT OR IGNORE throughout, so a
 * row that already exists is never overwritten and unrelated dates are
 * untouched.
 *
 * Used to recover days that were trimmed out of r1_frozen but whose rows were
 * still part of the model's training set.
 *
 * @param {string} backupDate  which backups/<date>.json to read
 * @param {string[]} dates     the dates to merge in
 */
async function mergeDatesFromBackup(backupDate, dates) {
  const token = getGithubToken();
  if (!token) throw new Error('No GitHub backup token configured. Add it in Settings.');
  if (!Array.isArray(dates) || !dates.length) throw new Error('No dates given');

  const wanted = new Set(dates);
  const backup = JSON.parse(await fetchFile(token, `backups/${backupDate}.json`));
  if (!backup.tables) throw new Error('Invalid backup format: missing tables');
  const { r1_frozen = [], r3a = [], r3b = [] } = backup.tables;

  const added = { r1_frozen: 0, r3a: 0, r3b: 0 };
  db.transaction(() => {
    const insR1 = db.prepare(
      'INSERT OR IGNORE INTO r1_frozen (date, ticker, data, captured_at) VALUES (?, ?, ?, ?)');
    for (const r of r1_frozen) {
      if (!wanted.has(r.date)) continue;
      added.r1_frozen += insR1.run(r.date, r.ticker, r.data, r.captured_at).changes;
    }
    const insA = db.prepare(
      'INSERT OR IGNORE INTO r3a (date, ticker, entry_price_a, hh_a, ll_a, atr14, up_r_a, down_r_a, captured_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
    for (const r of r3a) {
      if (!wanted.has(r.date)) continue;
      added.r3a += insA.run(r.date, r.ticker, r.entry_price_a, r.hh_a, r.ll_a, r.atr14,
        r.up_r_a, r.down_r_a, r.captured_at).changes;
    }
    const insB = db.prepare(
      'INSERT OR IGNORE INTO r3b (date, ticker, entry_price_b, hh_b, ll_b, atr14, up_r_b, down_r_b, captured_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
    for (const r of r3b) {
      if (!wanted.has(r.date)) continue;
      added.r3b += insB.run(r.date, r.ticker, r.entry_price_b, r.hh_b, r.ll_b, r.atr14,
        r.up_r_b, r.down_r_b, r.captured_at).changes;
    }
  })();

  return { backupDate, dates, added };
}

// ─── Status ───────────────────────────────────────────────────────────────────

function getBackupStatus() {
  const lastRow = db.prepare("SELECT value FROM settings WHERE key = 'lastBackupAt'").get();
  const tokenRow = db.prepare("SELECT value FROM settings WHERE key = 'githubBackupToken'").get();
  return {
    lastBackupAt: lastRow ? lastRow.value : null,
    tokenConfigured: !!(tokenRow && tokenRow.value),
    repo: BACKUP_REPO,
  };
}

module.exports = { pushBackup, restoreBackup, mergeDatesFromBackup, getBackupStatus,
                   exportDb, backupDir, getGithubToken };
