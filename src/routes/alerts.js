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
 * The calculator: entry, stop and target in, shares and the plan out.
 *
 * For the trade a setup did not signal — the one seen on a chart at 11:20 — and
 * for checking what a setup DID signal before acting on it.
 *
 * Computed HERE rather than in the page, using the same risk.sizeFor the live
 * path uses. A second implementation in JavaScript on the phone would be a
 * second answer to "how many shares", and the two would disagree the first time
 * either the cap or the rounding changed. One engine, the same rule the
 * automatic order obeys.
 */
router.post('/size', express.json(), (req, res) => {
  const num = v => {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const entry = num(req.body?.entry);
  const stop = num(req.body?.stop);
  const target = num(req.body?.target);
  const side = String(req.body?.side || '').toUpperCase() === 'SHORT' ? 'SHORT' : 'LONG';

  if (!(entry > 0)) return res.status(400).json({ ok: false, error: 'entry must be a price' });
  if (!(stop > 0)) return res.status(400).json({ ok: false, error: 'stop must be a price' });

  // The direction is implied by where the stop is, and disagreeing with it is
  // the mistake worth catching: a "long" whose stop is above the entry is
  // either the wrong stop or the wrong side, and sizing it would produce a
  // confident number for a trade that cannot be placed.
  const implied = stop < entry ? 'LONG' : 'SHORT';
  if (implied !== side) {
    return res.status(400).json({
      ok: false,
      error: `a ${side.toLowerCase()} has its stop ${side === 'LONG' ? 'below' : 'above'} `
        + `the entry — with the stop at ${stop} and the entry at ${entry} this is a `
        + `${implied.toLowerCase()}`,
    });
  }

  const riskPerShare = Math.abs(entry - stop);
  const risk = require('../setups/risk');
  const cfg = risk.settings();
  const size = risk.sizeFor({ entry, riskPerShare }, cfg);

  // R is the only way to compare two trades whose stops are different distances
  // away, and it is the number the setup itself is measured in.
  const reward = target ? Math.abs(target - entry) : null;
  const rr = reward && riskPerShare ? reward / riskPerShare : null;

  res.json({
    ok: true,
    side,
    entry,
    stop,
    target: target || null,
    riskPerShare,
    riskPct: (riskPerShare / entry) * 100,
    rr,
    // 2R is what the setups target, so a manual trade can be judged against the
    // same bar rather than by feel.
    twoRTarget: side === 'LONG' ? entry + 2 * riskPerShare : entry - 2 * riskPerShare,
    size,
    account: cfg,
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
