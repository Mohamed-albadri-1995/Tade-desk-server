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
git checkout "$BRANCH"
git reset --hard "origin/$BRANCH"
echo "  now at: $(git log --oneline -1)"

echo
echo "[2/6] Dependencies..."
npm install --silent
pip3 install -r src/scoring/requirements.txt --quiet

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
  for p in "$port" "$sport"; do
    lsof -t -i:"$p" 2>/dev/null | xargs -r kill -9 2>/dev/null || true
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
  pm2 start src/scoring/server.py --name "scorer-${id}" --interpreter python3 \
    -- --output "$out" --port "$sport" >/dev/null

  TOOL_ID="$id" TOOL_NAME="$name" PORT="$port" \
  DB_PATH="$db" MODEL_OUTPUT_ROOT="$out" TMP_DIR="$tmp" \
  SCORER_URL="http://127.0.0.1:${sport}" \
    pm2 start src/index.js --name "tool-${id}" --update-env >/dev/null
done
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
