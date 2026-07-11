#!/usr/bin/env bash
# Install the Trade Desk stack as systemd services so the WHOLE thing
# auto-starts on boot and auto-restarts on crash — no more hand-launching or
# OOM cascades taking everything down.
#
# This installs the three services that live in THIS repo:
#   trade-scorer.service    3001  Flask live scorer      (src/scoring/server.py)
#   trade-screener.service  3000  Node/Express screener  (src/index.js)
#   qp-chart.service        8765  FastAPI chart platform (quant-platform/chart)
# plus a grouping target `trade-desk-stack.target` that also pulls in the
# trading tool's own `trade-desk.service` (8000) if it's installed (that unit
# ships with the trading-tool clone — run ITS deploy/install-service.sh once).
#
# The screener + scorer read their keys from the shell environment (no dotenv),
# which a systemd service does NOT inherit — so on first run this snapshots the
# keys currently exported in YOUR shell into ~/trade-desk.env and points every
# unit at it. Run it from the same shell where the services already work.
#
#   bash deploy/install-stack.sh
#
# Override ports/paths with env vars, e.g. CHART_PORT=8766 bash deploy/install-stack.sh
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PYBIN="$(command -v python3)"
NODEBIN="$(command -v node || true)"
ENVFILE="$HOME/trade-desk.env"
SCORER_PORT="${SCORER_PORT:-3001}"
SCREENER_PORT="${SCREENER_PORT:-3000}"
CHART_PORT="${CHART_PORT:-8765}"

echo "→ repo=$REPO  python=$PYBIN  node=${NODEBIN:-<none>}"
[ -n "$NODEBIN" ] || { echo "!! node not found in PATH (needed for the screener). Install node, then re-run."; exit 1; }

# ── 1) shared env file: snapshot the keys currently exported in this shell ──
KEYS=(FINNHUB_API_KEY GITHUB_BACKUP_TOKEN POLYGON_API_KEY APCA_API_KEY_ID
      APCA_API_SECRET_KEY APCA_API_BASE_URL ALPACA_API_KEY ALPACA_SECRET_KEY
      SCORER_URL SCREENER_URL)
if [ ! -f "$ENVFILE" ]; then
  ( umask 077; : > "$ENVFILE" )
  for k in "${KEYS[@]}"; do
    v="$(printenv "$k" 2>/dev/null || true)"
    [ -n "${v:-}" ] && printf '%s=%s\n' "$k" "$v" >> "$ENVFILE"
  done
  got="$(cut -d= -f1 "$ENVFILE" 2>/dev/null | tr '\n' ' ')"
  echo "→ wrote $ENVFILE  (captured: ${got:-<none — see note below>})"
  [ -s "$ENVFILE" ] || echo "   ⚠ no keys were exported in this shell; if a feed shows 'no key', add lines to $ENVFILE (KEY=value) and: sudo systemctl restart trade-screener qp-chart"
else
  echo "→ $ENVFILE already exists — leaving it as-is"
fi

# ── 2) warn if a pm2 daemon still owns the ports (would fight systemd) ──
if command -v pm2 >/dev/null 2>&1 && pm2 pid >/dev/null 2>&1; then
  if [ -n "$(pm2 jlist 2>/dev/null | tr -d '[]')" ]; then
    echo "   ⚠ pm2 has running apps. If a service below fails to bind its port, run: pm2 delete all && pm2 kill"
  fi
fi

# ── 3) scorer (3001) ──
sudo tee /etc/systemd/system/trade-scorer.service >/dev/null <<UNIT
[Unit]
Description=Trade Desk scorer (Flask live scoring)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$USER
WorkingDirectory=$REPO/src/scoring
EnvironmentFile=-$ENVFILE
ExecStart=$PYBIN server.py --port $SCORER_PORT
Restart=always
RestartSec=5
MemoryHigh=350M
StandardOutput=append:$HOME/scorer.log
StandardError=append:$HOME/scorer.log

[Install]
WantedBy=multi-user.target
UNIT

# ── 4) screener (3000) — starts after the scorer it calls ──
sudo tee /etc/systemd/system/trade-screener.service >/dev/null <<UNIT
[Unit]
Description=Trade Desk screener (Node/Express)
After=network-online.target trade-scorer.service
Wants=network-online.target

[Service]
Type=simple
User=$USER
WorkingDirectory=$REPO
EnvironmentFile=-$ENVFILE
Environment=PORT=$SCREENER_PORT
ExecStart=$NODEBIN src/index.js
Restart=always
RestartSec=5
MemoryHigh=300M
StandardOutput=append:$HOME/screener.log
StandardError=append:$HOME/screener.log

[Install]
WantedBy=multi-user.target
UNIT

# ── 5) chart (8765) — client of the screener ──
sudo tee /etc/systemd/system/qp-chart.service >/dev/null <<UNIT
[Unit]
Description=qp charting platform (real-time chart + screener navigation)
After=network-online.target trade-screener.service
Wants=network-online.target

[Service]
Type=simple
User=$USER
WorkingDirectory=$REPO/quant-platform
EnvironmentFile=-$ENVFILE
ExecStart=$PYBIN -m chart.server --host 0.0.0.0 --port $CHART_PORT
Restart=always
RestartSec=5
MemoryHigh=600M
StandardOutput=append:$HOME/chart.log
StandardError=append:$HOME/chart.log

[Install]
WantedBy=multi-user.target
UNIT

# ── 6) grouping target for the whole stack (incl. the trading tool's unit) ──
sudo tee /etc/systemd/system/trade-desk-stack.target >/dev/null <<UNIT
[Unit]
Description=Trade Desk full stack (screener + scorer + chart + trading tool)
Wants=trade-scorer.service trade-screener.service qp-chart.service trade-desk.service
After=trade-scorer.service trade-screener.service qp-chart.service trade-desk.service

[Install]
WantedBy=multi-user.target
UNIT

# ── 7) hand the ports over from any manual instances ──
pkill -f "chart.server"          2>/dev/null || true
pkill -f "src/scoring/server.py" 2>/dev/null || true
pkill -f "node src/index.js"     2>/dev/null || true
pkill -f "src/index.js"          2>/dev/null || true
sleep 2

sudo systemctl daemon-reload
sudo systemctl enable --now trade-scorer.service trade-screener.service qp-chart.service
sudo systemctl enable trade-desk-stack.target
sleep 4

echo "═══ stack status ══════════════════════════════════════"
for s in trade-scorer trade-screener qp-chart trade-desk; do
  state="$(systemctl is-active "$s" 2>/dev/null || true)"
  printf '  %-16s %s\n' "$s" "${state:-not-installed}"
done
echo "═══ listening ports ═══════════════════════════════════"
ss -ltnp 2>/dev/null | grep -E ":(${SCORER_PORT}|${SCREENER_PORT}|${CHART_PORT}|8000)\b" || echo "  (none yet — check the logs)"
echo "═══ chart feeds ═══════════════════════════════════════"
sleep 1; curl -s "http://127.0.0.1:${CHART_PORT}/api/health" || true; echo
cat <<EOF

Done. The three in-repo services are now managed + auto-start on boot.
Trading tool (8000): run its OWN installer once, from its clone:
    cd ~/tade-desk-server && bash deploy/install-service.sh
It installs trade-desk.service, which this stack target already pulls in.

Manage the whole stack:
    sudo systemctl restart trade-desk-stack.target   # bounce everything
    systemctl status trade-scorer trade-screener qp-chart trade-desk
    tail -f ~/screener.log ~/scorer.log ~/chart.log
After any git pull, restart just what changed, e.g.:
    sudo systemctl restart qp-chart
EOF
