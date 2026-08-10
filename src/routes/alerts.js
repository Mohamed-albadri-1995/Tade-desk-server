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
  // Read from the registry file rather than a tool's config: the alerts
  // service has no TOOL_ID and should still be able to offer every tool.
  let tools = [];
  try {
    const reg = JSON.parse(require('fs').readFileSync(
      require('path').join(__dirname, '..', '..', 'tools.config.json'), 'utf8'));
    tools = (reg.tools || []).map(t => ({ id: t.id, name: t.name }));
  } catch { /* none */ }
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

/*
 * The permanent record, as opposed to today's feed.
 *
 * `/fires` is reset every morning and capped — right for a phone, useless for
 * "what did this setup signal last Tuesday, and at what second". This reads the
 * archive, which is never trimmed.
 *
 * Without a date it returns the current month, so the page can offer the days
 * that actually exist rather than a calendar of mostly-empty ones.
 */
router.get('/history', (req, res) => {
  const date = req.query.date || null;
  if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ ok: false, error: 'date must be YYYY-MM-DD' });
  }
  const month = req.query.month || (date ? date.slice(0, 7) : toETDate(Date.now()).slice(0, 7));
  if (!/^\d{4}-\d{2}$/.test(month)) {
    return res.status(400).json({ ok: false, error: 'month must be YYYY-MM' });
  }
  const limit = Math.min(2000, Math.max(1, parseInt(req.query.limit, 10) || 500));
  res.json({
    ok: true,
    date,
    month,
    dates: store.historyDates(),
    fires: store.history({ date, month, limit }),
  });
});

/*
 * Position sizing: account size and what you risk per trade.
 *
 * Lives with the alerts rather than in a screener's settings because it is a
 * property of the account, not of T2 — the setup runs inside one tool but the
 * money is the same money whichever tool signalled. Same shared-file reasoning
 * as the rules themselves, so any process can read it and the alerts app can
 * edit it.
 */
router.get('/risk', (req, res) => {
  res.json({ ok: true, risk: require('../setups/risk').settings() });
});

router.post('/risk', express.json(), (req, res) => {
  try {
    res.json({ ok: true, risk: require('../setups/risk').save(req.body || {}) });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

module.exports = router;
