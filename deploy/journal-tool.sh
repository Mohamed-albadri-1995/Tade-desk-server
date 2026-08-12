#!/usr/bin/env bash
#
# Put the Journal back on the landing page, and nothing else with it.
#
# The journal was part of the app that ran everything on port 3000 before the
# nine-tool rewrite. That codebase still exists on branch claude/test-9d4txv —
# unrelated history to this repo, retired to ~/attic when the rewrite landed.
# The journal itself is self-contained (routes/journal.js, src/journal/*,
# public/journal.html) and touches no broker.
#
# THE APP AROUND IT DOES. Booting src/index.js from that branch starts a broker
# reconciler that polls Alpaca and can act on live positions, plus the scanner
# scheduler — against credentials in ~/attic/algo-tool.env that have not been
# revoked. So this does NOT start that app. It runs a launcher that mounts the
# journal routes and the page, and loads nothing else: no scheduler, no order
# router, no bar poller, no broker client anywhere in the require graph.
#
# Idempotent — safe to re-run. Run from the repo root:
#
#     bash deploy/journal-tool.sh
#
# Afterwards, open port 3100 in the AWS security group, the same way the tool
# ports were opened. Until then the tile is on the landing page and will not
# answer.
set -euo pipefail

PORT="${PORT:-3100}"
BRANCH="claude/test-9d4txv"
APP_DIR="${JOURNAL_DIR:-$HOME/journal-app}"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo "→ repo=$REPO  app=$APP_DIR  port=$PORT"

# ── the code, as a worktree ────────────────────────────────────────────────
# A worktree rather than a clone: it shares this repo's object store, so it
# costs no extra download and cannot drift to a different commit than the one
# named here. Detached on the remote branch — nothing here ever commits.
cd "$REPO"
git fetch origin "$BRANCH"
if [ -d "$APP_DIR/.git" ] || [ -f "$APP_DIR/.git" ]; then
  echo "→ worktree exists, updating"
  git -C "$APP_DIR" checkout --detach "origin/$BRANCH"
else
  git worktree add --detach "$APP_DIR" "origin/$BRANCH"
fi

# ── dependencies ───────────────────────────────────────────────────────────
# The two package.json files list the same seven dependencies at the same
# ranges, so the installed tree is reused rather than built again. better-sqlite3
# compiles from source; on a t3.micro that is minutes and can fail on memory.
if [ ! -e "$APP_DIR/node_modules" ]; then
  ln -s "$REPO/node_modules" "$APP_DIR/node_modules"
  echo "→ linked node_modules from the main app"
fi

# ── a database of its own ──────────────────────────────────────────────────
# src/db hardcodes data/tradedesk.db relative to the app, so an empty file here
# means empty tables, created on first boot by src/journal/db.js. The attic
# copies are NOT touched: if you later want the old trades, copy one in — the
# original stays where it is either way.
mkdir -p "$APP_DIR/data"
echo "→ database: $APP_DIR/data/tradedesk.db (fresh unless it already exists)"

# ── the launcher ───────────────────────────────────────────────────────────
cat > "$APP_DIR/journal-only.js" <<'JS'
/*
 * The journal, and nothing else.
 *
 * Written by deploy/journal-tool.sh — edit it there, not here.
 *
 * The point of this file is what it does NOT require. The app this code came
 * from starts a broker reconciler on boot that polls Alpaca and can act on
 * open positions; requiring src/routes/trading.js alone pulls in the order
 * router, the bar poller and the broker client. A page that lists past trades
 * has no business loading any of that, so the one endpoint it needs from that
 * router is reimplemented below as the plain SELECT it already was.
 */
const path = require('path');
const express = require('express');

const db = require('./src/db');          // creates data/tradedesk.db
require('./src/trading/db');             // schema only — no broker code

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// the journal proper: trades, imports, notes, fees, metrics, calendar
app.use('/api/journal', require('./src/routes/journal'));

/*
 * The setup list the page uses to label a trade. Six lines here instead of
 * mounting the trading router, which is the whole reason this launcher exists.
 * Empty is a fine answer — the page already falls back to [].
 */
app.get('/api/trading/setups', (req, res) => {
  try {
    const rows = db.prepare('SELECT * FROM trading_setups ORDER BY name').all();
    res.json(rows.map(r => ({ ...r, config: JSON.parse(r.config || '{}') })));
  } catch {
    res.json([]);
  }
});

app.get('/', (req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'journal.html')));

const PORT = process.env.PORT || 3100;
app.listen(PORT, () => console.log(`[journal] listening on ${PORT}`));
JS

# ── run it ─────────────────────────────────────────────────────────────────
cd "$APP_DIR"
pm2 delete journal >/dev/null 2>&1 || true
PORT="$PORT" pm2 start journal-only.js --name journal --time
pm2 save >/dev/null

sleep 2
echo "─── status ──────────────────────────────────────────"
pm2 describe journal | sed -n '1,12p' || true
echo "─── answering? ──────────────────────────────────────"
curl -sS -o /dev/null -w 'GET /            → %{http_code}\n' "localhost:$PORT/" || true
curl -sS -o /dev/null -w 'GET /api/journal/trades → %{http_code}\n' \
  "localhost:$PORT/api/journal/trades" || true
echo
echo "Landing page tile: already registered in tools.config.json (JOURNAL, port $PORT)."
echo "Remaining step, in the AWS console: open port $PORT in the security group."
