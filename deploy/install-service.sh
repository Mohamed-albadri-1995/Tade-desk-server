#!/usr/bin/env bash
# Installs the trading tool as a systemd service: starts on boot,
# restarts on crash, runs with no terminal or browser needed.
# Usage: sudo bash deploy/install-service.sh
set -euo pipefail

UNIT_SRC="$(cd "$(dirname "$0")" && pwd)/trade-desk.service"
UNIT_DST=/etc/systemd/system/trade-desk.service

cp "$UNIT_SRC" "$UNIT_DST"
systemctl daemon-reload
systemctl enable trade-desk
systemctl restart trade-desk
sleep 2
systemctl --no-pager --lines=5 status trade-desk
echo
echo "Done. Useful commands:"
echo "  sudo systemctl status trade-desk     # is it running?"
echo "  sudo journalctl -u trade-desk -f     # live logs"
echo "  sudo systemctl restart trade-desk    # restart (e.g. after git pull)"
