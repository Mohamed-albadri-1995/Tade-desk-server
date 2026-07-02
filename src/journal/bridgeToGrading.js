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
const checks = require('../trading/checks');

function _rMultiple(entry, exit, sl, direction) {
  if (!Number.isFinite(entry) || !Number.isFinite(exit) || !Number.isFinite(sl)) return null;
  const stopDist = Math.abs(entry - sl);
  if (stopDist === 0) return null;
  const move = direction === 'Long' ? (exit - entry) : (entry - exit);
  return move / stopDist;
}

/**
 * Build a check-evaluator context from a journal trade's stored
 * technical + context snapshots. Maps the journal snapshot column names
 * to the same field names live signal fires use, so a check_library
 * condition written for live trading resolves identically against an
 * imported trade.
 */
function _ctxForJournalTrade(tradeId) {
  const tech = db.prepare('SELECT * FROM journal_technical_snapshots WHERE trade_id = ?').get(tradeId);
  const ctx  = db.prepare('SELECT * FROM journal_context_snapshots   WHERE trade_id = ?').get(tradeId);
  const ind = tech ? {
    close:  tech.price,
    open:   tech.open   ?? null,
    high:   tech.high   ?? null,
    low:    tech.low    ?? null,
    volume: tech.volume ?? null,
    prevClose: tech.prev_close ?? null,
    vwap: tech.vwap, ema9: tech.ema9, ema13: tech.ema13, ema20: tech.ema20, ema50: tech.ema50,
    sma5: tech.sma5, sma9: tech.sma9, sma13: tech.sma13, sma20: tech.sma20,
    bb_upper: tech.bb_upper, bb_lower: tech.bb_lower, bb_mid: tech.bb_mid,
    rvol: tech.rvol, atr: tech.atr, atr14: tech.atr,
    pmHigh: tech.pm_high, pmLow: tech.pm_low,
    premarket_high: tech.pm_high, premarket_low: tech.pm_low,
    daily_vwap: tech.vwap,
    ma5day: tech.ma5day, ma5day_slope: tech.ma5day_slope,
    vwap_2day: tech.vwap_2day, vwap_week: tech.vwap_week, vwap_month: tech.vwap_month,
    week_high: tech.week_high, week_low: tech.week_low,
    month_high: tech.month_high, month_low: tech.month_low,
    prev_day_high: tech.prev_day_high, prev_day_low: tech.prev_day_low,
  } : {};
  const scanner = ctx ? {
    regime: ctx.regime, regimeLabel: ctx.regime_label,
    secBias: ctx.sec_bias, broadResolved: ctx.broad_resolved,
    shortTerm: ctx.short_term, midTerm: ctx.mid_term, longTerm: ctx.long_term,
    secScore: ctx.sec_score, secHot: tech?.sec_hot === 1,
    sector: ctx.sector, industry: ctx.industry,
    _score: ctx.scanner_score,
  } : {};
  return { ind, scanner, bars: [], history: {} };
}

/**
 * Evaluate every default + setup-assigned additional check against the
 * imported trade's stored snapshot and persist rows to trade_card_checks.
 * Direction-aware: variation resolver picks the right long/short slot per
 * the trade's direction. Idempotent — cleans any existing rows first.
 */
function evaluateChecksForCard(cardId, setupId, direction) {
  const ctx = _ctxForJournalTrade(cardId);
  const dir = String(direction).toLowerCase();
  const dirMatches = (d) => !d || d === 'both' || d === dir;

  const evalOne = (row) => {
    const rowDir = row.direction || 'both';
    let cond = row.condition;
    let variation = 'symmetric';
    if (rowDir === 'both' && dir === 'long' && row.condition_long) {
      cond = row.condition_long; variation = 'long';
    } else if (rowDir === 'both' && dir === 'short' && row.condition_short) {
      cond = row.condition_short; variation = 'short';
    } else if (rowDir === 'long') {
      variation = 'long';
    } else if (rowDir === 'short') {
      variation = 'short';
    }
    const r = checks.evaluateCondition(cond, ctx);
    return {
      key: row.key,
      label: row.label,
      section: row.section || null,
      value: r.value,
      aligned: r.aligned,
      versionId: row.versionId || 1,
      variation,
    };
  };

  const defaults    = checks.listChecks({ category: 'default', enabledOnly: true }).filter(r => dirMatches(r.direction));
  const additionals = setupId ? checks.assignmentsForSetup(setupId).filter(r => r.enabled && dirMatches(r.direction)) : [];

  const rows = [...defaults.map(evalOne), ...additionals.map(evalOne)];
  const txn = db.transaction(() => {
    db.prepare("DELETE FROM trade_card_checks WHERE card_id = ? AND kind = 'additional'").run(cardId);
    const stmt = db.prepare(`
      INSERT INTO trade_card_checks (id, card_id, kind, check_key, label, section, value, aligned, check_version_id, variation)
      VALUES (?, ?, 'additional', ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const c of rows) {
      stmt.run(uuidv4(), cardId, c.key, c.label, c.section,
        c.value != null ? String(c.value) : null,
        c.aligned == null ? null : (c.aligned ? 1 : 0),
        c.versionId, c.variation);
    }
  });
  txn();
  return rows.length;
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

  // Retroactively evaluate every default + setup-attached additional check
  // against the trade's stored technical + context snapshot so the trade
  // card viewer shows real per-setup alignments AND the learning engine
  // includes the imported trade in check-contribution stats. Fails
  // silently if snapshots aren't populated yet (technicalFetch hasn't
  // run); the card still exists and r_multiple still counts toward setup
  // expectancy.
  let checksWritten = 0;
  try {
    if (t.setup_id) checksWritten = evaluateChecksForCard(tradeId, t.setup_id, t.direction);
  } catch (err) {
    console.warn(`[bridgeToGrading] check eval failed for ${tradeId}: ${err.message}`);
  }
  return { ok: true, cardId: tradeId, checksWritten };
}

/**
 * Backfill trade_card_checks for previously-bridged journal cards that
 * were written before per-setup check evaluation existed. Boot-time,
 * one-shot, only touches cards missing additional-check rows.
 */
function backfillCheckEvaluations() {
  const rows = db.prepare(`
    SELECT tc.id, tc.setup_id, tc.direction
      FROM trade_cards tc
     WHERE tc.context LIKE '%"source":"journal"%'
       AND NOT EXISTS (
         SELECT 1 FROM trade_card_checks cc
          WHERE cc.card_id = tc.id AND cc.kind = 'additional'
       )
  `).all();
  let updated = 0;
  for (const r of rows) {
    if (!r.setup_id) continue;
    try {
      const n = evaluateChecksForCard(r.id, r.setup_id, r.direction);
      if (n > 0) updated++;
    } catch { /* skip */ }
  }
  if (updated) console.log(`[bridgeToGrading] backfilled ${updated}/${rows.length} imported cards with check evaluations`);
  return { processed: rows.length, updated };
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

module.exports = { mirrorTradeToCard, mirrorClosedTrades, backfillCheckEvaluations, evaluateChecksForCard };
