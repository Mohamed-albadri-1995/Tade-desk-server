#!/bin/bash
set -e

# Branch to deploy. Override for a one-off:  BRANCH=some/branch ./deploy.sh
BRANCH="${BRANCH:-claude/catalyst-assigning-algorithm-c78g7y}"

echo "=== Trade Desk Deploy ==="
echo "Branch: $BRANCH"

cd ~/Tade-desk-server

echo "[1/7] Stopping all PM2 processes..."
pm2 delete all 2>/dev/null || true

echo "[2/7] Making sure nothing else holds the service ports..."
# A leftover systemd unit competing with PM2 for 3001 caused every retrain to be
# answered by a stale process while PM2's scorer crash-looped. Stop those units
# if they exist, then clear anything still bound to the ports.
for unit in trade-scorer trade-screener trade-desk; do
  if systemctl list-unit-files 2>/dev/null | grep -q "^${unit}.service"; then
    echo "  disabling systemd unit: ${unit}"
    sudo systemctl stop "$unit" 2>/dev/null || true
    sudo systemctl disable "$unit" 2>/dev/null || true
  fi
done
for port in 3000 3001; do
  lsof -t -i:"$port" 2>/dev/null | xargs -r kill -9 2>/dev/null || true
done

echo "[3/7] Pulling latest code..."
git fetch origin "$BRANCH"
git checkout "$BRANCH"
git reset --hard "origin/$BRANCH"
echo "  now at: $(git log --oneline -1)"

echo "[4/7] Installing Node dependencies..."
npm install

echo "[5/7] Installing Python dependencies..."
pip3 install -r src/scoring/requirements.txt --quiet

echo "[6/7] Starting processes..."
pm2 start src/index.js --name trade-desk
pm2 start src/scoring/server.py --name scorer --interpreter python3
pm2 save

echo "[7/7] Health checks..."
sleep 4
echo -n "Node:   " && curl -s http://localhost:3000/health \
  | python3 -c "import sys,json; d=json.load(sys.stdin); print('OK' if d.get('ok') else 'FAIL')" 2>/dev/null || echo "FAIL"
echo -n "Scorer: " && curl -s http://127.0.0.1:3001/health | python3 -c "
import sys, json
d = json.load(sys.stdin)
print('Online, model=' + ('ready' if d.get('ready') else 'not trained')
      + ', pid=' + str(d.get('pid'))
      + ', buckets=' + str(d.get('n_buckets'))
      + (', WARNING: running outdated training code' if d.get('code_stale') else ''))
" 2>/dev/null || echo "FAIL"

echo ""
echo "=== Done ==="
