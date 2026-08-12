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
/*
 * `mins` minutes before `time`. A NEGATIVE count reads as after, which is how
 * the run minute is derived from the decision minute: a setup decides on the
 * 09:35 bar and runs at 09:36, once that bar has closed.
 */
function minutesBefore(time, mins) {
  const [h, m] = String(time).split(':').map(Number);
  const t = h * 60 + m - mins;
  if (!Number.isFinite(t) || t < 0 || t >= 24 * 60) return null;
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
/*
 * WHY A PAIR SOMETIMES FAILS TO PAIR, said out loud instead of discovered.
 *
 * Two strategies become one setup only when their names differ by a trailing
 * "(Long)"/"(Short)" AND their entry windows are identical. Both halves are
 * easy to break by accident, and breaking either is SILENT: the alerts page
 * simply lists two setups where one was meant, each ranked on its own, so
 * "top 2" quietly becomes the best two longs and the best two shorts.
 *
 * Worse, the setup id is `name@time`. A pair that splits gets ids nothing else
 * knows about — journal trades tagged with the old one show a raw string, and
 * saved preferences stay attached to a setup that no longer exists.
 *
 * So each group carries a note when something about it looks unpaired:
 *   - the same name decided at two different times (a nudged window)
 *   - a name ending in Long/Short WITHOUT the brackets, which is not stripped
 * Both are observations, never corrections. Renaming someone's strategy to fit
 * a regex would be a worse surprise than the one being reported.
 */
function pairingNote(g, groups) {
  const notes = [];
  const twins = [...groups.values()].filter(
    o => o !== g && o.name === g.name);
  if (twins.length) {
    notes.push(`also decided at ${twins.map(o => o.decisionTime).join(', ')} — `
      + 'same name, different entry window, so these are separate setups '
      + 'ranked separately. Match the windows to make them one.');
  }
  for (const r of g.raw || []) {
    if (/\b(long|short)\b\s*$/i.test(baseName(r.name || ''))) {
      notes.push(`"${r.name}" ends in long/short without brackets — only a `
        + 'trailing "(Long)" or "(Short)" is stripped, so it will not pair '
        + 'with its other side.');
    }
  }
  return notes;
}


function baseName(name) {
  return String(name || '').replace(/\s*\((long|short)\)\s*$/i, '').trim();
}

/**
 * Can this strategy produce a clean alert and a clean order?
 *
 * NOTHING IS INFERRED HERE ANY MORE. qp reports an exit protocol on every
 * strategy — how many parts the position is cut into, where each part's stop
 * and target are, what is left for a human — and this reads it. That is the
 * point of the protocol: the exit is decided once, next to the engine that
 * executes it, rather than guessed separately by everything downstream. A guess
 * that is right for some strategies and wrong for others does not fail; it
 * places a real order of the wrong size with the wrong stop.
 *
 * What is added on this side is only what qp cannot know: whether the strategy
 * has entry rules at all, and which SIDE a fault belongs to when a long and a
 * short are one setup.
 */
function readiness(strategies) {
  const blocking = [];
  const orderBlocking = [];
  const warnings = [];
  const shapes = [];

  for (const s of strategies) {
    const label = strategies.length > 1 ? `${s.side || s.name}: ` : '';
    const p = s.exit_protocol;

    if (!p || !p.version) {
      // qp not reporting one at all means the platform is older than the
      // protocol. Blocking, because the alternative is this side inferring the
      // exit again — which is what the protocol exists to stop.
      blocking.push(`${label}the chart tool did not report an exit protocol — `
        + 'restart it, or the exit would have to be guessed');
      continue;
    }

    if (!((s.entry || {}).rules || []).length) blocking.push(`${label}no entry rules`);
    for (const e of p.errors || []) blocking.push(`${label}${e}`);
    for (const e of p.order_errors || []) orderBlocking.push(`${label}${e}`);
    for (const w of p.warnings || []) warnings.push(`${label}${w}`);
    if (p.shape) shapes.push(p.shape);
  }

  return {
    ok: blocking.length === 0,
    /*
     * Alertable and orderable are different questions.
     *
     * A strategy that exits on a rule — a VWAP cross, an SMA cross — alerts
     * perfectly: its entry and its stop are both known at the decision. It
     * cannot be handed to a broker, because no broker watches for a cross, and
     * substituting a price target would place a different strategy from the one
     * the evidence describes. So it alerts and does not trade.
     */
    orderOk: blocking.length === 0 && orderBlocking.length === 0,
    orderBlocking: [...new Set(orderBlocking)],
    // The shape, for a person: "1 SL / 1 TP", "2 SL / 2 TP + runner (25%)".
    // One string when the long and short agree, which they normally do.
    shape: [...new Set(shapes)].join(' · ') || null,
    blocking: [...new Set(blocking)],
    warnings: [...new Set(warnings)],
  };
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
        // The qp rows behind the group. Carried because changing which tools
        // run a setup means writing to every strategy in it — a long and a
        // short are one setup, and assigning half of a pair gives one that
        // ranks half its signals while looking perfectly correct.
        strategyIds: [],
        // The raw qp rows, kept only to answer "is this tradeable" — never to
        // re-implement any part of the strategy on this side.
        raw: [],
      });
    }
    const g = groups.get(key);
    for (const t of tools) if (!g.tools.includes(t)) g.tools.push(t);
    if (s.side && !g.sides.includes(s.side)) g.sides.push(s.side);
    g.strategies.push(s.name);
    if (s.id !== undefined && s.id !== null) g.strategyIds.push(s.id);
    g.raw.push(s);
  }

  // The parts qp cannot hold, merged on top.
  return [...groups.values()].map(g => {
    const p = prefs.settingsFor(g.id);
    const { raw, ...rest } = g;
    const pairing = pairingNote(g, groups);
    return {
      ...rest,
      // Empty when nothing looks wrong, so a card can simply not show it.
      pairing,
      // Whether it can produce a clean alert and a clean order, said before the
      // morning rather than discovered during it.
      readiness: readiness(raw),
      enabled: prefs.isEnabled(g.id),
      // Off unless said otherwise. See the note in prefs: arming the broker is
      // permission for the box, not for every strategy in it.
      autoTrade: p.autoTrade === true,
      // The accounts this setup's orders go to, by destination id. Empty means
      // unsaid rather than none — broker.route decides what that means, and
      // refuses when there is more than one account to choose between.
      brokers: p.brokers || [],
      maxTradesPerDay: p.maxTradesPerDay || null,
      /*
       * SETUP-level risk, which is a different thing from account-level risk.
       *
       * The account says what a trade may lose. A setup may say less: a
       * strategy with four sessions behind it should not be sized like one with
       * four hundred, and having to edit the account figure before and after
       * each morning is how it ends up wrong. Absent means "use the account's".
       */
      riskPerTrade: p.riskPerTrade || null,
      maxPositionPct: p.maxPositionPct || null,
      universe: p.universe || null,
      /*
       * NO METRIC AND NO TOP-N UNLESS SAID.
       *
       * This used to read `{ metric: 'vwap_extension', topN: 2 }` for every
       * setup that had ever existed — a preference nobody chose, applied to
       * strategies whose edge is the opposite of it. A tight-stop setup ranked
       * by extension is ranked precisely against itself.
       *
       * Unset now means every signal is taken. That is more alerts on some
       * mornings and it is the honest answer: the alternative is a filter
       * running under a name that does not mention filtering.
       */
      rank: { metric: p.rankMetric || null,
              direction: p.rankDirection || null,
              topN: p.topN || 0 },
      tf: p.tf || '1m',
      feed: p.feed || 'yahoo',
      targetR: p.targetR || 2.0,
      fill: p.fill || 'close',
      liveFeed: p.feed || 'yahoo',
      caution: p.caution
        || 'Backtest it in qp before trusting it live. Trade small until the sample grows.',
      describe: [
        `Decided on the ${g.decisionTime} ET bar, run at `
          + `${minutesBefore(g.decisionTime, -1)} once that bar has closed, `
          + `on the card list of ${g.tools.join(', ')}.`,
        `Decided by the qp strategy "${g.name}" (${g.sides.join(' and ') || 'long'}).`,
        p.rankMetric
          ? `Ranked by ${p.rankMetric}${p.rankDirection ? ` (${p.rankDirection})` : ''}`
            + `${p.topN ? `, top ${p.topN}.` : ', all taken.'}`
          : 'Not ranked — every signal is taken.',
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

module.exports = { list, forTool, get, hhmm, baseName, minutesBefore, readiness };
