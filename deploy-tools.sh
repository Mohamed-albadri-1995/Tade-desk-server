#!/bin/bash
set -e

# Deploy all three tools. Each is a full copy of the screener with its own
# database, screeners, registers, shortlist, model and training history —
# nothing is shared, so one tool cannot affect another.
#
#   ./deploy-tools.sh            deploy every tool
#   ./deploy-tools.sh T2         deploy just one
#   BRANCH=some/branch ./deploy-tools.sh

BRANCH="${BRANCH:-claude/multi-tool-screeners}"
ONLY="${1:-}"
ROOT=~/Tade-desk-server

# Tools come from tools.config.json — the single registry the landing page and
# the app also read, so adding a tool means editing that file alone.
mapfile -t TOOLS < <(node -e "
  const t = require('./tools.config.json').tools;
  t.forEach(x => console.log([x.id, x.name, x.port, x.scorerPort].join('|')));
")
if [ ${#TOOLS[@]} -eq 0 ]; then
  echo "No tools found in tools.config.json"; exit 1
fi
echo "Tools: ${#TOOLS[@]}"

echo "=== Trade Desk — multi-tool deploy ==="
echo "Branch: $BRANCH"
[ -n "$ONLY" ] && echo "Only:   $ONLY"

cd "$ROOT"

echo
echo "[1/6] Pulling latest code..."
git fetch origin "$BRANCH"

# This repository holds more than the screener — quant-platform/ is a separate
# tool living in the same tree. `git reset --hard` does not know that: it
# rewrites EVERY tracked file to match the branch, so deploying the screener
# from a branch whose quant-platform is older silently reverts that tool.
#
# That is not hypothetical; it is what this guard was written for. Check before
# destroying anything, and say exactly what would be lost.
NEIGHBOURS="quant-platform"
for dir in $NEIGHBOURS; do
  [ -e "$dir" ] || continue

  # Only what `git reset --hard` would actually destroy: tracked files that
  # differ from the index or HEAD. Untracked files ("??") survive a hard reset
  # untouched, so stopping for a stray log file would be a false alarm — and a
  # guard that cries wolf is one that gets worked around.
  dirty=$(git status --porcelain -- "$dir" | grep -v '^??' || true)
  if [ -n "$dirty" ]; then
    echo
    echo "  STOPPED: you have uncommitted changes in $dir/ that this deploy would destroy:"
    echo "$dirty" | sed 's/^/     /'
    echo
    echo "  Commit or stash them first:  git add $dir && git commit -m 'wip'"
    exit 1
  fi

  behind=$(git log --oneline "origin/$BRANCH..HEAD" -- "$dir" 2>/dev/null)
  if [ -n "$behind" ]; then
    echo
    echo "  STOPPED: $dir/ here is AHEAD of origin/$BRANCH. Resetting would lose:"
    echo "$behind" | sed 's/^/     /'
    echo
    echo "  Push those commits, or merge them into $BRANCH, before deploying."
    exit 1
  fi
done

git checkout "$BRANCH"
git reset --hard "origin/$BRANCH"
echo "  now at: $(git log --oneline -1)"
for dir in $NEIGHBOURS; do
  [ -e "$dir" ] && echo "  $dir/ at: $(git log -1 --format='%h %s' -- "$dir")"
done

echo
echo "[2/6] Dependencies..."
npm install --silent

# Python dependencies go in a virtualenv belonging to this project, NOT into the
# shared user environment.
#
# `pip3 install -r requirements.txt` writes to the site-packages every Python
# program on this box shares. requirements.txt asks for pandas, numpy,
# scikit-learn and flask with ">=" bounds, so pip is free to move those versions
# to satisfy this project — and anything else on the machine that depended on
# the versions that were there silently gets different ones. That is a deploy of
# the screener changing an unrelated tool underneath it.
#
# The virtualenv is created with --system-site-packages, which matters on a box
# this size. Without it, pip downloads and installs its own pandas, numpy and
# scikit-learn — around 150MB of wheels, and minutes of thrashing on a machine
# with under a gigabyte of RAM. With it, packages already present are visible
# and count as satisfied, so a deploy usually installs nothing at all.
#
# It still fixes the bug: pip can READ the shared packages but every install it
# does goes into .venv, so a screener deploy can no longer change the versions
# another program on this machine depends on.
VENV="$ROOT/.venv"
PY="$VENV/bin/python"
if [ ! -x "$PY" ]; then
  echo "  creating Python virtualenv at .venv (reusing packages already installed)"
  python3 -m venv --system-site-packages "$VENV" 2>/dev/null || true
fi
if [ -x "$PY" ]; then
  echo "  checking Python packages (nothing to download if they are already present)…"
  "$PY" -m pip install -r src/scoring/requirements.txt --quiet --disable-pip-version-check
  echo "  python: $("$PY" --version 2>&1) — installs isolated to .venv"
else
  echo "  WARNING: could not create a virtualenv — falling back to the shared"
  echo "           Python environment. This can change package versions for"
  echo "           other programs on this machine. Install python3-venv to fix."
  PY=python3
  pip3 install -r src/scoring/requirements.txt --quiet
fi

echo
echo "[3/6] Clearing anything holding the tool ports..."
# A leftover systemd unit competing with PM2 once caused every retrain to be
# answered by a stale process while PM2's scorer crash-looped.
for unit in trade-scorer trade-screener trade-desk; do
  if systemctl list-unit-files 2>/dev/null | grep -q "^${unit}.service"; then
    sudo systemctl stop "$unit" 2>/dev/null || true
    sudo systemctl disable "$unit" 2>/dev/null || true
  fi
done

echo
echo "[4/6] Stopping existing PM2 processes..."
for entry in "${TOOLS[@]}"; do
  IFS='|' read -r id name port sport <<< "$entry"
  [ -n "$ONLY" ] && [ "$ONLY" != "$id" ] && continue
  pm2 delete "tool-${id}" 2>/dev/null || true
  pm2 delete "scorer-${id}" 2>/dev/null || true
  # Free the port, but only from OUR processes. This loop used to kill whatever
  # held the port, no questions asked — so anything else on this machine that
  # happened to listen on 3000–3081 was killed by a screener deploy. A port
  # number is not proof of ownership.
  for p in "$port" "$sport"; do
    for pid in $(lsof -t -i:"$p" 2>/dev/null); do
      cmd=$(tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null || echo '')
      cwd=$(readlink -f "/proc/$pid/cwd" 2>/dev/null || echo '')
      case "$cmd$cwd" in
        *"$ROOT"*) kill -9 "$pid" 2>/dev/null || true ;;
        *) echo "  NOT killing pid $pid on port $p — it is not ours:"
           echo "     ${cmd:0:100}" ;;
      esac
    done
  done
done
# T1 kept the original process names before tools existed.
if [ -z "$ONLY" ] || [ "$ONLY" = "T1" ]; then
  pm2 delete trade-desk 2>/dev/null || true
  pm2 delete scorer 2>/dev/null || true
fi

echo
echo "[5/6] Starting tools..."
mkdir -p data
for entry in "${TOOLS[@]}"; do
  IFS='|' read -r id name port sport <<< "$entry"
  [ -n "$ONLY" ] && [ "$ONLY" != "$id" ] && continue

  # T1 keeps the original paths so its existing history is picked up untouched.
  if [ "$id" = "T1" ]; then
    db="$ROOT/data/tradedesk.db"; out="$ROOT/src/scoring/outputs"; tmp="$ROOT/tmp"
  else
    lc=$(echo "$id" | tr 'A-Z' 'a-z')
    db="$ROOT/data/${lc}.db"; out="$ROOT/src/scoring/outputs-${lc}"; tmp="$ROOT/tmp-${lc}"
  fi
  mkdir -p "$out" "$tmp"

  echo "  ${id} (${name}) — app :${port}  scorer :${sport}"
  pm2 start src/scoring/server.py --name "scorer-${id}" --interpreter "$PY" \
    -- --output "$out" --port "$sport" >/dev/null

  TOOL_ID="$id" TOOL_NAME="$name" PORT="$port" \
  DB_PATH="$db" MODEL_OUTPUT_ROOT="$out" TMP_DIR="$tmp" \
  SCORER_URL="http://127.0.0.1:${sport}" \
    pm2 start src/index.js --name "tool-${id}" --update-env >/dev/null
done
# pm2 save rewrites the startup list from whatever is running RIGHT NOW, so a
# process that happened to be stopped at this moment would be dropped from it
# and would not come back after a reboot. Say what is being saved.
echo
echo "  saving pm2 process list ($(pm2 jlist 2>/dev/null | node -e "
  let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{
    try{const j=JSON.parse(s);console.log(j.map(p=>p.name).join(', '))}catch{console.log('?')}
  });" 2>/dev/null || echo '?'))"
pm2 save >/dev/null

echo
echo "[6/6] Health checks..."

# Poll rather than sleep-and-hope. Every scorer imports pandas and sklearn at
# startup, which takes a couple of seconds on its own; seven of them booting at
# once contend for CPU and take considerably longer. A single check after a flat
# five seconds reported FAIL for scorers that were fine moments later — and
# always for the first tools in the list, because those are checked while the
# contention is at its worst. Waiting for all of them before reporting anything
# means the verdict describes the deploy rather than the order of the loop.
wait_up() {  # wait_up <url> <attempts>
  local url="$1" tries="${2:-20}"
  for _ in $(seq 1 "$tries"); do
    curl -s --max-time 3 "$url" >/dev/null 2>&1 && return 0
    sleep 2
  done
  return 1
}

printf "  waiting for %s process(es) to come up" "$(( ${#TOOLS[@]} * 2 ))"
for entry in "${TOOLS[@]}"; do
  IFS='|' read -r id name port sport <<< "$entry"
  [ -n "$ONLY" ] && [ "$ONLY" != "$id" ] && continue
  wait_up "http://localhost:${port}/health" >/dev/null 2>&1 || true
  wait_up "http://127.0.0.1:${sport}/health" >/dev/null 2>&1 || true
  printf "."
done
echo

for entry in "${TOOLS[@]}"; do
  IFS='|' read -r id name port sport <<< "$entry"
  [ -n "$ONLY" ] && [ "$ONLY" != "$id" ] && continue
  printf "  %-3s %-10s app: " "$id" "$name"
  curl -s --max-time 4 "http://localhost:${port}/health" >/dev/null 2>&1 && printf "OK   " || printf "FAIL "
  printf "scorer: "
  curl -s --max-time 4 "http://127.0.0.1:${sport}/health" 2>/dev/null | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    print(('ready' if d.get('ready') else 'not trained')
          + ', buckets=' + str(d.get('n_buckets'))
          + (', WARNING outdated code' if d.get('code_stale') else ''))
except Exception:
    print('FAIL')
" 2>/dev/null || echo "FAIL"
done

echo
IP=$(curl -s --max-time 3 ifconfig.me 2>/dev/null || echo localhost)
echo "Landing page: http://${IP}:3000/"
echo "=== Done ==="
