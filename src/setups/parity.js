/*
 * DOES THE LIVE DESK DO WHAT THE BACKTEST TESTED?
 *
 * The desk was built to reproduce a backtest, and after two weeks of live
 * trading it had not. Three settings differed, in three separate files, and
 * nothing anywhere compared them — so each was invisible on its own and the
 * only symptom was a P&L that did not match.
 *
 * The differences are not exotic. They are ordinary configuration:
 *
 *   THE DECISION BAR. The one that cost the most and hid the best. A setup's
 *   window pins the ENTRY minute, so on a one-minute window the FILL MODEL
 *   decides which bar the conditions are read on:
 *
 *       'next_open' / 'desk'   entry at the 09:35 OPEN,  decided on 09:34
 *       'close'                entry at the 09:35 CLOSE, decided on 09:35
 *
 *   Both are legitimate and both satisfy a 935 window. They are also a
 *   different bar's close, VWAP and ATR — so they produce DIFFERENT SIGNALS,
 *   not merely different prices. The live desk runs 'close'; every backtest of
 *   the 09:35 setup has been run on 'next_open'.
 *
 *   RISK SIZING. Live risks a flat dollar (riskPerTrade). The backtest offered
 *   only a percentage of equity until recently, and a percentage COMPOUNDS.
 *
 *   THE POSITION CAP. Live sends maxPositionPct; a backtest run without one is
 *   a different book — the first tight stop takes the balance and the rest of
 *   the day is skipped for lack of capital, in arrival order.
 *
 *   THE RANKING. Metric and count, which decide WHICH of the day's signals get
 *   taken at all.
 *
 * This module states both sides of each and says whether they agree. It reads
 * the desk's own configuration and the qp strategy as qp reports it; it
 * invents nothing and defaults nothing, because a default here would be a
 * fourth place for the two sides to differ.
 *
 * A check that cannot be made is reported as UNKNOWN, never as a match.
 */

const prefs = require('./prefs');
const risk = require('./risk');

/** '09:35' from qp's integer HHMM. Null stays null — absent is not midnight. */
function hhmm(n) {
  if (n === null || n === undefined || n === '') return null;
  const v = Number(n);
  if (!Number.isFinite(v)) return null;
  const h = Math.floor(v / 100);
  const m = v % 100;
  if (h < 0 || h > 23 || m < 0 || m > 59) return null;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/** hhmm string ± minutes, as a string. */
function shift(time, mins) {
  if (!time) return null;
  const [h, m] = String(time).split(':').map(Number);
  const t = h * 60 + m + mins;
  if (!Number.isFinite(t) || t < 0 || t >= 24 * 60) return null;
  return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
}

/*
 * WHICH BAR'S CONDITIONS A FILL MODEL READS, given the entry window.
 *
 * The window pins the FILL bar (chart/strategy.py, pinned by logic_audit31).
 * So under a model that fills at the next bar's open, the signal bar is the
 * one BEFORE the window; under 'close' the signal bar IS the window bar.
 *
 * Only meaningful for a CLOCK setup — window_start === window_end. Where the
 * window is a range the entry may fire on any bar inside it and there is no
 * single decision bar to compare, which is reported rather than guessed.
 */
function decisionBar(windowStart, windowEnd, fill) {
  const at = hhmm(windowStart);
  const until = hhmm(windowEnd);
  if (!at) return { bar: null, why: 'the strategy has no entry window' };
  if (until && until !== at) {
    return { bar: null, why: `a ${at}–${until} window fires on any bar inside it` };
  }
  if (fill === 'close') return { bar: at, why: `fill 'close' decides on the ${at} bar` };
  // 'live' belongs with the next-open models, not with 'close'. It measures
  // every level from the decision bar's close exactly as 'desk' does; the only
  // difference is that it does not need the fill bar to exist yet, which is
  // what lets the desk take the backtest's decision in real time.
  if (fill === 'next_open' || fill === 'desk' || fill === 'live') {
    const prev = shift(at, -1);
    return { bar: prev, why: `fill '${fill}' fills at the ${at} open, so it decides on ${prev}` };
  }
  return { bar: null, why: `unknown fill model ${JSON.stringify(fill)}` };
}

/** One comparison: what live does, what the backtest did, and whether they agree. */
function row(what, live, backtest, note) {
  const known = live !== null && live !== undefined
    && backtest !== null && backtest !== undefined;
  return {
    what,
    live: live === null || live === undefined ? null : live,
    backtest: backtest === null || backtest === undefined ? null : backtest,
    // UNKNOWN is its own answer. Reporting an un-made comparison as a match is
    // how the first three divergences survived two weeks of looking at them.
    status: !known ? 'unknown' : (String(live) === String(backtest) ? 'match' : 'differ'),
    note: note || null,
  };
}

/**
 * Compare one live setup against the spec of a backtest that was run on it.
 *
 * @param setup     from the catalogue: { id, name, decisionTime, windowEnd, fill }
 * @param spec      the stored `spec` of the backtest being compared against
 * @param strategy  the qp strategy, for its risk block (window_start/_end)
 * @returns { setup, rows, differs, unknown }
 */
function compare({ setup, spec, strategy } = {}) {
  const s = setup || {};
  const bt = spec || {};
  const st = strategy || {};
  const r = (st.risk || {});
  const live = risk.settings();
  const p = prefs.settingsFor(s.id) || {};

  // The desk's fill model, which is 'live' unless a preference says otherwise
  // — the same default runner.js applies when it calls qp.
  const liveFill = p.fill || s.fill || 'live';
  const btFill = bt.fill || null;

  const wStart = r.window_start !== undefined ? r.window_start : null;
  const wEnd = r.window_end !== undefined ? r.window_end : null;
  const liveBar = decisionBar(wStart, wEnd, liveFill);
  const btBar = btFill ? decisionBar(wStart, wEnd, btFill) : { bar: null, why: 'the backtest spec names no fill model' };

  const rows = [];

  /*
   * FIRST, because it is the one that changes which SIGNALS EXIST. Everything
   * below only changes what a signal is worth; this changes whether it happens.
   */
  rows.push(row('decision bar', liveBar.bar, btBar.bar,
    `${liveBar.why} · backtest: ${btBar.why}`));
  /*
   * 'live' and 'desk' are the SAME DECISION. They read the same bar, measure
   * the stop and the target from the same close, and rank on the same number;
   * they differ only in the entry PRICE they report, and only because one is a
   * plan and the other is a measurement taken afterwards. Calling that a
   * difference would leave a correctly aligned desk permanently red, which is
   * how a checker gets ignored.
   */
  const sameDecision = (a, b) => {
    const nextOpen = new Set(['next_open', 'desk', 'live']);
    return a === b || (nextOpen.has(a) && nextOpen.has(b));
  };
  const fillRow = row('fill model', liveFill, btFill,
    "'live' and 'desk'/'next_open' take the same decision from the same bar — "
    + "'close' books the signal bar's own close, a price no order can reach");
  if (fillRow.status === 'differ' && sameDecision(liveFill, btFill)) {
    fillRow.status = 'match';
  }
  rows.push(fillRow);

  // RANKING — which of the day's signals are taken at all.
  const btRank = bt.rank_per_day || null;
  rows.push(row('rank metric', p.rankMetric || null, (btRank && btRank.metric) || null));
  rows.push(row('rank top N', p.topN || null, (btRank && btRank.top_n) || null));

  // SIZING — how big each one is, and how many the balance can carry.
  const btRiskUsd = bt.risk_usd || null;
  const btRiskPct = bt.risk_pct || null;
  /*
   * A SETUP MAY OVERRIDE THE ACCOUNT. `riskPerTrade` and `maxPositionPct` exist
   * on both the account and the setup, and the setup wins where it is set — so
   * comparing the account figure alone would report a match on a setup that is
   * sized differently from it.
   */
  const liveRiskUsd = p.riskPerTrade || live.riskPerTrade || null;
  rows.push(row('risk model', liveRiskUsd ? 'fixed $' : null,
    btRiskUsd ? 'fixed $' : (btRiskPct ? '% of equity' : null),
    'a percentage COMPOUNDS and a flat dollar does not — over a fortnight that '
    + 'is a size difference nothing in either report mentions'));
  rows.push(row('risk per trade', liveRiskUsd,
    btRiskUsd || (btRiskPct && bt.account_equity
      ? Math.round(bt.account_equity * btRiskPct) / 100 : null),
    btRiskPct && !btRiskUsd ? "backtest figure is the FIRST trade's budget; it compounds from there" : null));
  rows.push(row('account size', live.accountSize || null, bt.account_equity || null));
  // maxPositionPct defaults to 100 live (no cap); the backtest treats absent as
  // no cap too, so 100 and absent mean the same thing and must compare equal.
  const liveCapRaw = p.maxPositionPct || live.maxPositionPct;
  const liveCap = liveCapRaw === 100 ? null : (liveCapRaw || null);
  const btCap = bt.max_position_pct || null;
  rows.push(row('max position %', liveCap, btCap,
    'absent on either side means NO cap — the first tight stop can take the '
    + 'balance and the rest of the day is skipped for lack of capital'));

  /*
   * HOW MANY TRADES A DAY. Live caps with maxTradesPerDay; the backtest caps
   * with the strategy's own max_entries_per_day unless the run overrode it.
   * These are the same rule kept in two places, which is how they drift.
   *
   * NOTE the two are not the same UNIT when a setup runs a long book and a
   * short book: qp's cap is per STRATEGY per symbol, the desk's is across the
   * whole day. Reported side by side rather than declared equal.
   */
  rows.push(row('max entries / day',
    p.maxTradesPerDay || null,
    (bt.rules && bt.rules.max_entries_per_day) || r.max_entries_per_day || null,
    "qp's cap is per strategy per symbol; the desk's is the whole day's budget"));

  // THE UNIVERSE the signals are drawn from.
  const btUni = bt.universe || {};
  rows.push(row('universe', (s.tools || []).join(',') || null,
    btUni.kind === 'tools' ? (btUni.tools || []).join(',') || null
      : (btUni.kind === 'register' ? btUni.register : btUni.kind) || null));
  rows.push(row('timeframe', p.tf || s.tf || '1m', bt.tf || null));
  rows.push(row('feed', p.feed || s.feed || null, bt.feed || null));

  const differs = rows.filter(x => x.status === 'differ');
  const unknown = rows.filter(x => x.status === 'unknown');
  return { setup: s.id || s.name || null, rows, differs, unknown };
}

/** A short human summary — the lines that are wrong, worst first. */
function summarise(result) {
  const out = [];
  if (!result || !result.rows) return out;
  // The decision bar leads whenever it differs: every other line describes a
  // trade, and this one describes whether the trade is the same trade.
  const order = { 'decision bar': 0, 'fill model': 1 };
  const bad = [...result.differs].sort(
    (a, b) => (order[a.what] ?? 9) - (order[b.what] ?? 9));
  for (const d of bad) {
    out.push(`${d.what}: live ${d.live} · backtest ${d.backtest}`
      + (d.note ? ` — ${d.note}` : ''));
  }
  for (const u of result.unknown) {
    out.push(`${u.what}: NOT COMPARED (live ${u.live === null ? 'unset' : u.live}`
      + `, backtest ${u.backtest === null ? 'unset' : u.backtest})`);
  }
  return out;
}

module.exports = { compare, summarise, decisionBar, hhmm, shift, row };
