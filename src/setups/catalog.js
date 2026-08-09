/*
 * The setups a screener can run, read live from qp.
 *
 * WHY THERE IS NO LONGER A BINDING TO WRITE.
 *
 * A qp strategy already carries everything a setup needs to be scheduled:
 *
 *   tools               which screeners it belongs to — store.normalise_tools,
 *                       and the platform's own test says a setup carries its
 *                       tools rather than each tool listing its setups, so a
 *                       setup used by three tools is ONE object
 *   risk.window_start   the minute the entry window opens — the strategy's own
 *                       decision time, already used by every backtest
 *   side, entry, risk   the logic, which was never this side's business
 *
 * So asking someone to retype the tool and the time into a binding was asking
 * them to copy facts that already exist, and to keep two copies in step. Build
 * a strategy in qp, give it tools, and it appears here. Edit it there and this
 * follows. Delete it and it goes.
 *
 * WHAT STAYS ON THIS SIDE, because qp genuinely cannot hold it:
 *
 *   enabled             whether it runs at all
 *   universe            the card-field filter — bias, score, catalyst are this
 *                       screener's own analysis and no qp strategy can read them
 *   rank.topN           how many of the day's signals to take, if not two
 *
 * Those live in data/setup-prefs.json, keyed by the strategy name, and they are
 * preferences ABOUT a setup rather than a definition OF one.
 *
 * THE TIME COMES FROM THE STRATEGY. 10:00 is the T2 strategy's window, not a
 * property of setups — a 09:35 opening-range strategy must schedule at 09:35
 * without anyone remembering to say so.
 */

const qp = require('./qpClient');
const prefs = require('./prefs');

/** 1000 → '10:00'. qp stores the window as an integer HHMM. */
function hhmm(windowStart) {
  // Absent means absent. Number(null) and Number('') are both 0, which would
  // turn a strategy with no entry window into a setup scheduled for midnight —
  // one that never fires and never says why.
  if (windowStart === null || windowStart === undefined || windowStart === '') return null;
  const n = Number(windowStart);
  if (!Number.isFinite(n)) return null;
  const h = Math.floor(n / 100);
  const m = n % 100;
  if (h < 0 || h > 23 || m < 0 || m > 59) return null;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/** The scan that freshens the card list, shortly before the decision. */
function minutesBefore(time, mins) {
  const [h, m] = String(time).split(':').map(Number);
  const t = h * 60 + m - mins;
  if (!Number.isFinite(t) || t < 0) return null;
  return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
}

/*
 * A setup is a GROUP of qp strategies sharing a name and a decision.
 *
 * A long and a short are two strategies in qp and one setup here — they are the
 * same idea pointed both ways, they run at the same minute on the same list,
 * and ranking them separately would take the best long AND the best short every
 * day rather than the best two signals. Grouped by the name with any trailing
 * "(Long)" / "(Short)" removed, which is how the platform's own seeds are named.
 */
function baseName(name) {
  return String(name || '').replace(/\s*\((long|short)\)\s*$/i, '').trim();
}

/**
 * Every setup available to run, built from qp's strategies.
 *
 * Returns [] when qp is unreachable rather than throwing — the list is read to
 * draw a page and to schedule a job, and neither should fail because the chart
 * tool is restarting. A setup that cannot be listed simply does not run, and
 * the run itself reports a missing platform loudly.
 */
async function list() {
  let strategies = [];
  try {
    strategies = await qp.strategies();
  } catch {
    return [];
  }

  const groups = new Map();
  for (const s of strategies) {
    const tools = Array.isArray(s.tools) ? s.tools.filter(Boolean) : [];
    // A strategy with no tools is not a setup. It is something being worked on
    // in qp, and listing it here as runnable would be a promise nothing keeps.
    if (!tools.length) continue;

    const at = hhmm((s.risk || {}).window_start);
    // Nor is one with no entry window: a setup is defined by deciding at a
    // moment, and without one there is nothing to schedule.
    if (!at) continue;

    const key = `${baseName(s.name)}@${at}`;
    if (!groups.has(key)) {
      groups.set(key, {
        id: key,
        name: baseName(s.name),
        strategyId: baseName(s.name),
        tools: [],
        decisionTime: at,
        universeScanAt: minutesBefore(at, 2),
        sides: [],
        strategies: [],
      });
    }
    const g = groups.get(key);
    for (const t of tools) if (!g.tools.includes(t)) g.tools.push(t);
    if (s.side && !g.sides.includes(s.side)) g.sides.push(s.side);
    g.strategies.push(s.name);
  }

  // The parts qp cannot hold, merged on top.
  return [...groups.values()].map(g => {
    const p = prefs.settingsFor(g.id);
    return {
      ...g,
      enabled: prefs.isEnabled(g.id),
      universe: p.universe || null,
      rank: { metric: 'vwap_extension', topN: p.topN || 2 },
      tf: p.tf || '1m',
      feed: p.feed || 'yahoo',
      targetR: p.targetR || 2.0,
      fill: p.fill || 'close',
      liveFeed: p.feed || 'yahoo',
      caution: p.caution
        || 'Backtest it in qp before trusting it live. Trade small until the sample grows.',
      describe: [
        `At ${g.decisionTime} ET, on the card list of ${g.tools.join(', ')}.`,
        `Decided by the qp strategy "${g.name}" (${g.sides.join(' and ') || 'long'}).`,
        `Ranked by distance from VWAP, top ${p.topN || 2}.`,
      ],
    };
  });
}

/** The setups one tool is responsible for running. */
async function forTool(toolId) {
  return (await list()).filter(s => s.tools.includes(toolId));
}

async function get(id) {
  return (await list()).find(s => s.id === id) || null;
}

module.exports = { list, forTool, get, hhmm, baseName, minutesBefore };
