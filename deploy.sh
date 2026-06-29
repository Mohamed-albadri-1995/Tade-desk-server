#!/bin/bash
set -e
echo "=== Trade Desk Deploy ==="

cd ~/Tade-desk-server

echo "[1/5] Stopping all PM2 processes..."
pm2 delete all 2>/dev/null || true

echo "[2/5] Pulling latest code..."
git fetch origin
git checkout claude/test-9d4txv
git reset --hard origin/claude/test-9d4txv

echo "[3/5] Installing dependencies..."
npm install --allow-scripts

echo "[4/5] Starting server..."
pm2 start src/index.js --name trade-desk
pm2 save

echo "[5/5] Testing..."
sleep 2
curl -s http://localhost:3000/health

echo ""
echo "=== Done. Server is running on port 3000 ==="
