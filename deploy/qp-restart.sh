#!/bin/bash
# Make the running qp the one in this checkout — through pm2, and ONLY pm2.
#
#   bash deploy/qp-restart.sh <want-sha> [force]
#
# Called by deploy-tools.sh step [6b/6]. It used to restart qp with
#
#     sudo systemctl restart qp-chart
#
# which is the exact thing that caused 113,854 restarts on 2026-09-23: systemd's
# copy held :8765 and pm2's copy crash-looped against it. qp-chart was disabled
# that day and qp moved to pm2 (deploy/qp.config.js) — but a DISABLED unit is
# still listed by `systemctl list-unit-files`, so the deploy found it and would
# have started it again on the first stale deploy. Two supervisors, one port.
#
# So this never starts systemd's copy. If it finds it enabled or running, it
# turns it off first and says so, because that is the one state in which a
# pm2 restart cannot work.
#
# Never fatal: the deploy has already started the screeners, and a qp problem
# is a thing to read, not a reason to fail everything else.

WANT="${1:-}"
FORCE="${2:-}"
PORT="${QP_PORT:-8765}"
WAIT="${QP_WAIT:-90}"            # qp itself waits up to 60 s for its port
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

build() {
  curl -s --max-time 4 "http://127.0.0.1:${PORT}/api/health" 2>/dev/null \
    | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{
        try{process.stdout.write(String(JSON.parse(s).build||''))}catch{process.stdout.write('')}});" \
    2>/dev/null
}

RUNNING=$(build)
if [ -n "$RUNNING" ] && [ "$RUNNING" = "$WANT" ] && [ -z "$FORCE" ]; then
  echo "  OK — running ${RUNNING}, which is this checkout"
  exit 0
fi
if [ -z "$RUNNING" ]; then
  echo "  not answering on :${PORT} — the manager cannot evaluate exit rules"
  echo "  or move trailing stops without it."
elif [ -n "$FORCE" ]; then
  echo "  RESTART NEEDED — its .env changed (running ${RUNNING}, checkout ${WANT})"
else
  echo "  STALE — running ${RUNNING}, this checkout is ${WANT}"
fi

# THE SECOND SUPERVISOR. Off before anything else, or the restart below is
# one of two processes fighting for :8765.
if systemctl is-enabled --quiet qp-chart 2>/dev/null \
   || systemctl is-active --quiet qp-chart 2>/dev/null; then
  echo "  !! systemd's qp-chart is enabled or running — that is the 09-23 restart"
  echo "     loop (two supervisors, one port). Turning it off:"
  sudo systemctl disable --now qp-chart 2>/dev/null \
    && echo "     qp-chart disabled and stopped" \
    || echo "     COULD NOT — run by hand: sudo systemctl disable --now qp-chart"
fi

if pm2 describe qp >/dev/null 2>&1; then
  echo "  restarting qp (pm2)…"
  pm2 restart qp --update-env >/dev/null 2>&1 || echo "  pm2 could not restart qp"
else
  echo "  qp is not in pm2 — starting it from deploy/qp.config.js"
  if pm2 start "$HERE/qp.config.js" >/dev/null 2>&1; then
    pm2 save >/dev/null 2>&1 || true
  else
    echo "  could not start it — see deploy/README.md"
  fi
fi

AFTER=""
for _ in $(seq 1 "$WAIT"); do
  AFTER=$(build)
  [ -n "$AFTER" ] && [ "$AFTER" = "$WANT" ] && break
  sleep 1
done
if [ -n "$AFTER" ] && [ "$AFTER" = "$WANT" ]; then
  echo "  now running ${AFTER}"
else
  echo "  STILL ${AFTER:-not answering} — the manager will keep failing. Look at:"
  echo "    pm2 logs qp --lines 50"
fi
exit 0
