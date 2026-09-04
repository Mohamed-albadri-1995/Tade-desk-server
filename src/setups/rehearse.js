/*
 * RUNNING A SETUP'S WHOLE CHAIN, AT ANY MINUTE, WITHOUT TRADING.
 *
 * WHY THIS EXISTS. `OR + VWAP 09:35` decides on one bar. When it failed, the
 * next chance to find out why was the following morning at 09:35 — and the
 * morning after that. Checking a machine cannot require being at the phone at
 * one particular minute, and it cannot cost a session when the answer is "it
 * would not have worked".
 *
 * WHAT IT PROVES, AND WHAT IT DOES NOT.
 *
 *   it proves    every leg answers: the tool has cards, the filter keeps some,
 *                qp decides, the ranking cuts, the risk rule sizes, the routing
 *                resolves to an account, and an order could be formed
 *   it does not  that the strategy would have taken this trade. Asked at 14:00
 *                it decides on the 14:00 bar, which is not the setup's bar
 *
 * That distinction is the whole design. Asking about 09:35 from 14:00 would
 * report a feed five hours behind and read as a total failure — a true number
 * about a question nobody asked, which is this repo's oldest bug wearing new
 * clothes. So a rehearsal asks about NOW, and the lag it measures is reported
 * as a fact about the feed rather than as the rehearsal failing.
 *
 * NOTHING IS PUBLISHED AND NOTHING IS PLACED. `runner.runSetup` forces dryRun
 * when `rehearsal` is set, so no alert reaches the feed and no order reaches a
 * broker. The last leg says what WOULD have been sent, in the same words the
 * alert would have used.
 *
 * THE RULE IT INHERITS FROM THE PREFLIGHT: untested is not passed. A leg that
 * could not be reached — nothing qualified, so nothing was sized — comes back
 * `null`, never `true`. A rehearsal that found no picks has proven the first
 * half of the chain and NOTHING about the second, and must say so.
 */

const runner = require('./runner');
const { verdict } = require('../alerts/preflight');

/*
 * The same two minutes the runner, the session log and the preflight already
 * use. One bar of lag is normal by construction — the desk's own order lands a
 * bar late — and two is a decision taken on a bar the market has moved past.
 */
const LAG_BAD_MIN = 2;

/*
 * Feeds whose free tier is delayed, so the lag can be EXPLAINED rather than
 * merely reported. `yahoo` is what a setup gets by not choosing one, and its
 * fifteen minutes is why a 09:35 decision is taken on the 09:20 bar.
 */
const DELAYED_FEEDS = new Set(['yahoo']);

const leg = (id, title, ok, note, detail = undefined) =>
  ({ id, title, ok, note, ...(detail === undefined ? {} : { detail }) });

/** Not reached, which is not the same as fine. */
const unreached = (id, title, why) => leg(id, title, null, why);

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const picksOf = (res) => (Array.isArray(res && res.picks) ? res.picks : []);

/* ── the legs ───────────────────────────────────────────────────────────── */

function legCards(res) {
  const cards = num(res.cards);
  if (cards === null) {
    return unreached('cards', 'Cards on the list',
      'the run did not report a card count');
  }
  if (!cards) {
    return leg('cards', 'Cards on the list', false,
      'the tool has no cards today, so there is nothing for the setup to rank. '
      + 'Check the tool is scanning and not paused.', { cards: 0 });
  }
  return leg('cards', 'Cards on the list', true,
    `${cards} card${cards === 1 ? '' : 's'} on this tool's list`, { cards });
}

function legFilter(res) {
  const g = res.gate || {};
  if (!g.filtered) {
    return leg('filter', 'The setup\'s filter', true,
      'no filter on this setup — every card goes through', { filtered: false });
  }
  const kept = num(g.kept) || 0;
  const dropped = num(g.dropped) || 0;
  if (!kept) {
    return leg('filter', 'The setup\'s filter', false,
      `the filter removed all ${dropped} card(s), so nothing reached qp`,
      { kept, dropped, reasons: g.reasons || {} });
  }
  return leg('filter', 'The setup\'s filter', true,
    `${kept} kept, ${dropped} dropped`, { kept, dropped, reasons: g.reasons || {} });
}

/*
 * THE LEG THIS WHOLE THING WAS BUILT FOR. qp not answering inside its budget is
 * what lost 2026-09-03: one attempt, forty-five seconds, and a clock setup's
 * window is sixty. It is also the one leg that cannot be checked by reading
 * anything — the platform either answers or it does not.
 */
function legDecision(res, err, ms) {
  if (err) {
    return leg('decision', 'qp decided', false,
      `qp did not answer: ${err.message}`, { ms });
  }
  const c = res.counts || {};
  const evaluated = num(c.evaluated);
  if (evaluated === null) {
    return unreached('decision', 'qp decided',
      'the run returned before qp was asked — see the legs above');
  }
  return leg('decision', 'qp decided', true,
    `${evaluated} symbol(s) evaluated, ${num(c.signalled) || 0} signalled`
    + `, ${Math.round(ms / 100) / 10}s`,
    { evaluated, signalled: num(c.signalled) || 0,
      errored: num(c.skipped) || 0, ms });
}

/*
 * HOW FAR BEHIND THE FEED IS — reported, not treated as this rehearsal failing.
 *
 * A delayed feed does not error. qp reads whatever bars exist and answers about
 * those, so the desk asks about 14:02 and is told about 13:47, and every number
 * in the decision belongs to that older bar. It is a real problem and it is the
 * reason a 09:35 setup takes nothing, so the leg is red — but the note says
 * what it is and what to do, because "delay error" on its own has been read as
 * the test itself being broken.
 */
function legFeed(setup, res) {
  /*
   * NOT REACHED IS NOT "ANSWERED WITHOUT A STAMP". A run that ended before qp
   * was asked — no cards, or the filter removed every one — has no `data` at
   * all, and the first version fell through to the setup's configured feed and
   * said "yahoo answered, but not with a bar stamp". Yahoo had not been asked.
   * Seen on the Test setup's rehearsal, 2026-09-04.
   */
  if (!res.data) {
    return unreached('feed', 'How current the bars are',
      'not reached — the run ended before qp was asked, so no feed answered');
  }
  const d = res.data;
  const feed = d.feed || setup.feed || setup.liveFeed || null;
  if (!feed) {
    return unreached('feed', 'How current the bars are',
      'the run did not report which feed it used');
  }
  const lag = num(d.lagMin);
  const bars = { feed, askedBar: d.askedBar || null, lastBar: d.lastBar || null,
                 lagMin: lag, delayed: DELAYED_FEEDS.has(String(feed).toLowerCase()) };
  if (lag === null) {
    /*
     * NULL IS NOT ZERO. qp before the last change reported no bar at all, and a
     * lag of zero on a desk that cannot measure one is the most reassuring
     * wrong answer available.
     */
    return unreached('feed', 'How current the bars are',
      `${feed} answered, but not with a bar stamp — the lag cannot be measured`);
  }
  if (lag >= LAG_BAD_MIN) {
    return leg('feed', 'How current the bars are', false,
      `${feed} is ${lag} minute(s) behind: asked about ${bars.askedBar}, `
      + `answered about ${bars.lastBar}.`
      + (bars.delayed
        ? ` That is ${feed}'s delay, not a fault — but on a one-minute setup it `
          + 'means the decision is taken on a bar the market has moved past. '
          + 'Everything else here still ran; this is the leg to fix if the '
          + 'setup keeps taking nothing.'
        : ' Nothing about the plumbing — the bars themselves are arriving late.'),
      bars);
  }
  return leg('feed', 'How current the bars are', true,
    `${feed}, ${lag} minute(s) behind — the decision is on the current bar`, bars);
}

function legRank(res) {
  const r = res.rank || {};
  const picks = picksOf(res);
  if (!r.metric && !num(r.top_n)) {
    return leg('rank', 'The ranking', true,
      `no ranking configured — every signal is taken (${picks.length} here)`,
      { picks: picks.length });
  }
  /*
   * A CUT ASKED FOR AND NOT HONOURED. "top 2" of an unordered list is two
   * arbitrary names, and it looks exactly like a working ranking.
   */
  if (num(r.ignored_top_n)) {
    return leg('rank', 'The ranking', false,
      `top ${r.ignored_top_n} was asked for and could not be applied — `
      + 'the list was not ranked, so the names taken would be arbitrary',
      { metric: r.metric || null, ignoredTopN: num(r.ignored_top_n) });
  }
  return leg('rank', 'The ranking', true,
    `by ${r.metric || 'nothing'}${num(r.top_n) ? `, top ${r.top_n}` : ''}`
    + ` → ${picks.length} pick(s)`,
    { metric: r.metric || null, topN: num(r.top_n), picks: picks.length,
      unscorable: (r.unscorable || []).length ? r.unscorable : undefined });
}

/*
 * SIZING AND ROUTING ARE ONLY REACHED WHEN SOMETHING QUALIFIED.
 *
 * On a quiet bar there is nothing to size and nowhere to send it, and that is
 * `null` — untested — for both. Rendering them green because nothing went
 * wrong is precisely the silence-as-a-pass this desk keeps being caught by.
 */
function legSize(res) {
  const picks = picksOf(res);
  const cfg = res.riskCfg || null;
  if (!cfg) {
    return unreached('size', 'Position sizing',
      'the run ended before sizing — nothing reached it');
  }
  const rule = cfg.riskRule
    || (num(cfg.riskPct) ? `${cfg.riskPct}% of the account` : null)
    || (num(cfg.riskPerTrade) ? `$${cfg.riskPerTrade} a trade` : null);
  const detail = { rule, from: (cfg.sources || {}).risk || null,
                   accountSize: num(cfg.accountSize),
                   shares: picks.map(p => ({ ticker: p.ticker, shares: num(p.shares) })) };
  if (!picks.length) {
    return unreached('size', 'Position sizing',
      `nothing qualified on this bar, so nothing was sized. The rule that WOULD `
      + `have sized it: ${rule || 'none set'}`);
  }
  const unsized = picks.filter(p => !num(p.shares));
  if (unsized.length) {
    return leg('size', 'Position sizing', false,
      `${unsized.map(p => p.ticker).join(', ')} came out at zero shares — `
      + 'the risk rule cannot fund this trade', detail);
  }
  return leg('size', 'Position sizing', true,
    picks.map(p => `${p.ticker}: ${p.shares} shares`).join(' · ')
    + ` (${rule || 'no rule set'})`, detail);
}

function legRouting(res) {
  const r = res.routing || null;
  if (!r) {
    return unreached('routing', 'Where the order would go',
      'the run ended before routing — nothing reached it');
  }
  const to = r.to || [];
  if (r.orderable === false) {
    /*
     * ALERT-ONLY ON PURPOSE is not a fault. A rule-exit strategy cannot be sent
     * to a broker: no broker watches for a VWAP cross, and giving it a price
     * target instead would place a different strategy under the same name.
     */
    return leg('routing', 'Where the order would go', true,
      'this setup alerts and does not trade'
      + ((r.blocking || []).length ? ` — ${r.blocking.join('; ')}` : ''),
      { orderable: false, blocking: r.blocking || [] });
  }
  if (r.error) {
    return leg('routing', 'Where the order would go', false,
      r.error, { to, error: r.error });
  }
  if (!to.length) {
    return leg('routing', 'Where the order would go', false,
      'no account claims this setup, so a signal would alert and never trade',
      { to: [] });
  }
  return leg('routing', 'Where the order would go', true,
    `→ ${to.join(', ')}`, { to });
}

/*
 * THE LAST LEG, and it is deliberately not an order. What would have been sent,
 * in the words the alert would have used — so the thing being checked is the
 * one that would actually have gone out.
 */
function legOrder(setup, res) {
  const picks = picksOf(res);
  if (!picks.length) {
    return unreached('order', 'What would have been sent',
      'nothing qualified on this bar, so there was nothing to send. '
      + 'The legs above are what this rehearsal proves.');
  }
  const lines = picks.map(p => `${runner.describePick(p, { shares: p.shares })} — NOT PLACED`);
  return leg('order', 'What would have been sent', true, lines.join(' · '),
    { lines, placed: false });
}

/* ── the report ─────────────────────────────────────────────────────────── */

/**
 * Run every leg for one setup and report each separately.
 *
 * `run` is injected so the legs can be tested against a known result rather
 * than against whatever the market is doing — a check of the checker.
 */
async function rehearse(setup, { run = runner.runSetup } = {}) {
  const started = Date.now();
  let res = null;
  let err = null;
  try {
    res = await run(setup, { rehearsal: true });
  } catch (e) {
    err = e;
  }
  const ms = Date.now() - started;
  res = res || {};

  const legs = [];
  if (err) {
    /*
     * A THROW STOPS THE CHAIN, and every leg after it is UNTESTED rather than
     * failed. Marking them all red would say seven things are broken when one
     * is, and the one that matters would be buried among six guesses.
     */
    legs.push(unreached('cards', 'Cards on the list', 'the run threw before it got here'));
    legs.push(unreached('filter', 'The setup\'s filter', 'not reached'));
    legs.push(legDecision(res, err, ms));
    legs.push(unreached('feed', 'How current the bars are', 'not reached'));
    legs.push(unreached('rank', 'The ranking', 'not reached'));
    legs.push(unreached('size', 'Position sizing', 'not reached'));
    legs.push(unreached('routing', 'Where the order would go', 'not reached'));
    legs.push(unreached('order', 'What would have been sent', 'not reached'));
  } else if (res.ok === false) {
    // The setup belongs to another tool. Not an error and not a pass: run it
    // there, where the card list is the one it is meant to rank.
    legs.push(unreached('cards', 'Cards on the list', res.reason || 'refused'));
    for (const [id, title] of [['filter', 'The setup\'s filter'],
      ['decision', 'qp decided'], ['feed', 'How current the bars are'],
      ['rank', 'The ranking'], ['size', 'Position sizing'],
      ['routing', 'Where the order would go'],
      ['order', 'What would have been sent']]) {
      legs.push(unreached(id, title, 'not reached'));
    }
  } else {
    legs.push(legCards(res));
    legs.push(legFilter(res));
    legs.push(legDecision(res, null, ms));
    legs.push(legFeed(setup, res));
    legs.push(legRank(res));
    legs.push(legSize(res));
    legs.push(legRouting(res));
    legs.push(legOrder(setup, res));
  }

  return {
    ok: !err && res.ok !== false,
    rehearsal: true,
    setupId: setup.id,
    setup: setup.name,
    at: Date.now(),
    ms,
    // WHICH BAR IT ACTUALLY ASKED ABOUT — the current minute, not the setup's.
    // Without it the report reads as a run of the strategy, which it is not.
    bar: (res.data || {}).askedBar || null,
    decidesOn: setup.decidesOnBar || setup.decisionTime || null,
    picks: picksOf(res).length,
    legs,
    // Counted apart, exactly as the preflight does. `untested` never adds to
    // `passed`, because the day this desk starts reporting six unknowns as six
    // passes is the day the report stops being worth reading.
    passed: legs.filter(l => l.ok === true).length,
    failed: legs.filter(l => l.ok === false).length,
    untested: legs.filter(l => l.ok === null).length,
    verdict: verdict(legs.map(l => ({ ok: l.ok }))),
    note: 'A rehearsal decides on the CURRENT bar, publishes nothing and places '
      + 'nothing. It proves the machine answers, not that the strategy would '
      + 'have taken this trade.',
  };
}

/*
 * EVERY SETUP THIS TOOL OWNS, REHEARSED WITHOUT ANYONE PRESSING ANYTHING.
 *
 * The button answers "does it work" when you think to ask. This answers it
 * every morning before the open, so the check is something you READ rather than
 * something you have to be at the phone for — which is the whole complaint:
 * you cannot wait for one exact minute every day to find out.
 *
 * It also warms qp. The decision budget is two attempts of eighteen seconds,
 * and a platform answering its first request of the day cold has used most of
 * that before it starts. A rehearsal ten minutes earlier makes the 09:35 call a
 * warm one, whatever else it finds.
 *
 * QUIET WHEN EVERYTHING ANSWERED. A line every morning saying "fine" is the
 * kind of message that trains you to stop reading the feed, and then the one
 * that matters arrives into a habit of not looking. One alert per setup whose
 * chain did not come back whole, and silence otherwise.
 */
async function rehearseAll({ publish = true, day = null, deps = {} } = {}) {
  const catalog = deps.catalog || require('./catalog');
  const prefs = deps.prefs || require('./prefs');
  const alertStore = deps.alertStore || require('../alerts/store');
  const config = deps.config || require('../config');
  const { toETDate } = require('../utils/time');
  const date = day || toETDate(Date.now());

  let mine = [];
  try {
    mine = (await catalog.forTool(config.toolId)).filter(s => prefs.isEnabled(s.id));
  } catch (err) {
    console.warn('[Rehearsal] could not read the catalog:', err.message);
    return [];
  }
  const out = [];
  for (const setup of mine) {
    let report;
    try {
      report = await rehearse(setup, deps.run ? { run: deps.run } : {});
    } catch (err) {
      // A rehearsal that throws is itself a finding, and must not take the
      // other setups' rehearsals with it.
      report = { ok: false, setupId: setup.id, setup: setup.name, legs: [],
                 passed: 0, failed: 1, untested: 0, verdict: false,
                 note: `the rehearsal itself failed: ${err.message}` };
    }
    out.push(report);
    console.log(`[Rehearsal] ${setup.id}: ${report.passed} answered, `
      + `${report.failed} failed, ${report.untested} untested`);
    if (!publish || !report.failed) continue;
    const broken = (report.legs || []).filter(l => l.ok === false);
    alertStore.publishFires([{
      ruleId: setup.id, rule: setup.name, ticker: null, toolId: config.toolId,
      date, at: Date.now(), kind: 'setup', level: 'warn',
      detail: `REHEARSAL — ${broken.length} leg(s) did not come back: `
        + broken.map(l => `${l.title}: ${l.note}`).join(' · ')
        + '. Nothing was published or placed; this was a check of the chain, '
        + 'taken on the current bar.',
    }], date);
  }
  return out;
}

module.exports = {
  rehearse, rehearseAll,
  // Exported to be tested one at a time: a leg only reachable through the whole
  // report is a leg whose failure is only ever seen alongside seven others.
  legCards, legFilter, legDecision, legFeed, legRank, legSize, legRouting, legOrder,
  LAG_BAD_MIN, DELAYED_FEEDS,
};
