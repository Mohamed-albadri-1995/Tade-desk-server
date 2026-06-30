/**
 * Journal API Routes
 * Mounted at /api/journal
 */

const express = require('express');
const { v4: uuidv4 } = require('uuid');
const db = require('../db');
require('../journal/db'); // ensure tables exist
const { importCsv } = require('../journal/importer');
const { fetchAndStore } = require('../journal/technicalFetch');
const { evaluateAll } = require('../journal/alignment');
const { analyzeSetup, analyzeAccount, calendarData, computeMetrics } = require('../journal/analysis');

const router = express.Router();

// ─── Trades ───────────────────────────────────────────────────────────────────

router.get('/trades', (req, res) => {
  const { from, to, account, setup_id, direction, status, ticker } = req.query;
  let q = 'SELECT * FROM journal_trades WHERE 1=1';
  const p = [];
  if (from)     { q += ' AND date >= ?'; p.push(from); }
  if (to)       { q += ' AND date <= ?'; p.push(to); }
  if (account)  { q += ' AND account = ?'; p.push(account); }
  if (setup_id) { q += ' AND setup_id = ?'; p.push(setup_id); }
  if (direction){ q += ' AND direction = ?'; p.push(direction); }
  if (status)   { q += ' AND status = ?'; p.push(status); }
  if (ticker)   { q += ' AND ticker = ?'; p.push(ticker.toUpperCase()); }
  q += ' ORDER BY date DESC, entry_time DESC';
  const trades = db.prepare(q).all(...p);
  res.json(trades);
});

router.get('/trades/:id', (req, res) => {
  const trade = db.prepare('SELECT * FROM journal_trades WHERE id = ?').get(req.params.id);
  if (!trade) return res.status(404).json({ error: 'Trade not found' });
  const ctx  = db.prepare('SELECT * FROM journal_context_snapshots WHERE trade_id = ?').get(req.params.id);
  const tech = db.prepare('SELECT * FROM journal_technical_snapshots WHERE trade_id = ?').get(req.params.id);
  const cond = db.prepare('SELECT * FROM journal_conditions WHERE trade_id = ?').all(req.params.id);
  res.json({ ...trade, context: ctx, technical: tech, conditions: cond });
});

router.post('/trades', (req, res) => {
  const {
    date, ticker, direction, setup_id, shares, entry_price, entry_time,
    exit_price, exit_time, sl, tp, commission, notes, account, context
  } = req.body;

  if (!date || !ticker || !direction || !shares || !entry_price || !entry_time) {
    return res.status(400).json({ error: 'date, ticker, direction, shares, entry_price, entry_time required' });
  }

  const id = uuidv4();
  const now = Date.now();
  const status = exit_price != null ? 'closed' : 'open';
  const grossPnl = exit_price != null
    ? (direction === 'Long' ? exit_price - entry_price : entry_price - exit_price) * shares
    : null;
  const comm = parseFloat(commission) || 0;
  const netPnl = grossPnl != null ? grossPnl - comm : null;
  const pctMove = exit_price != null && entry_price
    ? (exit_price - entry_price) / entry_price * 100 * (direction === 'Long' ? 1 : -1)
    : null;
  const durationMs = exit_time && entry_time
    ? new Date(`${date}T${exit_time}`).getTime() - new Date(`${date}T${entry_time}`).getTime()
    : null;

  db.prepare(`
    INSERT INTO journal_trades
      (id, date, ticker, direction, setup_id, shares, entry_price, entry_time,
       exit_price, exit_time, sl, tp, gross_pnl, commission, net_pnl, pct_move,
       duration_ms, notes, account, status, source, technical_computed, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,?)
  `).run(
    id, date, ticker.toUpperCase(), direction, setup_id || null, parseInt(shares),
    parseFloat(entry_price), entry_time,
    exit_price != null ? parseFloat(exit_price) : null, exit_time || null,
    sl != null ? parseFloat(sl) : null, tp != null ? parseFloat(tp) : null,
    grossPnl != null ? parseFloat(grossPnl.toFixed(2)) : null,
    comm,
    netPnl != null ? parseFloat(netPnl.toFixed(2)) : null,
    pctMove != null ? parseFloat(pctMove.toFixed(3)) : null,
    durationMs,
    notes || null, account || null, status, 'manual', now
  );

  // Store context snapshot if provided
  if (context) {
    db.prepare(`
      INSERT OR REPLACE INTO journal_context_snapshots
        (trade_id, regime, regime_label, sec_bias, broad_resolved, short_term, mid_term, long_term,
         sec_score, sector, industry, scanner_score, scanner_confidence, captured_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      id, context.regime, context.regimeLabel, context.secBias, context.broadResolved,
      context.shortTerm, context.midTerm, context.longTerm, context.secScore,
      context.sector, context.industry, context.scanner_score, context.scanner_confidence, now
    );
  }

  res.json({ ok: true, id });
});

router.patch('/trades/:id', (req, res) => {
  const trade = db.prepare('SELECT * FROM journal_trades WHERE id = ?').get(req.params.id);
  if (!trade) return res.status(404).json({ error: 'Not found' });

  const { exit_price, exit_time, sl, tp, setup_id, notes, status } = req.body;
  const ep = exit_price != null ? parseFloat(exit_price) : trade.exit_price;
  const grossPnl = ep != null
    ? (trade.direction === 'Long' ? ep - trade.entry_price : trade.entry_price - ep) * trade.shares
    : null;
  const netPnl = grossPnl != null ? grossPnl - trade.commission : null;
  const pctMove = ep != null
    ? (ep - trade.entry_price) / trade.entry_price * 100 * (trade.direction === 'Long' ? 1 : -1)
    : null;
  const et = exit_time || trade.exit_time;
  const durationMs = et && trade.entry_time
    ? new Date(`${trade.date}T${et}`).getTime() - new Date(`${trade.date}T${trade.entry_time}`).getTime()
    : trade.duration_ms;

  db.prepare(`
    UPDATE journal_trades SET
      exit_price=?, exit_time=?, sl=?, tp=?, setup_id=?, notes=?, status=?,
      gross_pnl=?, net_pnl=?, pct_move=?, duration_ms=?, technical_computed=0
    WHERE id=?
  `).run(
    ep, et,
    sl != null ? parseFloat(sl) : trade.sl,
    tp != null ? parseFloat(tp) : trade.tp,
    setup_id !== undefined ? (setup_id || null) : trade.setup_id,
    notes !== undefined ? notes : trade.notes,
    status || (ep != null ? 'closed' : trade.status),
    grossPnl != null ? parseFloat(grossPnl.toFixed(2)) : null,
    netPnl != null ? parseFloat(netPnl.toFixed(2)) : null,
    pctMove != null ? parseFloat(pctMove.toFixed(3)) : null,
    durationMs,
    req.params.id
  );

  res.json({ ok: true });
});

router.delete('/trades/:id', (req, res) => {
  db.prepare('DELETE FROM journal_trades WHERE id = ?').run(req.params.id);
  db.prepare('DELETE FROM journal_context_snapshots WHERE trade_id = ?').run(req.params.id);
  db.prepare('DELETE FROM journal_technical_snapshots WHERE trade_id = ?').run(req.params.id);
  db.prepare('DELETE FROM journal_conditions WHERE trade_id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ─── Technical compute ────────────────────────────────────────────────────────

router.post('/trades/:id/compute', async (req, res) => {
  const trade = db.prepare('SELECT * FROM journal_trades WHERE id = ?').get(req.params.id);
  if (!trade) return res.status(404).json({ error: 'Trade not found' });
  try {
    const result = await fetchAndStore(trade);

    // Evaluate conditions if setup template exists
    if (trade.setup_id) {
      const tmplRow = db.prepare('SELECT conditions FROM journal_setup_templates WHERE setup_id = ?').get(trade.setup_id);
      if (tmplRow) {
        const conditions = JSON.parse(tmplRow.conditions || '[]');
        const ctx = db.prepare('SELECT * FROM journal_context_snapshots WHERE trade_id = ?').get(trade.id);
        const tech = db.prepare('SELECT * FROM journal_technical_snapshots WHERE trade_id = ?').get(trade.id);
        const evaluated = evaluateAll(conditions, trade.direction, tech || {}, ctx || {});
        db.prepare('DELETE FROM journal_conditions WHERE trade_id = ?').run(trade.id);
        const insStmt = db.prepare(`
          INSERT INTO journal_conditions (id, trade_id, condition_key, label, section, value, aligned, mandatory)
          VALUES (?,?,?,?,?,?,?,?)
        `);
        for (const c of evaluated) {
          insStmt.run(uuidv4(), trade.id, c.condition_key, c.label, c.section || null,
            c.value, c.aligned != null ? (c.aligned ? 1 : 0) : null, c.mandatory);
        }
      }
    }

    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Bulk compute all trades missing technical data
router.post('/compute-all', async (req, res) => {
  const trades = db.prepare('SELECT * FROM journal_trades WHERE technical_computed = 0 AND status = "closed"').all();
  res.json({ ok: true, queued: trades.length });
  computeAndEvaluateBatch(trades);
});

async function computeAndEvaluateBatch(trades) {
  for (const t of trades) {
    try {
      await fetchAndStore(t);
      if (t.setup_id) await evaluateConditionsForTrade(t);
    } catch { /* skip */ }
    await new Promise(r => setTimeout(r, 300));
  }
}

function evaluateConditionsForTrade(trade) {
  const tmplRow = db.prepare('SELECT conditions FROM journal_setup_templates WHERE setup_id = ?').get(trade.setup_id);
  if (!tmplRow) return;
  const conditions = JSON.parse(tmplRow.conditions || '[]');
  const ctx  = db.prepare('SELECT * FROM journal_context_snapshots WHERE trade_id = ?').get(trade.id);
  const tech = db.prepare('SELECT * FROM journal_technical_snapshots WHERE trade_id = ?').get(trade.id);
  const evaluated = evaluateAll(conditions, trade.direction, tech || {}, ctx || {});
  db.prepare('DELETE FROM journal_conditions WHERE trade_id = ?').run(trade.id);
  const insStmt = db.prepare(`
    INSERT INTO journal_conditions (id, trade_id, condition_key, label, section, value, aligned, mandatory)
    VALUES (?,?,?,?,?,?,?,?)
  `);
  for (const c of evaluated) {
    insStmt.run(uuidv4(), trade.id, c.condition_key, c.label, c.section || null,
      c.value, c.aligned != null ? (c.aligned ? 1 : 0) : null, c.mandatory);
  }
}

// ─── Import ───────────────────────────────────────────────────────────────────

router.post('/import', (req, res) => {
  const { csv, account } = req.body;
  if (!csv) return res.status(400).json({ error: 'csv required' });
  try {
    const result = importCsv(csv, account || null);
    // Auto-compute technical + conditions for newly imported closed trades
    if (result.imported > 0) {
      const newTrades = result.trades
        .filter(t => t.status === 'closed')
        .map(t => db.prepare('SELECT * FROM journal_trades WHERE id = ?').get(t.id))
        .filter(Boolean);
      computeAndEvaluateBatch(newTrades);
    }
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

// ─── Setup templates ──────────────────────────────────────────────────────────

router.get('/templates', (req, res) => {
  const rows = db.prepare('SELECT * FROM journal_setup_templates').all();
  res.json(rows.map(r => ({ ...r, conditions: JSON.parse(r.conditions) })));
});

router.put('/templates/:setupId', (req, res) => {
  const { conditions, min_grade_trades, min_condition_trades } = req.body;
  const existing = db.prepare('SELECT id FROM journal_setup_templates WHERE setup_id = ?').get(req.params.setupId);
  if (existing) {
    db.prepare(`
      UPDATE journal_setup_templates SET conditions=?, min_grade_trades=?, min_condition_trades=?, updated_at=?
      WHERE setup_id=?
    `).run(JSON.stringify(conditions || []), min_grade_trades || 20, min_condition_trades || 10, Date.now(), req.params.setupId);
  } else {
    db.prepare(`
      INSERT INTO journal_setup_templates (id, setup_id, conditions, min_grade_trades, min_condition_trades, updated_at)
      VALUES (?,?,?,?,?,?)
    `).run(uuidv4(), req.params.setupId, JSON.stringify(conditions || []), min_grade_trades || 20, min_condition_trades || 10, Date.now());
  }
  res.json({ ok: true });
});

// ─── Context snapshot (store at signal time from trading tool) ────────────────

router.post('/trades/:id/context', (req, res) => {
  const ctx = req.body;
  db.prepare(`
    INSERT OR REPLACE INTO journal_context_snapshots
      (trade_id, regime, regime_label, sec_bias, broad_resolved, short_term, mid_term, long_term,
       sec_score, sector, industry, scanner_score, scanner_confidence, captured_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    req.params.id, ctx.regime, ctx.regimeLabel, ctx.secBias, ctx.broadResolved,
    ctx.shortTerm, ctx.midTerm, ctx.longTerm, ctx.secScore,
    ctx.sector, ctx.industry, ctx.scanner_score, ctx.scanner_confidence, Date.now()
  );
  res.json({ ok: true });
});

// ─── Analysis ─────────────────────────────────────────────────────────────────

router.get('/analysis/account', (req, res) => {
  res.json(analyzeAccount(req.query));
});

router.get('/analysis/setup/:setupId', (req, res) => {
  res.json(analyzeSetup(req.params.setupId));
});

router.get('/analysis/calendar', (req, res) => {
  res.json(calendarData(req.query));
});

router.get('/analysis/metrics', (req, res) => {
  const { from, to, account, setup_id } = req.query;
  let q = 'SELECT * FROM journal_trades WHERE status="closed"';
  const p = [];
  if (from)     { q += ' AND date >= ?';    p.push(from); }
  if (to)       { q += ' AND date <= ?';    p.push(to); }
  if (account)  { q += ' AND account = ?';  p.push(account); }
  if (setup_id) { q += ' AND setup_id = ?'; p.push(setup_id); }
  const trades = db.prepare(q).all(...p);
  res.json(computeMetrics(trades));
});

// ─── Daily notes ──────────────────────────────────────────────────────────────

router.get('/notes/:date', (req, res) => {
  const row = db.prepare('SELECT * FROM journal_daily_notes WHERE date = ?').get(req.params.date);
  res.json(row || { date: req.params.date, note: '' });
});

router.put('/notes/:date', (req, res) => {
  const { note } = req.body;
  db.prepare('INSERT OR REPLACE INTO journal_daily_notes (date, note, updated_at) VALUES (?,?,?)').run(
    req.params.date, note || '', Date.now()
  );
  res.json({ ok: true });
});

// ─── Fee profiles ─────────────────────────────────────────────────────────────

router.get('/fees', (req, res) => {
  const rows = db.prepare('SELECT * FROM journal_fee_profiles').all();
  res.json(rows.map(r => ({ ...r, rules: JSON.parse(r.rules) })));
});

router.put('/fees/:account', (req, res) => {
  const { rules, mode } = req.body;
  const acct = req.params.account;
  const existing = db.prepare('SELECT id FROM journal_fee_profiles WHERE account = ?').get(acct);
  if (existing) {
    db.prepare('UPDATE journal_fee_profiles SET rules=?, mode=?, updated_at=? WHERE account=?')
      .run(JSON.stringify(rules || []), mode || 'replace', Date.now(), acct);
  } else {
    db.prepare('INSERT INTO journal_fee_profiles (id, account, rules, mode, updated_at) VALUES (?,?,?,?,?)')
      .run(uuidv4(), acct, JSON.stringify(rules || []), mode || 'replace', Date.now());
  }
  res.json({ ok: true });
});

module.exports = router;
