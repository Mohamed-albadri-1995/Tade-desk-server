#!/usr/bin/env bash
#
# Back up every tool now, instead of waiting for 17:30.
#
# Each tool exports its OWN database to its own folder in the backup repo, so
# this is nine independent pushes and one failing does not stop the rest.
#
# A backup file is not a day — it is the WHOLE history of that tool's tables as
# of the moment it was written (exportDb selects every row, unfiltered by
# date). So days with no backup file are missing snapshots, not missing data:
# one push now captures everything those days would have held.
#
#     bash scripts/backup-all-tools.sh
#
# The token comes from data/keys.json (githubBackupToken), shared by all nine.
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORTS=$(node -e "
  const t=require('$REPO/tools.config.json').tools;
  process.stdout.write(t.map(x=>x.id+':'+x.port).join(' '))")

ok=0; bad=0
for entry in $PORTS; do
  id="${entry%%:*}"; port="${entry##*:}"
  printf '%-4s ' "$id"
  body=$(curl -sS -m 120 -X POST "localhost:$port/api/backup/push" 2>&1)
  if printf '%s' "$body" | grep -q '"ok":true'; then
    echo "→ $(printf '%s' "$body" | node -e "
      let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{
        try{const j=JSON.parse(s);console.log(j.date||'pushed', j.exportedAt||'')}
        catch{console.log('pushed')}})")"
    ok=$((ok+1))
  else
    echo "→ FAILED: $(printf '%s' "$body" | head -c 160)"
    bad=$((bad+1))
  fi
done

echo
echo "$ok pushed, $bad failed."
[ "$bad" -gt 0 ] && echo "A failure is usually a missing token: put githubBackupToken in data/keys.json."
exit 0
