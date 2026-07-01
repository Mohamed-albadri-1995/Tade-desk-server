/**
 * Journal → Grading bridge
 *
 * Historical trades enter the system through two paths:
 *   - manual add (POST /api/journal/trades)
 *   - CSV import (POST /api/journal/import/csv)
 *
 * Both land in `journal_trades`. The grading engine, however, learns
 * from `trade_cards`. Without a bridge, a user with 200 imported
 * historical trades would still see grading say "n=0, bootstrap
 * mode" until they place 30+ fresh live trades — the imported
 * history is invisible.
 *
 * This module mirrors a closed journal_trade into trade_cards. It is
 * intentionally one-way: journal → cards, not the reverse. New live
 * trading writes trade_cards directly (see grading.createCardForSignal)
 * and never touches journal_trades.
 *
 * Cards written by this bridge carry source='journal' in the context
 * blob so downstream analytics can distinguish imported history from
 * live signal fires if they need to.
 */

const db = require('../db');
const { v4: uuidv4 } = require('uuid');

function _rMultiple(entry, exit, sl, direction) {
  if (!Number.isFinite(entry) || !Number.isFinite(exit) || !Number.isFinite(sl)) return null;
  const stopDist = Math.abs(entry - sl);
  if (stopDist === 0) return null;
  const move = direction === 'Long' ? (exit - entry) : (entry - exit);
  return move / stopDist;
}

/**
 * Mirror one closed journal trade into trade_cards. Idempotent: uses
 * the journal trade's id as the card id so re-imports don't duplicate.
 * Returns { ok, cardId } or { ok: false, reason } if nothing to write.
 */
function mirrorTradeToCard(tradeId) {
  const t = db.prepare('SELECT * FROM journal_trades WHERE id = ?').get(tradeId);
  if (!t) return { ok: false, reason: 'trade not found' };
  if (t.status !== 'closed') return { ok: false, reason: 'trade still open' };
  // If a card already exists — either from a live fire or an earlier
  // import pass — leave it alone rather than clobber real fill data.
  const existing = db.prepare('SELECT id FROM trade_cards WHERE id = ?').get(tradeId);
  if (existing) return { ok: true, cardId: tradeId, skipped: true };

  const rMultiple = t.r_multiple != null
    ? t.r_multiple
    : _rMultiple(t.entry_price, t.exit_price, t.sl, t.direction);
  const stopDistance = Number.isFinite(t.entry_price) && Number.isFinite(t.sl)
    ? Math.abs(t.entry_price - t.sl)
    : null;
  const firedAt = t.created_at || Date.now();
  const closedAt = t.exit_time
    ? new Date(`${t.date}T${t.exit_time}`).getTime() || firedAt
    : firedAt;

  db.prepare(`
    INSERT INTO trade_cards
      (id, date, ticker, setup_id, direction, account, position_id, order_id,
       entry_price, shares, stop_distance, fired_at, closed_at,
       exit_price, r_multiple, net_pnl, exit_reason, context, grade, grade_details)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    tradeId, t.date, t.ticker, t.setup_id, t.direction, t.account || null,
    null, null,
    t.entry_price, t.shares, stopDistance, firedAt, closedAt,
    t.exit_price, rMultiple, t.net_pnl,
    t.exit_verdict || 'imported',
    JSON.stringify({ source: 'journal', importedFrom: t.source || 'manual' }),
    null, null,
  );

  // Journal doesn't carry check evaluations, so nothing to insert into
  // trade_card_checks. Grading engine still reads the r_multiple to
  // compute setup expectancy and size multipliers — check contributions
  // simply won't include imported trades, which is correct.
  return { ok: true, cardId: tradeId };
}

/**
 * Bulk mirror — used after a CSV import to catch every newly-inserted
 * closed trade in one pass. Returns { mirrored, skipped }.
 */
function mirrorClosedTrades(tradeIds) {
  let mirrored = 0, skipped = 0;
  for (const id of tradeIds) {
    const r = mirrorTradeToCard(id);
    if (r.ok && !r.skipped) mirrored++;
    else if (r.skipped) skipped++;
  }
  return { mirrored, skipped };
}

module.exports = { mirrorTradeToCard, mirrorClosedTrades };
