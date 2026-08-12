#!/usr/bin/env bash
#
# Put the settings back, from the bundle scripts/config-backup.sh pushed.
#
#     bash scripts/config-restore.sh              # what would change (default)
#     bash scripts/config-restore.sh --write      # actually write
#     bash scripts/config-restore.sh --write 2026-08-12    # a specific day
#
# Reads by default and writes only when told to. A restore is the one operation
# run in a hurry, on a box that is already wrong, and "it overwrote the settings
# I still had" is a worse morning than the one that prompted it.
#
# Existing files are copied aside as <name>.before-restore before anything is
# written, so an unwanted restore is undone by renaming rather than by
# remembering.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"

WRITE=0
DAY=""
for a in "$@"; do
  case "$a" in
    --write) WRITE=1 ;;
    *) DAY="$a" ;;
  esac
done

node - "$REPO" "$WRITE" "$DAY" <<'JS'
const fs = require('fs');
const path = require('path');
const [repo, writeFlag, day] = process.argv.slice(2);
const write = writeFlag === '1';
const dir = path.join(repo, 'data');

process.env.TOOL_ID = process.env.TOOL_ID || 'T1';
const backup = require(path.join(repo, 'src', 'backup'));
const token = backup.getGithubToken();
if (!token) {
  console.error('No GitHub backup token. Run scripts/share-backup-token.sh first.');
  process.exit(1);
}

const file = day ? `config/${day}.json` : 'config/latest.json';
(async () => {
  const raw = await backup.fetchFile(token, file);
  if (!raw) { console.error(`nothing stored at ${file}`); process.exit(1); }
  const bundle = JSON.parse(raw);
  console.log(`${file} — exported ${bundle.exportedAt}\n`);

  for (const [name, content] of Object.entries(bundle.files || {})) {
    const target = path.join(dir, name);
    const now = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : null;
    const next = JSON.stringify(content, null, 2) + '\n';
    if (now !== null && now.trim() === next.trim()) {
      console.log(`  ${name} — already identical`);
      continue;
    }
    console.log(`  ${name} — ${now === null ? 'MISSING here, would be created'
                                             : 'DIFFERS, would be replaced'}`);
    if (!write) continue;
    if (now !== null) {
      fs.copyFileSync(target, target + '.before-restore');
      console.log(`      kept the current one as ${name}.before-restore`);
    }
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(target, next);
    console.log('      written');
  }

  console.log(write
    ? '\nDone. The tools re-read these files as they work — restart to be certain:\n  pm2 restart alerts'
    : '\nThis was a DRY RUN. Nothing was written. Add --write to apply.');
})().catch(e => { console.error('restore failed:', e.message); process.exit(1); });
JS
