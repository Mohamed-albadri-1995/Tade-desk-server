/*
 * THE SETTINGS A BACKTEST OF A SETUP MUST BE RUN WITH — the desk's own, in the
 * key names chart/backtest.py reads.
 *
 * Moved out of src/routes/setups.js (GET /api/setups/backtest-defaults, which
 * fills the qp backtest form) so the daily live-vs-backtest check
 * (src/setups/dayCheck.js) runs its backtest from the SAME function. Two copies
 * of "what live does" would be two chances to disagree about it.
 */
const risk = require('./risk');

function specFor(s, account = risk.settings()) {
  /*
   * RESOLVED ACROSS THE LEVELS, never read off the account.
   *
   * The setup holds its own risk rule and cap — that is where adoption writes
   * them, so that one strategy's winner cannot resize another's trades. This
   * used to read `s.riskPerTrade || account.riskPerTrade`, which knew nothing
   * about a PERCENTAGE at either level: a setup sized at 0.5% reported no
   * risk at all, and the backtest form opened with the money boxes empty.
   */
  const eff = risk.resolve(account, s);
  // 100% live means NO cap, which is what an absent cap means in the
  // backtest — sending 100 would make them differ while meaning the same.
  const cap = (eff.maxPositionPct && eff.maxPositionPct !== 100) ? eff.maxPositionPct : 0;
  return {
    account_equity: eff.accountSize || 0,
    // WHICHEVER RULE IS IN FORCE, in its own unit. Converting a percentage
    // into dollars here would put a number in the form that reproduces the
    // first trade and nothing after it, because a backtest compounds.
    risk_usd: eff.riskPerTrade || 0,
    risk_pct: eff.riskPerTrade ? 0 : (eff.riskPct || 0),
    max_position_pct: cap,
    rank_per_day: ((s.rank || {}).metric && (s.rank || {}).topN)
      ? { metric: s.rank.metric, top_n: s.rank.topN,
          direction: s.rank.direction || null }
      : null,
    tf: s.tf || '1m',
    /*
     * THE FEED THE DESK WILL DECIDE ON, not the one written in the
     * preference. A backtest is evidence about the desk only if it ran on
     * the desk's bars: a preference of polygon backtests a year and cannot
     * decide this morning, so the desk substitutes (setups/feeds.js) and the
     * form has to open on the substitute — or the numbers describe a feed
     * that will never trade. The choice and the reason travel beside it.
     */
    feed: s.feed || null,
    chosenFeed: s.chosenFeed || null,
    feedNote: s.feedNote || null,
    view: s.view || 'all',
    /*
     * THE FILL MODEL A BACKTEST OF THIS SETUP MUST USE.
     *
     * The desk runs 'live', which cannot be backtested — it reports the
     * decision price as the entry because live has no fill price yet. Its
     * backtestable twin is 'desk': the same decision from the same bar with
     * the same levels, plus the fill the next bar's open really gave.
     */
    fill: (s.fill === 'live' || !s.fill) ? 'desk' : s.fill,
    universe: (s.tools || []).length
      ? { kind: 'tools', register: 'R1', tools: s.tools }
      : null,
    /*
     * THE DESK'S TWO LIMITS, as the desk applies them (backtest.desk_caps):
     * one entry per stock per day — the runner's latch — and at most
     * maxTradesPerDay trades a day for the whole setup. This used to send
     * maxTradesPerDay as `max_entries_per_day`, which the engine applies
     * PER STOCK: the backtest re-entered names live never re-enters, and
     * took seven trades on a day live stops at three (#367, 2026-09-11).
     *
     * AND THE DESK'S SESSION: entries 09:30-15:50, everything closed by
     * 15:50 — the flattener's clock, and what chart/decide.py decides
     * under (DESK_RULES). A run without it holds trades overnight.
     */
    rules: { rth_entries: true, eod_close: true,
      one_per_symbol_day: true, max_trades_per_day: s.maxTradesPerDay || null },
  };
}

module.exports = { specFor };
