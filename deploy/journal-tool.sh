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
require('./src/trading/grading');        // creates trade_cards; requires only db + uuid

/*
 * Two repairs to the schema this code expects, both additive, both needed
 * before a trade can be tagged with a setup. Made here because the code that
 * needs them is on a branch this repo does not own and must not fork.
 *
 * 1. trade_cards. PATCH mirrors a closed trade into it for the grading engine.
 *    The table is created by src/trading/grading.js, which was not loaded — it
 *    requires nothing but db and uuid, so it is now. Without it every tag
 *    logged "[Journal] mirror failed: no such table: trade_cards".
 *
 * 2. journal_technical_snapshots.id. After assigning a setup, PATCH asks
 *    `SELECT id FROM journal_technical_snapshots WHERE trade_id = ?` to decide
 *    whether snapshots exist yet — but that table is keyed by trade_id and has
 *    no id column at all, so the query throws and the request 500s. The UPDATE
 *    has already landed by then, so the tag sticks and the error is invisible
 *    unless you watch the network tab; what is lost silently is the condition
 *    evaluation that was supposed to follow.
 *
 *    Adding the column is the smallest correct repair available from outside:
 *    the query only ever tests whether a ROW came back, so a column that is
 *    always NULL answers it exactly as intended.
 */
try {
  // The journal's own tables are created by this require. It has to happen
  // BEFORE the check below, or PRAGMA reports zero columns for a table that
  // does not exist yet and the repair silently no-ops — which is exactly what
  // it did the first time, leaving the 500 in place and looking fixed.
  require('./src/journal/db');
  const cols = db.prepare("PRAGMA table_info(journal_technical_snapshots)").all();
  if (cols.length && !cols.some(c => c.name === 'id')) {
    db.exec('ALTER TABLE journal_technical_snapshots ADD COLUMN id INTEGER');
    console.log('[journal] added the missing id column to journal_technical_snapshots');
  }
} catch (e) {
  console.warn('[journal] schema repair skipped:', e.message);
}

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
 * The setup list the page tags a trade with.
 *
 * Read from the LIVE catalogue on the alerts app, not from this database's own
 * trading_setups table — which is empty here, and would stay empty, because the
 * screen that fills it belongs to the app this launcher exists to avoid.
 *
 * Taking them from the alerts app means a journal trade is tagged with the same
 * setup, under the same id, that fired the alert and placed the order. Anything
 * else and per-setup expectancy in the journal would be measuring a different
 * set of names than the backtests do, while looking identical.
 *
 * A short timeout and a fall back to the local table: the journal must open
 * whether or not the alerts app happens to be up, and an empty list is a
 * perfectly readable answer (the page already handles it).
 */
const ALERTS = process.env.ALERTS_URL || 'http://127.0.0.1:3090';
app.get('/api/trading/setups', async (req, res) => {
  try {
    const r = await fetch(`${ALERTS}/api/setups`, { signal: AbortSignal.timeout(2500) });
    const d = await r.json();
    if (d && Array.isArray(d.setups)) {
      return res.json(d.setups.map(s => ({
        id: s.id, name: s.name, enabled: s.enabled !== false, config: {},
      })));
    }
  } catch { /* fall through to whatever is stored locally */ }
  try {
    const rows = db.prepare('SELECT * FROM trading_setups ORDER BY name').all();
    res.json(rows.map(r => ({ ...r, config: JSON.parse(r.config || '{}') })));
  } catch {
    res.json([]);
  }
});

/*
 * IMPORTING THE ACCOUNT'S OWN TRADES.
 *
 * The journal's only ways in were a pasted CSV and typing, so a day the desk
 * traded automatically produced no journal entry at all — its own status line
 * read "Alpaca — connected, 3 names filled today" above a page saying
 * "0 trades".
 *
 * A separate endpoint rather than the journal's own POST /trades, for two
 * reasons that both matter:
 *
 *   that route generates its own uuid and hardcodes source='manual'. With no
 *   stable id, importing the same day twice makes a second copy of every trade
 *   — and the second import is the normal case, because a day is imported once
 *   while it is running and again after it closes.
 *
 *   'manual' would be a lie, and the difference is worth keeping: a trade taken
 *   by hand and one taken by the desk are different evidence about a strategy.
 *
 * The rows come from the desk, which pairs Alpaca's fills into round trips —
 * see src/broker/journalTrades.js. Nothing is computed here; this writes what
 * it is given, under an id derived from the first fill of the trade, so a
 * re-import updates rather than duplicates.
 */
app.post('/api/journal/import-alpaca', (req, res) => {
  const rows = Array.isArray(req.body && req.body.trades) ? req.body.trades : [];
  let added = 0; let updated = 0; let skipped = 0;
  const errors = [];

  const findByExt = db.prepare('SELECT id, status FROM journal_trades WHERE id = ?');
  for (const t of rows) {
    try {
      if (!t || !t.date || !t.ticker || !t.direction || !t.shares || !t.entryPrice) {
        skipped += 1; continue;
      }
      // The desk's extId IS the primary key. Deterministic, so this is
      // idempotent by construction rather than by a lookup that can miss.
      const id = String(t.extId || '').slice(0, 200);
      if (!id) { skipped += 1; continue; }

      const dir = t.direction === 'Short' ? 'Short' : 'Long';
      const shares = parseInt(t.shares, 10);
      const entry = parseFloat(t.entryPrice);
      const exit = t.exitPrice != null ? parseFloat(t.exitPrice) : null;
      const gross = exit != null
        ? (dir === 'Long' ? exit - entry : entry - exit) * shares : null;
      const pct = exit != null && entry
        ? ((exit - entry) / entry) * 100 * (dir === 'Long' ? 1 : -1) : null;
      const dur = t.exitTime && t.entryTime
        ? new Date(`${t.date}T${t.exitTime}`).getTime()
          - new Date(`${t.date}T${t.entryTime}`).getTime()
        : null;
      const status = exit != null ? 'closed' : 'open';

      const was = findByExt.get(id);
      /*
       * AN OPEN TRADE BECOMES A CLOSED ONE, and that is the update this exists
       * for: imported at 11:00 while it was running, imported again after the
       * bell with its exit. A closed trade is never rewritten — by then a
       * person may have tagged it, noted it, or corrected a fee.
       */
      if (was && was.status === 'closed') { skipped += 1; continue; }

      db.prepare(`
        INSERT INTO journal_trades
          (id, date, ticker, direction, setup_id, shares, entry_price, entry_time,
           exit_price, exit_time, gross_pnl, commission, net_pnl, pct_move,
           duration_ms, account, status, source, technical_computed, created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,0,?,?,?,?,?,'alpaca',0,?)
        ON CONFLICT(id) DO UPDATE SET
          exit_price=excluded.exit_price, exit_time=excluded.exit_time,
          gross_pnl=excluded.gross_pnl, net_pnl=excluded.net_pnl,
          pct_move=excluded.pct_move, duration_ms=excluded.duration_ms,
          status=excluded.status,
          -- Never blank a setup a person chose; only fill one that is empty.
          setup_id=COALESCE(journal_trades.setup_id, excluded.setup_id)
      `).run(
        id, t.date, String(t.ticker).toUpperCase(), dir, t.setupId || null,
        shares, entry, t.entryTime || '00:00:00',
        exit, t.exitTime || null,
        gross != null ? parseFloat(gross.toFixed(2)) : null,
        gross != null ? parseFloat(gross.toFixed(2)) : null,
        pct != null ? parseFloat(pct.toFixed(3)) : null,
        dur, t.account || 'Alpaca', status, Date.now(),
      );
      if (was) updated += 1; else added += 1;

      /*
       * Mirrored into trade_cards so the grading engine learns from an imported
       * trade exactly as it does from one typed in. Required lazily and
       * best-effort: it belongs to the app this launcher exists to avoid
       * booting, and a grading failure must not lose the journal row, which is
       * the primary record.
       */
      if (status === 'closed') {
        try {
          require('./src/journal/bridgeToGrading').mirrorTradeToCard(id);
        } catch (e) { /* same treatment as the routes' own mirror calls */ }
      }
    } catch (err) {
      errors.push(`${(t && t.ticker) || '?'}: ${err.message}`);
    }
  }
  res.json({ ok: true, added, updated, skipped, errors });
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
echo -n 'setups available to tag with: '
curl -sS "localhost:$PORT/api/trading/setups" \
  | python3 -c 'import json,sys;d=json.load(sys.stdin);print(len(d));[print("   -",x["name"]) for x in d[:12]]' \
  2>/dev/null || echo '? (alerts app unreachable)'
echo -n 'patch injected into / : '
curl -sS "localhost:$PORT/" | grep -c '_patch.js' || true
echo
echo "Landing page tile: already registered in tools.config.json (JOURNAL, port $PORT)."
echo "Remaining step, in the AWS console: open port $PORT in the security group."
