/*
 * Setups: named strategies that run once at a fixed moment, on one tool.
 *
 * A setup is not an alert rule. An alert rule watches every card on every scan
 * and fires the moment one crosses a level — it is a tripwire. A setup wakes up
 * once, looks at the whole universe at that instant, RANKS it, and takes the
 * best two. Nothing about that fits a per-row comparison: the answer depends on
 * the other candidates, and it only exists at one time of day.
 *
 * Each setup declares the tool it belongs to. All nine screener processes load
 * this file, and each runs only its own — T2's setup needs T2's card list, and
 * asking T1 to evaluate it would be evaluating a different universe.
 */

const vwapExtension = require('./vwapExtension');

const SETUPS = [
  {
    id: 'T2-VWAP-EXT',
    name: 'T2 10:00 VWAP extension',
    toolId: 'T2',
    // Evaluated once the bar before this has closed. The spec tested 09:35 and
    // 09:45 and both were worse, so this is a result rather than a preference.
    decisionTime: '10:00',
    // The scan that fixes the universe. The regular discovery cron lands at
    // 09:55 and the next is not until 10:00, which would leave the candidate
    // list five minutes stale at the one moment it is read. Cheap insurance:
    // one extra scan whose only job is to be recent.
    universeScanAt: '09:58',
    module: vwapExtension,
    params: vwapExtension.DEFAULTS,
    // Said in the alert itself, not just here. Eight trades over four days,
    // with the ranking metric chosen after looking at those four days.
    caution: '8 trades over 4 sessions, metric chosen in hindsight — not a validated edge. Trade small.',
    // Which feed actually serves this live, and why it is not the one the
    // numbers came from. Polygon's free plan is a day behind, so at 10:00 it
    // holds yesterday; it stays the backtest feed and Yahoo runs the decision.
    // The two agree on VWAP to within 0.06% on a liquid morning.
    liveFeed: 'yahoo (Polygon free is a day behind; they agree to ~0.06% on VWAP)',
    describe: [
      'At 10:00, on T2\'s card list only.',
      'Keep: price the right side of session VWAP, VWAP sloping the same way, close in the top 55% (long) or bottom 45% (short) of the 09:30–09:59 range.',
      'Drop: any name whose later morning low undercut its early low (long), or whose later high exceeded its early high (short).',
      'Rank what is left by distance from VWAP, furthest first. Take the top 2.',
      'Stop is the 10:00 VWAP and does not move. Target is 2R. Size by risk, not by dollars.',
    ],
  },
];

/** Every setup this tool is responsible for running. */
function forTool(toolId) {
  return SETUPS.filter(s => s.toolId === toolId);
}

function get(id) {
  return SETUPS.find(s => s.id === id) || null;
}

module.exports = { SETUPS, forTool, get };
