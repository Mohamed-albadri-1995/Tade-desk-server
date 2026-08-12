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
/*
 * `index: false` matters. public/ still holds the old app's index.html — the
 * screener SPA — and express.static serves an index file for "/" BEFORE any
 * route declared after it gets a look. Left on, port 3100 opens the screener
 * and the journal is unreachable at the address the landing page links to.
 * Static assets (popup.js, css) still serve; only the automatic index does not.
 */
app.use(express.static(path.join(__dirname, 'public'), { index: false }));

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

/*
 * The page, with this repo's add-ons injected before </body>.
 *
 * Injected rather than forked: journal.html is 1,079 lines on a branch with no
 * shared history, and keeping a second copy of it here would guarantee the two
 * drift. The original is served exactly as it is, plus one script tag.
 */
const fs = require('fs');
const PATCH = process.env.JOURNAL_PATCH_JS || '';
app.get('/_patch.js', (req, res) => {
  if (!PATCH) return res.type('js').send('/* no patch configured */');
  res.type('js').sendFile(PATCH);
});
app.get('/', (req, res) => {
  const file = path.join(__dirname, 'public', 'journal.html');
  if (!PATCH) return res.sendFile(file);
  fs.readFile(file, 'utf8', (err, html) => {
    if (err) return res.status(500).send(String(err));
    const tag = '<script src="/_patch.js"></script>';
    // If </body> is ever missing, append rather than silently drop the tag —
    // a page that quietly loses the delete fix is the failure being fixed.
    res.type('html').send(html.includes('</body>')
      ? html.replace('</body>', tag + '</body>')
      : html + tag);
  });
});

const PORT = process.env.PORT || 3100;
app.listen(PORT, () => console.log(`[journal] listening on ${PORT}`));
JS

# ── run it ─────────────────────────────────────────────────────────────────
cd "$APP_DIR"
pm2 delete journal >/dev/null 2>&1 || true
# The add-ons live in THIS repo, not in the worktree, so they are versioned
# with everything else here and the checked-out branch stays pristine.
PORT="$PORT" JOURNAL_PATCH_JS="$REPO/deploy/journal/patch.js" \
  pm2 start journal-only.js --name journal --time
pm2 save >/dev/null

sleep 2
echo "─── status ──────────────────────────────────────────"
pm2 describe journal | sed -n '1,12p' || true
echo "─── answering? ──────────────────────────────────────"
curl -sS -o /dev/null -w 'GET /            → %{http_code}\n' "localhost:$PORT/" || true
curl -sS -o /dev/null -w 'GET /api/journal/trades → %{http_code}\n' \
  "localhost:$PORT/api/journal/trades" || true
curl -sS -o /dev/null -w 'GET /_patch.js   → %{http_code}\n' \
  "localhost:$PORT/_patch.js" || true
echo -n 'patch injected into / : '
curl -sS "localhost:$PORT/" | grep -c '_patch.js' || true
echo
echo "Landing page tile: already registered in tools.config.json (JOURNAL, port $PORT)."
echo "Remaining step, in the AWS console: open port $PORT in the security group."
