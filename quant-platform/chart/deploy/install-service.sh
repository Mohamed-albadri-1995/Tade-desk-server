#!/usr/bin/env bash
# Install the qp charting platform as a systemd service so it auto-starts on
# boot and auto-restarts if it ever crashes. Idempotent — safe to re-run
# (e.g. after changing the port). Run as the user that owns the repo:
#
#     bash chart/deploy/install-service.sh            # default port 8765
#     PORT=8766 bash chart/deploy/install-service.sh  # custom port
#
# It bakes in the exact python + user + paths of whoever runs it, so it works
# regardless of where the repo lives or which python has the deps installed.
set -euo pipefail

PORT="${PORT:-8765}"
SVC="qp-chart"
PYBIN="$(command -v python3)"
# quant-platform root = two levels up from this script (chart/deploy/..)
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LOG="$HOME/chart.log"

echo "→ user=$USER  python=$PYBIN  app_dir=$APP_DIR  port=$PORT"
"$PYBIN" -c 'import fastapi, uvicorn, websockets' \
  || { echo "!! $PYBIN is missing fastapi/uvicorn/websockets — run: $PYBIN -m pip install -r requirements.txt"; exit 1; }

sudo tee "/etc/systemd/system/${SVC}.service" > /dev/null <<UNIT
[Unit]
Description=qp charting platform (real-time chart + screener navigation)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$USER
WorkingDirectory=$APP_DIR
ExecStart=$PYBIN -m chart.server --host 0.0.0.0 --port $PORT
Restart=always
RestartSec=5
# Small host: throttle this service (push to swap) before it can starve the
# screener. Soft limit — reclaims memory, does not hard-kill the process.
MemoryHigh=600M
StandardOutput=append:$LOG
StandardError=append:$LOG

[Install]
WantedBy=multi-user.target
UNIT

# Hand the port over from any manually-launched instance to systemd.
pkill -f "chart.server" 2>/dev/null || true
sleep 2

sudo systemctl daemon-reload
sudo systemctl enable --now "${SVC}"
sleep 3

echo "─── status ──────────────────────────────────────────"
systemctl --no-pager -l status "${SVC}" | head -12 || true
echo "─── listening ───────────────────────────────────────"
ss -ltnp 2>/dev/null | grep ":${PORT}" || echo "  (not listening yet — check: journalctl -u ${SVC} -n 40)"
echo "─── feeds ───────────────────────────────────────────"
sleep 1
curl -s "http://127.0.0.1:${PORT}/api/health" || true
echo
echo "Done. Manage with:  sudo systemctl {restart,stop,status} ${SVC}"
echo "Logs:               tail -f $LOG   (or: journalctl -u ${SVC} -f)"
echo "After a git pull:   sudo systemctl restart ${SVC}"
