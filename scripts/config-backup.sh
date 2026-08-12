#!/usr/bin/env bash
#
# Back up the settings you clicked in, so an update or a dead box does not mean
# rebuilding them from memory.
#
# The daily GitHub backup exports each tool's DATABASE. None of these settings
# live in a database — the alerts app keeps them as JSON files in data/, which
# is gitignored, so `git reset --hard` never touches them (settings DO survive a
# deploy) and nothing has ever copied them anywhere either. One dead instance
# and the risk figures, the rank metric, the top-N and every alert rule are
# gone, with nothing to say what they were.
#
# WHAT IS AND IS NOT SENT
#
# Sent: risk.json, setup-prefs.json, alert-rules.json — configuration, no
# credentials.
#
# NEVER sent: broker.json (holds the SignalStack hook, which IS the ability to
# place orders in your account), push-keys.json (the VAPID private key),
# keys.json (API keys), push-subs.json (per-device push tokens). A backup repo
# is still a repo; a secret pushed to one has been published, whatever its
# visibility says today.
#
# The bundle is scanned before it leaves, and the push is refused if anything
# in it looks like a credential — belt as well as braces, because the cost of
# being wrong is not a lost setting but a live account.
#
#     bash scripts/config-backup.sh          # push
#     bash scripts/config-restore.sh         # bring them back
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"

node - "$REPO" <<'JS'
const fs = require('fs');
const path = require('path');
const repo = process.argv[2];
const dir = path.join(repo, 'data');

// Configuration only. Anything holding a credential is absent BY NAME, not by
// being filtered later — a list of what to include cannot leak by accident the
// way a list of what to exclude can.
const SAFE = ['risk.json', 'setup-prefs.json', 'alert-rules.json'];

const bundle = { version: '1', exportedAt: new Date().toISOString(), files: {} };
for (const name of SAFE) {
  const p = path.join(dir, name);
  if (!fs.existsSync(p)) { console.log(`  (${name} — not present, skipped)`); continue; }
  try {
    bundle.files[name] = JSON.parse(fs.readFileSync(p, 'utf8'));
    console.log(`  ${name}`);
  } catch (e) {
    console.error(`  ${name} — unreadable (${e.message}); refusing to push a partial bundle`);
    process.exit(1);
  }
}
if (!Object.keys(bundle.files).length) {
  console.error('nothing to back up — no settings files found in data/');
  process.exit(1);
}

/*
 * The scan. Not a substitute for the allow-list above; a second chance to
 * notice that something now carries a secret it did not carry when the
 * allow-list was written.
 */
const text = JSON.stringify(bundle);
const SMELLS = [
  [/ghp_[A-Za-z0-9]{20,}/, 'a GitHub token'],
  [/github_pat_[A-Za-z0-9_]{20,}/, 'a GitHub token'],
  [/signalstack\.com\/hook\//i, 'a SignalStack webhook'],
  [/\bAK[A-Z0-9]{16,}\b/, 'an Alpaca key'],
  [/"[A-Za-z0-9_-]{60,}"/, 'a long opaque string that looks like a key'],
];
for (const [re, what] of SMELLS) {
  if (re.test(text)) {
    console.error(`REFUSED: the bundle contains ${what}. Nothing was pushed.`);
    process.exit(1);
  }
}

process.env.TOOL_ID = process.env.TOOL_ID || 'T1';
const backup = require(path.join(repo, 'src', 'backup'));
const token = backup.getGithubToken();
if (!token) {
  console.error('No GitHub backup token. Run scripts/share-backup-token.sh first.');
  process.exit(1);
}

const payload = JSON.stringify(bundle, null, 2);
const date = new Date().toISOString().slice(0, 10);
const msg = `Settings ${date} — alerts app configuration`;
(async () => {
  // Sequential: both commit to the same branch, and two concurrent Contents-API
  // writes race on the branch HEAD.
  await backup.pushFile(token, `config/${date}.json`, payload, msg);
  await backup.pushFile(token, 'config/latest.json', payload, msg);
  console.log(`\npushed ${Object.keys(bundle.files).length} file(s) to config/${date}.json and config/latest.json`);
})().catch(e => { console.error('push failed:', e.message); process.exit(1); });
JS
