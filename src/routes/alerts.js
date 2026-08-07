/*
 * Alert rules and the day's fires.
 *
 * Any tool can serve these: both live in shared files beside the databases, so
 * the tool rendering the landing page reads the same rules the other eight are
 * evaluating. That is the point — a rule is written once and applies wherever
 * it was scoped, rather than being copied into nine tools.
 *
 * Writes are accepted here too. Only one process is serving the UI at a time,
 * and the rules file has a single writer by construction; the evaluating tools
 * only ever read it.
 */

const express = require('express');
const engine = require('../alerts/engine');
const store = require('../alerts/store');
const { toETDate } = require('../utils/time');

const router = express.Router();

// What the builder can offer. Served rather than duplicated in the page, so a
// field added to the engine appears in the UI without a second edit — the way
// a form and its validator disagree is by being written twice.
router.get('/meta', (req, res) => {
  let tools = [];
  try { tools = require('../config').tools.map(t => ({ id: t.id, name: t.name })); } catch { /* none */ }
  res.json({ ok: true, fields: engine.FIELDS, operators: engine.OPERATORS, tools });
});

router.get('/rules', (req, res) => {
  res.json({ ok: true, rules: store.listRules() });
});

router.post('/rules', express.json(), (req, res) => {
  try {
    res.json({ ok: true, rule: store.saveRule(req.body || {}) });
  } catch (err) {
    // 400, not 500: a rule the trader typed wrong is not a server fault, and
    // the message is the only thing that makes it fixable.
    res.status(400).json({ ok: false, error: err.message });
  }
});

router.delete('/rules/:id', (req, res) => {
  const gone = store.deleteRule(req.params.id);
  res.status(gone ? 200 : 404).json({ ok: gone, error: gone ? undefined : 'No such rule' });
});

// The day's fires across every tool. `date` defaults to today in New York —
// the market's day, not the reader's.
router.get('/fires', (req, res) => {
  const date = req.query.date || toETDate(Date.now());
  const limit = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 100));
  res.json({ ok: true, date, fires: store.recentFires(date, limit) });
});

module.exports = router;
