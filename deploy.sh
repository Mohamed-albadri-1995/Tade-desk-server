#!/bin/bash
set -e
echo "=== Trade Desk Deploy ==="

cd ~/Tade-desk-server

echo "[1/6] Stopping all PM2 processes..."
pm2 delete all 2>/dev/null || true
# Free port 3001 in case scorer process lingered after PM2 delete
lsof -t -i:3001 | xargs -r kill -9 2>/dev/null || true

echo "[2/6] Pulling latest code..."
git fetch origin
git checkout claude/test-9d4txv
git reset --hard origin/claude/test-9d4txv

echo "[3/6] Installing Node dependencies..."
npm install

echo "[4/6] Installing Python dependencies..."
pip3 install -r src/scoring/requirements.txt --quiet

echo "[5/6] Starting processes..."
pm2 start src/index.js --name trade-desk
pm2 start src/scoring/server.py --name scorer --interpreter python3
pm2 save

echo "[6/6] Health checks..."
sleep 3
echo -n "Node:   " && curl -s http://localhost:3000/health | python3 -c "import sys,json; d=json.load(sys.stdin); print('OK' if d.get('ok') else 'FAIL')" 2>/dev/null || echo "FAIL"
echo -n "Scorer: " && curl -s http://127.0.0.1:3001/health | python3 -c "import sys,json; d=json.load(sys.stdin); print('Online, model=' + ('ready' if d.get('ready') else 'not trained'))" 2>/dev/null || echo "FAIL"

echo ""
echo "=== Done ==="
