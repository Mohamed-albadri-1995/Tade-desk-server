/*
 * "IS WHAT TRADES THE THING THAT WAS BACKTESTED?" — ONE ANSWER PER SETUP.
 *
 * Two different ways a live setup stops being its backtest, and both were
 * happening with nothing on screen to say so:
 *
 *   THE SETTINGS  fill model, ranking, sizing, caps, feed, view — kept in the
 *                 desk's prefs on one side and in the run's spec on the other.
 *                 parity.js compares them; until now nothing called it.
 *
 *   THE RULES     the strategy is edited in the builder after it was tested —
 *                 a stop tightened, a leg moved — and the old run keeps being
 *                 read as evidence for it. qp keeps a frozen copy of what each
 *                 run ran and chart/parity.py lists every rule that differs.
 *
 * The verdict is the worse of the two, and "could not check" is never "match".
 */

const catalog = require('./catalog');
const qp = require('./qpClient');
const parity = require('./parity');

/** '09:35' → 935, the integer qp stores a window in. */
const toHHMM = (t) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(t || ''));
  return m ? Number(m[1]) * 100 + Number(m[2]) : null;
};

async function check(setupId) {
  const setup = await catalog.get(setupId);
  if (!setup) return { ok: false, status: 404, error: 'No such setup' };

  let report;
  try {
    report = await qp.parity(setup.strategyIds || []);
  } catch (err) {
    return { ok: false, setup: setup.id, verdict: 'unknown',
             error: `qp did not answer the check: ${err.message}` };
  }
  const bt = report.backtest;
  if (!bt) {
    return { ok: true, setup: setup.id, verdict: 'unknown', backtest: null,
             settings: [], rules: [], lines: [
               'No finished backtest has run this strategy, so there is nothing '
               + 'to compare the live setup against.'] };
  }

  const strategy = { risk: { window_start: toHHMM(setup.decisionTime),
                             window_end: toHHMM(setup.windowEnd || setup.decisionTime) } };
  const cmp = parity.compare({ setup, spec: bt.spec, strategy });
  const rules = report.rules || [];
  const edited = rules.filter(r => r.frozen && r.changed.length);
  const unfrozen = rules.filter(r => !r.frozen);

  const lines = [];
  for (const r of edited) {
    lines.push(`${r.name}: ${r.changed.length}${r.truncated ? '+' : ''} rule(s) changed `
      + `since backtest #${bt.id} — ${r.changed.slice(0, 3).map(c => c.path).join(', ')}`);
  }
  for (const r of unfrozen) lines.push(`${r.name}: ${r.note}`);
  lines.push(...parity.summarise(cmp));

  const verdict = (edited.length || cmp.differs.length) ? 'differ'
    : (unfrozen.length || cmp.unknown.length) ? 'unknown' : 'match';

  const s = bt.summary || {};
  return {
    ok: true, setup: setup.id, verdict, lines,
    backtest: { id: bt.id, name: bt.name, created_at: bt.created_at,
                trades: s.trades ?? null, win_rate: s.win_rate ?? null,
                avg_return_pct: s.avg_return_pct ?? null,
                max_drawdown_pct: s.max_drawdown_pct ?? null,
                start: bt.spec.start || null, end: bt.spec.end || null },
    settings: cmp.rows,
    rules,
  };
}

module.exports = { check, toHHMM };
