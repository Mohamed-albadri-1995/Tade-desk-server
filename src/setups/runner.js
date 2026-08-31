/*
 * Running a setup, and turning its picks into alerts you actually receive.
 *
 * This file knows about the clock, the card list and the alert feed. It does
 * not know how the setup decides anything — that is qp's, entirely. The
 * strategy is a seed built from qp primitives and the ranking is
 * chart/decide.py, using the same metric a backtest uses.
 *
 * There used to be a second implementation here, in JavaScript. Two engines for
 * one strategy means two readings of "ten bars back" and a live trade that can
 * disagree with the backtest that justified it, with no way to tell which is
 * right because both look correct. It is gone.
 *
 * A run always publishes something. If nothing qualifies, that is an answer —
 * "looked at 34, nothing qualified" — and it is the answer that stops you
 * wondering at 10:05 whether the thing ran at all. Silence and failure are
 * indistinguishable from a phone, so the setup never goes silent.
 */

const config = require('../config');
const r0 = require('../r0/registry');
const { toETDate } = require('../utils/time');
const catalog = require('./catalog');
const qp = require('./qpClient');
const risk = require('./risk');
const universeFilter = require('./universe');
const prefs = require('./prefs');
const broker = require('../broker/signalstack');
const alertStore = require('../alerts/store');

/*
 * HOW OLD A SIGNAL MAY BE AND STILL BE THE TRADE YOU ARE PLACING.
 *
 * One bar, and the reason is not tolerance for staleness — it is that the
 * desk's own order lands a bar late by construction. The decision is taken on
 * the close of the bar just finished and the market order reaches the tape
 * inside the next one, so a signal stamped one minute before the bar being
 * decided is the SAME trade seen through a feed that published a minute late.
 *
 * Refusing that would turn a one-bar feed lag into a setup that silently takes
 * nothing at all, every bar, for the whole window — the failure that is hardest
 * to notice, because a strategy finding nothing looks exactly like a quiet day.
 *
 * Anything older is a different trade. The setups run on 1-minute bars, so this
 * is one bar; it is expressed in minutes because that is what qp stamps.
 */
const STALE_TOLERANCE_MIN = 1;

/** How many minutes before `bar` a pick fired. 0 when it is the same bar. */
function staleBy(entryAt, bar) {
  const mins = (hhmm) => {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || ''));
    return m ? Number(m[1]) * 60 + Number(m[2]) : null;
  };
  const a = mins(entryAt);
  const b = mins(bar);
  // An unparseable stamp is not evidence of staleness. qp always sends one;
  // if it ever stops, dropping every pick would be the worst possible reading.
  if (a === null || b === null) return 0;
  // A pick from the FUTURE is not stale, and cannot happen — qp evaluates
  // closed bars. Clamped rather than made negative so the comparison is simple.
  return Math.max(0, b - a);
}

/** The minute before the decision — the last bar that must have closed. */
function lastWantedBar(decisionTime) {
  const [h, m] = String(decisionTime).split(':').map(Number);
  const prev = h * 60 + m - 1;
  return `${String(Math.floor(prev / 60)).padStart(2, '0')}:${String(prev % 60).padStart(2, '0')}`;
}

/** This tool's card list for today — the rows, not just the tickers. */
function universeRows() {
  return r0.getTodayRows().filter(r => r && r.ticker);
}

/** The universe: this tool's card list for today, and nothing else about it. */
function universe() {
  return universeRows().map(row => String(row.ticker).toUpperCase());
}

/**
 * One line a person can act on from a notification, without opening anything.
 * Direction, ticker, where the stop is and where the target is — the four
 * things needed to place the trade.
 */
function describePick(pick, size) {
  const p = pick.plan || {};
  const side = pick.signal === 'LONG' ? 'BUY' : 'SHORT';
  // The share count leads when it is known, because it is the part you cannot
  // work out in your head while the bar you are entering on is forming.
  const qty = size && size.shares > 0 ? `${size.shares} ` : '';

  /*
   * EVERY FIELD IS OPTIONAL, AND THIS LINE MUST NEVER THROW.
   *
   * It was written when there was one setup, and it described that setup: it
   * called .toFixed() on the target and the extension unconditionally and said
   * "(VWAP, fixed)" and "% from VWAP" in the text. Both are properties of the
   * T2 VWAP-extension strategy, not of a setup.
   *
   * `Test` is the first setup with a different shape — its take-profit is off,
   * because its targets are scale-out legs — so `target` is null, and this
   * threw. It threw INSIDE the runner, so the whole run died and published
   * "Did not run: Cannot read properties of null" every minute of a two-hour
   * window: no alert, no order, no picks, for a setup that was working.
   *
   * A description is the last thing that should be able to stop a trade. It now
   * states what exists and stays quiet about what does not.
   */
  // Number(null) is 0, NOT NaN — so a null target would print as "target 0.00",
  // which is worse than throwing: it is a number, on an alert, that nobody
  // typed and that reads as a real price. Absence is caught BEFORE the
  // conversion. (The same trap is called out in sideA/tradable.js.)
  const n = (v, d = 2) => {
    if (v === null || v === undefined || v === '') return null;
    const x = Number(v);
    return Number.isFinite(x) ? x.toFixed(d) : null;
  };
  const bits = [];
  const entry = n(p.entry);
  if (entry) bits.push(`now ~${entry}`);
  const stop = n(p.stop);
  if (stop) bits.push(`stop ${stop}`);
  const target = n(p.target);
  // No target is not a missing field — a scale-out carries its targets on its
  // legs, and a runner has none at all. Say which rather than printing nothing.
  bits.push(target ? `target ${target}`
    : (pick.exitPlan && (pick.exitPlan.legs || []).length
        ? `targets on ${pick.exitPlan.legs.length} leg(s)` : 'no fixed target'));
  const riskPct = n(p.riskPct);
  if (riskPct) bits.push(`risk ${riskPct}%`);
  const ext = n(pick.extension);
  if (ext) bits.push(`${ext}% from VWAP`);

  return `${side} ${qty}${pick.ticker} — ${bits.join(' · ')}`;
}

/**
 * What the broker did, in the same sentence as the trade.
 *
 * Appended to the detail line rather than added below it, because the detail
 * line is what a notification shows on a locked phone — and "did it actually go
 * in" is the second thing anyone wants to know there. Silence would read as
 * "yes": an alert that looks identical whether or not an order was placed is
 * the one failure this must not have.
 */
/*
 * One line per account, because two accounts is two outcomes.
 *
 * With a single broker this reads exactly as it always did. With two, the
 * interesting case is the one where they DISAGREE — accepted at one and short
 * of buying power at the other — and a single summary would have to pick which
 * of the two to tell you about.
 */
function orderLines(list) {
  if (!list) return '';
  const rows = Array.isArray(list) ? list : [list];
  if (rows.length === 1 && !rows[0].broker) return orderLine(rows[0]);
  return rows.map(o => ` · ${o.broker || o.destination || 'broker'}:`
    + orderLine(o).replace(/^ · /, ' ')).join('');
}

function orderLine(o) {
  if (!o) return '';
  if (o.skipped) return ` · ORDER: not sent (${o.skipped})`;
  if (!o.sent) return ` · ORDER FAILED — ${o.error || 'refused'}${borrowNote(o)}. Place it by hand.`;
  const filled = o.status === 'filled';
  return ` · ORDER ${filled ? 'FILLED' : String(o.status || 'accepted').toUpperCase()}`
    + ` ${o.quantity}${o.fillPrice ? ` @ ${o.fillPrice}` : ''}`
    // A scale-out is several orders and one position. Said plainly, because
    // three confirmations at the broker for one signal is otherwise alarming.
    + `${o.scaleOut > 1 ? ` in ${o.scaleOut} legs` : ''}`
    + `${o.bracket ? ' with stop+target' : ' — STOP NOT SENT, place it'}`
    + `${o.partial ? ' — PARTIAL: ' + (o.error || 'some legs did not go in') : ''}`
    + `${o.reduced ? ` (${o.reduced})` : ''}`
    + borrowNote(o);
}

/*
 * "The borrow check did not run" belongs on the alert, not only in a log.
 *
 * A short whose shortability could not be confirmed is still sent — refusing
 * every short because Alpaca did not answer is a worse failure than the
 * rejection the check exists to prevent. But then the order that was checked
 * and the order that was not look identical, and the difference is whether the
 * rejection arriving by email hours later was foreseeable.
 *
 * CAPR is the case: the lookup answered correctly a few hours after the order
 * it should have stopped, and nothing on the alert distinguished the two.
 */
function borrowNote(o) {
  if (!o) return '';
  if (o.borrowUnchecked) {
    return ` — BORROW NOT CHECKED (${o.borrowUnchecked}); if this comes back`
      + ' "cannot be sold short", that is why';
  }
  if (o.hardToBorrow) return ' — shortable but HARD to borrow, the fill may need a locate';
  return '';
}

/*
 * The part of the strategy's exit that a broker cannot be handed.
 *
 * A stop that follows an indicator — the 9 EMA, session VWAP — is wherever that
 * line sits on each bar. No broker-side trailing stop can follow it, so what
 * goes out is the frozen level and the trade needs managing by hand. Saying so
 * on the alert is the difference between knowing that and finding out.
 */
function unmanagedLine(plan) {
  if (!plan) return '';
  const notes = [];
  /*
   * WHO CLOSES THIS, said on the order rather than assumed.
   *
   * OR + VWAP 09:35 leaves on a VWAP cross and no broker can watch for one, so
   * the box does it — and that means the exit lives on this side and stops
   * happening the moment this side stops running. The alert has to carry that,
   * because a strategy managed here and one managed at the broker look
   * identical from a phone.
   */
  if (plan.exit_rule) {
    notes.push('it also leaves on a RULE — the box watches for that and closes '
      + 'the position itself; the broker only holds the stop and the targets');
  }
  if (plan.stop_anchored) {
    notes.push('the stop trails an indicator — sent as a fixed level, so it will '
      + 'NOT follow. Manage it yourself');
  }
  if (plan.breakeven_after_leg) {
    notes.push('moves to breakeven after the first leg — the broker will not do '
      + 'that, move it yourself');
  }
  const anchored = (plan.legs || []).filter(l => l && l.anchored).length;
  if (anchored) {
    notes.push(`${anchored} target(s) follow an indicator and cannot rest at the `
      + 'broker — that part rides the stop');
  }
  return notes.length ? ` · NOTE: ${notes.join('; ')}.` : '';
}

/**
 * Run one setup and publish the result.
 *
 * `dryRun` computes everything and publishes nothing — that is what the preview
 * endpoint uses, so a setup can be inspected on a past date without putting
 * yesterday's trades into today's alert feed.
 */
async function runSetup(setup, { date, dryRun = false, tickers = null, bar = null } = {}) {
  const day = date || toETDate(Date.now());
  // Which bar this run is answering for. The scheduler knows it; a direct call
  // (preview, a test) does not, and for a clock setup there is only ever one.
  // THE BAR EVALUATED, not the minute the entry lands in. They differ by one
  // bar for every fill model that enters at the next open — which is now the
  // default, because it is what the backtests were run on.
  const decisionBar = bar || setup.decidesOnBar || setup.decisionTime;
  const started = Date.now();

  // A setup names the tools it belongs to — the qp strategy carries them — so a
  // setup used by three tools is one object rather than three copies that drift.
  const owners = setup.tools || (setup.toolId ? [setup.toolId] : []);
  if (owners.length && !owners.includes(config.toolId) && !dryRun) {
    return { ok: false, reason: `belongs to ${owners.join(', ')}, this is ${config.toolId}` };
  }

  /*
   * The card-field layer, applied BEFORE qp rather than after.
   *
   * qp has never heard of bias, score or catalyst — they exist only on a card —
   * so this is the one thing it cannot do rather than a duplicate of anything.
   * It runs first because the setup ranks and takes the top two: filtering
   * afterwards means the filter eats picks and leaves gaps, while filtering
   * first means the ranking happens among the names that would actually be
   * taken. It is also the difference between evaluating twelve symbols at 10:00
   * and evaluating forty.
   */
  let list;
  let gate = { filtered: false, kept: [], dropped: [], reasons: {} };
  if (tickers && tickers.length) {
    list = tickers;
  } else {
    const rows = universeRows();
    gate = universeFilter.apply(rows, setup.universe);
    list = gate.kept.map(r => String(r.ticker).toUpperCase());
  }

  if (!list.length && gate.filtered && gate.dropped.length) {
    // Distinct from "no cards": the tool found stocks and the filter removed
    // every one. That is a fact about the filter, and a filter nobody can see
    // working is a filter that gets blamed for the wrong thing.
    const fire = {
      ruleId: setup.id, rule: setup.name, ticker: null, toolId: config.toolId,
      date: day, at: Date.now(), kind: 'setup', level: 'info',
      detail: `All ${gate.dropped.length} card(s) were removed by the filter `
        + `(${universeFilter.describe(setup.universe)}). `
        + Object.entries(gate.reasons).map(([k, n]) => `${n}× ${k}`).join('; '),
    };
    if (!dryRun) alertStore.publishFires([fire], day);
    return { ok: true, picks: [], universe: 0, gate, fires: [fire] };
  }

  if (!list.length) {
    const fire = {
      ruleId: setup.id, rule: setup.name, ticker: null, toolId: config.toolId,
      date: day, at: Date.now(), kind: 'setup', level: 'info',
      detail: 'No cards on the list at the decision — nothing to rank.',
    };
    if (!dryRun) alertStore.publishFires([fire], day);
    return { ok: true, picks: [], universe: 0, fires: [fire] };
  }

  /*
   * The decision itself belongs to qp, and nothing here recomputes any part of
   * it. The strategy is a seed built from qp primitives; the ranking is
   * chart/decide.py using the same metric a backtest uses. This function hands
   * over the card list and formats what comes back.
   */
  const decided = await qp.decide({
    strategyId: setup.strategyId,
    symbols: list,
    date: day,
    tf: setup.tf || '1m',
    feed: setup.feed || 'yahoo',
    topN: (setup.rank && setup.rank.topN) || 0,
    metric: (setup.rank && setup.rank.metric) || null,
    direction: (setup.rank && setup.rank.direction) || null,
    // The cards this tool froze, so reg_score and rvol rank on the numbers the
    // register actually shows rather than on anything recomputed.
    ctx: Object.fromEntries(universeRows()
      .filter(r => list.includes(String(r.ticker).toUpperCase()))
      .map(r => [String(r.ticker).toUpperCase(),
        { score: r._score, rvol_day: (r.stock || {}).rvol }])),
    targetR: setup.targetR || 2.0,
    // 'live' — the backtest's decision taken in real time: levels from the
    // decision bar's close, and no need for a bar that has not printed. The
    // old default of 'close' decided a bar later than every backtest of these
    // setups, on a different bar's close, VWAP and ATR.
    fill: setup.fill || 'live',
    // The frame qp evaluates on. See qpClient.decide — hardcoding this to RTH
    // was the second way live and backtest were reading different numbers.
    view: setup.view || 'all',
  });

  // qp's shape, translated once into the shape the alerts already speak. Every
  // number comes from qp — none is recalculated here.
  const out = {
    picks: (decided.picks || []).map(p => ({
      ticker: p.symbol,
      signal: String(p.side || '').toUpperCase(),
      extension: p.metric,
      decisionAt: p.entry_at,
      exitPlan: p.exit_plan || null,
      decisionVwap: p.stop,        // the stop IS the session VWAP, frozen
      decisionClose: p.entry,
      rangePosition: null,         // qp asserts it in the rules; it is not returned
      plan: {
        entry: p.entry, stop: p.stop, risk: p.risk,
        riskPct: p.risk_pct, target: p.target, targetR: p.target_r,
      },
    })),
    counts: {
      evaluated: (decided.counts && decided.counts.evaluated) || list.length,
      signalled: (decided.counts && decided.counts.signalled) || 0,
      invalidated: 0,              // qp rejects inside the strategy, not as a stage
      skipped: (decided.counts && decided.counts.errored) || 0,
    },
  };

  // What the fetch used to report about its own quality now comes from qp, or
  // is simply not knowable from here. Kept in the same shape so the alert
  // formatting below did not have to change.
  const data = {
    sources: Object.fromEntries((decided.picks || []).map(p => [p.symbol, decided.feed])),
    missing: (decided.errors || []).map(e => e.symbol),
    degraded: decided.feed === 'alpaca' ? (decided.picks || []).map(p => p.symbol) : [],
    used: [decided.feed], feed: decided.feed, mixed: false,
    coverage: list.length ? 1 - ((decided.errors || []).length / list.length) : 1,
    waitedMs: 0, attempts: 1,
  };

  /*
   * TWO LAYERS OF RISK, and the setup's wins where it says anything.
   *
   * The account answers "what may a trade lose". The setup answers "what may
   * THIS strategy lose", which is a smaller number while a strategy is young —
   * and having to edit the account figure before and after each morning is how
   * it ends up wrong on the morning nobody remembers.
   *
   * Read once for the whole run, so both picks are sized against the same
   * numbers even if they are edited while this is executing.
   */
  const account = risk.settings();
  /*
   * RESOLVED, not merged. The old per-field spread let an account risking 0.5%
   * meet a setup still carrying a flat riskPerTrade from an earlier experiment:
   * both survived the merge and the sizing quietly preferred the flat dollar,
   * which is a rule nobody chose. risk.resolve() takes the risk rule WHOLE from
   * whichever level names one, and reports what it had to override.
   */
  const riskCfg = risk.resolve(account, setup);
  if (riskCfg.conflicts.length) {
    console.warn(`[Setups] ${setup.id}: ${riskCfg.conflicts.join(' · ')}`);
  }
  // A rule still on the ACCOUNT is sizing a strategy by a default rather than
  // by its own tested setting. Said once per run, not per pick.
  if (riskCfg.legacy) console.warn(`[Setups] ${setup.id}: ${riskCfg.legacy}`);

  /*
   * The orders, placed before the alerts are published.
   *
   * That order matters. The entry is taken at market on sight, so the seconds
   * between the decision and the order are the difference between the price
   * that was ranked and the price that is paid — and publishing first would
   * spend them formatting text. The alert then CARRIES what the broker did, so
   * one message answers "what fired" and "did it go in".
   *
   * Sequential rather than parallel: the second order is sized against what the
   * first one actually committed, and firing both at once would size both
   * against the full buying power and overspend it by design.
   */
  const orders = {};
  /*
   * TWO switches have to be on, and they mean different things.
   *
   *   the broker is ARMED   this box may place orders at all — one decision for
   *                         the account, made on the alerts page
   *   the setup AUTO-TRADES  this particular strategy may place them
   *
   * One switch would have meant that arming to trade a strategy you have
   * backtested for months also arms the scalp you assigned to a tool five
   * minutes ago to see what it does. The strategy earns it separately, and the
   * default for a strategy that has never said so is no.
   */
  /*
   * …and the strategy must be ORDERABLE, which is not the same as valid.
   *
   * A rule-exit strategy alerts correctly and cannot be sent to a broker: no
   * broker watches for a VWAP cross, and giving it a price target instead would
   * place a different strategy from the one that was backtested — under the
   * same name, with the same evidence behind it. It alerts; it does not trade.
   */
  /*
   * ONE ALERT PER NAME, PER SESSION — the latch a watch setup needs.
   *
   * A clock setup runs once, so it cannot repeat itself. A WATCH setup runs on
   * every bar of its window: `PML breakout` is thirty-one runs between 09:40
   * and 10:10, and a condition that stays true for six of those bars would
   * alert six times, place six orders, and read as six separate signals.
   *
   * qp's own `entry_mode: 'edge'` solves this inside a backtest — one entry per
   * contiguous true-run — but it cannot help here, because each live run is an
   * independent question asked of the last bar. qp has no memory of what it
   * told us a minute ago. This side does: the alert feed already holds every
   * fire for the session, keyed by setup and ticker.
   *
   * So a name this setup has already alerted today is dropped before anything
   * is sized or sent.
   *
   * IT USED TO BE `setup.watch && !dryRun`, on the reasoning written above that
   * "a clock setup runs once, so it cannot repeat itself". That is an
   * assumption about a scheduler, not a property of the world, and on
   * 2026-08-19 it was wrong:
   *
   *     ⚠ THE SAME NAME ALERTED MORE THAN ONCE — the once-a-day latch did not
   *       hold:  2×  OR + VWAP 09:35@09:35  WULF
   *
   * OR + VWAP 09:35 is a CLOCK setup, so the latch was skipped entirely. The
   * ORDER guard held — `sentAlready` reads the ledger and refused the second
   * one, so it cost no money — and the alert went out twice anyway: one phone
   * buzz for a trade that did not happen, on the feed whose whole value is that
   * every line on it is real.
   *
   * A clock setup CAN run twice: a process restarting inside its window, a
   * scheduler firing on both edges of a minute, a tool deployed at 09:35. So
   * the latch now applies to every setup, which also makes it agree with the
   * order guard — one entry per setup per name per day is already the rule
   * money follows, and the alert should not describe a different desk.
   */
  /*
   * A PICK IS ONLY A PICK ON THE BAR IT FIRED ON.
   *
   * qp is asked to decide `date`, and it answers with every signal that opened
   * that session — which is the right answer to the question asked, and the
   * wrong set to trade. A WATCH setup is asked once a minute across its whole
   * window, and on every one of those passes the strategy still reports the
   * entry it found earlier. So a setup watching 09:40–10:10 that first sees a
   * stock at 10:05 is handed a signal from 09:42 and, until now, sent a market
   * order for it.
   *
   * Two separate things are wrong with that, and only one of them is obvious:
   *
   *   THE PRICE IS STALE. The stop, the target, the R and the share count were
   *   all computed from the 09:42 close. Twenty-three minutes later that is
   *   not a slightly worse entry, it is a different trade wearing the numbers
   *   of the tested one.
   *
   *   THE STOCK WAS NOT ON THE WATCHLIST AT 09:42. The scanner surfaced it at
   *   10:00. No alert could have fired and no order could have been placed on
   *   a name the desk had not found yet — so the backtest's watchlist gate
   *   drops exactly this trade, and the live side was taking it. The two were
   *   measuring different strategies, and the live one was the looser.
   *
   * A clock setup is unaffected: its window is one minute wide, so the bar it
   * decides on is the only bar its signals can carry. The guard costs it
   * nothing and protects it from the same fault if its window is ever widened.
   *
   * Dropped LOUDLY. A stale pick is not noise — it means the setup found
   * something on a bar it could not act on, which is worth seeing.
   */
  if (decisionBar) {
    const stale = out.picks.filter(p => staleBy(p.decisionAt, decisionBar) > STALE_TOLERANCE_MIN);
    if (stale.length) {
      const drop = new Set(stale.map(p => p.ticker));
      out.picks = out.picks.filter(p => !drop.has(p.ticker));
      out.staleBars = stale.map(p => `${p.ticker}@${p.decisionAt}`);
      console.log(`[Setups] ${setup.id}: ${stale.length} pick(s) fired on an `
        + `earlier bar than ${decisionBar} and were dropped — `
        + `${out.staleBars.join(', ')}`);
    }
  }

  const alreadyToday = new Set();
  if (!dryRun) {
    for (const f of alertStore.recentFires(day, 500)) {
      if (f.ruleId === setup.id && f.ticker) alreadyToday.add(String(f.ticker).toUpperCase());
    }
    const before = out.picks.length;
    out.picks = out.picks.filter(p => !alreadyToday.has(String(p.ticker).toUpperCase()));
    if (before !== out.picks.length) {
      console.log(`[Setups] ${setup.id}: ${before - out.picks.length} name(s) `
        + 'already alerted today — the window latch held');
    }
    // Nothing NEW on this bar is the normal case for a watch setup: it is
    // asked thirty-one times and answers once. Publishing "nothing qualified"
    // every minute would bury the one bar that mattered.
    if (!out.picks.length && before) return { ok: true, picks: 0, fires: [], latched: before };
  }

  const orderable = !setup.readiness || setup.readiness.orderOk !== false;
  if (!dryRun && !orderable) {
    console.log(`[Setups] ${setup.id}: alert only — `
      + `${(setup.readiness.orderBlocking || []).join('; ')}`);
  }
  /*
   * WHERE the orders go, resolved once for the whole run.
   *
   * A setup can name more than one account, and then the same signal is the
   * same trade in each of them — sized independently, because each has its own
   * balance and its own daily count. It can also name one the account no longer
   * has, and broker.route refuses rather than guessing; that refusal goes onto
   * the alert, because a setup that silently stopped trading looks exactly like
   * a setup having a quiet week.
   */
  let routing = { cfgs: [], error: null };
  if (orderable) {
    routing = broker.autoRoute(setup.id);
    // Only worth reporting when SOMETHING is configured. A desk with no broker
    // at all is an alert-only desk on purpose, and saying so on every fire
    // would be noise on the one line a locked phone shows.
    if (routing.error && !dryRun && broker.destinations().length) {
      console.log(`[Setups] ${setup.id}: no order placed — ${routing.error}`);
    }
  }
  // Does ANY account claim this setup? The difference between "you meant this
  // to trade and it did not" and "this desk alerts, as arranged".
  const listedSomewhere = broker.accountsFor(setup.id).length > 0;
  /*
   * READY, BUT NOT SENT.
   *
   * An account on `manual` runs this setup and has agreed to receive orders —
   * it just wants a thumb on the button first. That is not a reason to make it
   * do the arithmetic again ten minutes later: the share count is computed here,
   * at the same instant and from the same standard as the automatic ones, and
   * travels on the alert. Pressing send is then a send, not a re-derivation.
   *
   * Only when the box is armed. An unarmed desk offering a one-tap order would
   * be the master switch failing to be a master switch.
   */
  const readyFor = (broker.settings().armed && orderable)
    ? broker.accountsFor(setup.id, 'manual') : [];
  if (!dryRun && orderable && routing.cfgs.length) {
    for (const pick of out.picks) {
      /*
       * THE TRADE IS ALREADY DECIDED before this loop begins.
       *
       * Entry, stop, target and the share count were worked out once, against
       * the standard account, at the top of this function. The stop is where
       * the setup says the trade is wrong and the target is where it says the
       * trade is done — neither changes because the money came out of a
       * different account.
       */
      const standard = risk.sizeFor(
        { entry: pick.plan.entry, riskPerShare: pick.plan.risk }, riskCfg);
      // One account at a time, and one pick at a time: each order is sized
      // against what the previous one actually committed in THAT account, and
      // firing them together would size every one against the full balance.
      for (const cfg of routing.cfgs) {
        /*
         * ALL AN ACCOUNT CHANGES IS THE SHARE COUNT — its own fraction of the
         * standard, floored — and the shape of the JSON, which the dialect
         * decides inside placeOrder. Nothing else about the trade moves.
         */
        const size = risk.scaleTo(standard, cfg);
        if (!size || !(size.shares > 0)) {
          (orders[pick.ticker] = orders[pick.ticker] || []).push({
            sent: false, destination: cfg.destinationId, broker: cfg.destinationName,
            skipped: (size && size.reason) || 'no size for this account',
          });
          continue;
        }
        let result;
        try {
          result = await broker.placeOrder({
            symbol: pick.ticker,
            signal: pick.signal,
            quantity: size.shares,
            price: pick.plan.entry,
            // The stop is the frozen VWAP and the target is 2R — both decided at
            // this same instant, so they go with the entry as a bracket rather
            // than being left for whoever reaches their phone first.
            stop: pick.plan.stop,
            target: pick.plan.target,
            date: day,
            source: `${setup.id} (${config.toolId})`,
            // Both caps are enforced in the broker, against the ledger, so a
            // restart between the two picks cannot hand the allowance back.
            setupId: setup.id,
            maxPerDay: setup.maxTradesPerDay || null,
            // The bar the decision was made on, so anything managing this
            // position afterwards lines up with the simulation's entry bar
            // rather than with the second the POST happened to leave.
            decisionBar,
            // The strategy's OWN exit plan — its scale-out legs and whether its
            // stop trails — straight from qp. Without it every trade was given a
            // single 2R target whatever the strategy said, which for a
            // scale-out strategy is not a smaller version of the tested trade,
            // it is a different one.
            plan: pick.exitPlan || null,
            cfg,
          });
        } catch (err) {
          // A broker that cannot be reached must not stop the alert, and with
          // two accounts it must not stop the OTHER one either. The alert is
          // the thing you can still act on by hand; losing it because the
          // automatic path failed would turn a degraded morning into a blind one.
          result = { sent: false, error: err.message };
        }
        // The share count this account was sized for, beside what the broker
        // did with it — "40 asked, 12 sent" is only readable with both.
        result = { ...result, destination: cfg.destinationId, broker: cfg.destinationName,
                   sizedFor: size.shares };
        (orders[pick.ticker] = orders[pick.ticker] || []).push(result);
      }
    }
  }

  const fires = out.picks.map(pick => {
    const size = risk.sizeFor(
      { entry: pick.plan.entry, riskPerShare: pick.plan.risk }, riskCfg);
    return {
    ruleId: setup.id,
    rule: setup.name,
    ticker: pick.ticker,
    toolId: config.toolId,
    date: day,
    at: Date.now(),
    kind: 'setup',
    level: 'trade',
    detail: describePick(pick, size) + orderLines(orders[pick.ticker])
      + (!orderable
        ? ' · ALERT ONLY — ' + (setup.readiness.orderBlocking || []).join('; ')
        : '')
      /*
       * A setup an account was supposed to trade, that placed nothing, said
       * nothing at all — and a silent non-order is indistinguishable from a
       * quiet week. Only shown when an account actually lists this setup:
       * "no account runs this setup" on every fire of a deliberately
       * alert-only desk is noise, and noise on this line is what teaches you
       * to stop reading it.
       */
      + (routing.error && routing.cfgs.length === 0 && listedSomewhere
        ? ` · NO ORDER — ${routing.error}` : '')
      + unmanagedLine(pick.exitPlan),
    price: pick.plan.entry,
    // Everything the card cannot show but the trade needs. Kept on the fire so
    // the record of what was signalled survives the day it was signalled.
    setup: {
      signal: pick.signal,
      extension: pick.extension,
      entry: pick.plan.entry,
      stop: pick.plan.stop,
      target: pick.plan.target,
      risk: pick.plan.risk,
      riskPct: pick.plan.riskPct,
      decisionVwap: pick.decisionVwap,
      decisionClose: pick.decisionClose,
      rangePosition: pick.rangePosition,
      // Kept on the fire so the record shows the exit the strategy asked for,
      // not just the one leg that fitted in the alert text.
      exitPlan: pick.exitPlan,
      // What the broker did with it, on the alert itself. One message answers
      // both "what fired" and "did it go in" — two messages, or a state you
      // have to go and look up, is how a rejected order becomes a position
      // somebody believes they are holding.
      /*
       * `order` is the first account's result and `orders` is all of them.
       *
       * Kept both because `order` is on every record ever written and the
       * history page reads it — an object that became an array would rewrite
       * the past as much as the present. With one destination they say the
       * same thing, which is the case that has existed until now.
       */
      order: (orders[pick.ticker] || [])[0] || null,
      orders: orders[pick.ticker] || null,
      /*
       * The accounts that will send this only when told to, with the share
       * count already worked out for each. The page turns these into one
       * button apiece.
       */
      ready: readyFor.map(cfg => {
        const sized = risk.scaleTo(risk.sizeFor(
          { entry: pick.plan.entry, riskPerShare: pick.plan.risk }, riskCfg), cfg);
        return {
          destination: cfg.destinationId,
          broker: cfg.destinationName,
          ratio: sized ? sized.ratio : null,
          shares: sized ? sized.shares : 0,
          standardShares: sized ? sized.standardShares : null,
          // Why it would send nothing, said now rather than on the tap.
          reason: sized && sized.shares > 0 ? null
            : ((sized && sized.reason) || 'no size'),
        };
      }),
      // Which minute the decision was actually taken on. Normally 09:59; when
      // the feed had not published it inside the deadline it is the last bar
      // that existed, and that changes both the close and the VWAP slightly.
      decisionAt: pick.decisionAt,
      source: data.sources[pick.ticker] || 'unknown',
      caution: setup.caution,
      // Only where it applies. IEX volume is a fraction of the tape, so this
      // stop is not the level a chart would draw.
      feedWarning: data.degraded.includes(pick.ticker)
        ? 'VWAP from the IEX feed only — the chart\'s VWAP will differ. Check before using this stop.'
        : null,
      // null when account size and risk per trade have not been set. An
      // invented size is worse than none: it looks like a decision.
      size,
      // Which risk figure produced this size. An alert that says "18 shares"
      // and an account set to $25 do not add up when the setup is capped at
      // $10, and the arithmetic is the first thing anyone checks.
      //
      // THE BUDGET, not the flat figure. A setup sized as a PERCENTAGE has no
      // riskPerTrade at all, and reading that field reported "no risk figure"
      // beside a real share count — the exact arithmetic this line exists to
      // let someone check.
      riskUsed: riskCfg.riskPerTrade
        || (riskCfg.riskPct && riskCfg.accountSize
              ? Math.round(riskCfg.accountSize * (riskCfg.riskPct / 100) * 100) / 100
              : null),
      // ...and the rule behind it, because "$250" means something different
      // when it is half a percent of the account than when it is a flat figure.
      riskRule: riskCfg.riskRule,
      riskFrom: riskCfg.sources.risk,
    },
    };
  });

  /*
   * A HALF-PLACED SCALE-OUT GETS ITS OWN ALERT, at error level.
   *
   * It was already on the trade line — ` — PARTIAL: only 1 of 3 legs went in` —
   * appended to a message whose level is `trade`. Which means it arrives green,
   * beside every healthy fill of the morning, and reads as a success with a
   * footnote. It is not one: the position that exists is a different shape from
   * the one that was tested, sized for a scale-out it did not get, and which
   * leg is missing decides whether what is left is the runner or the target.
   *
   * A SEPARATE fire, not a changed one. The signal really did fire and the
   * trade line is still what you act on; this is the second half of the same
   * fact, at the level that reaches a phone and lands in the ERRORS section.
   *
   * Deliberately NOT unwound automatically. Every leg goes out as its own
   * bracket, so what did get in is protected — it is the wrong SIZE, not an
   * unprotected position — and closing it costs a certain round trip to undo an
   * uncertain problem. That is a decision about money and it stays with a
   * person, which is why this says exactly what to look at.
   */
  for (const pick of out.picks) {
    for (const o of orders[pick.ticker] || []) {
      if (!o || !o.partial) continue;
      const went = (o.legs || []).filter(l => l.sent);
      const missed = (o.legs || []).filter(l => !l.sent);
      fires.push({
        ruleId: setup.id, rule: setup.name, ticker: pick.ticker,
        toolId: config.toolId, date: day, at: Date.now(),
        kind: 'broker', level: 'error',
        detail: `${pick.ticker} at ${o.broker || o.destination || 'the broker'} is `
          + `HALF PLACED: ${went.length} of ${o.legs.length} leg(s) went in `
          + `(${went.map(l => l.quantity).join(' + ') || '0'} share(s)), `
          + `${missed.map(l => l.quantity).join(' + ')} did not — `
          + `${(missed[0] || {}).message || o.error || 'refused'}. `
          + 'The shares that went in carry their own stop and target, so this is '
          + 'the wrong SIZE rather than an open risk. Decide whether to fill the '
          + 'rest by hand or close what is there — it will not be unwound for you.',
      });
    }
  }

  /*
   * What the filter did, when there was one. A gate that silently halves the
   * universe is a gate you cannot audit: two picks out of forty and two out of
   * twelve are different statements about the same morning, and only one of
   * them is what happened.
   */
  if (gate.filtered) {
    fires.push({
      ruleId: setup.id, rule: setup.name, ticker: null, toolId: config.toolId,
      date: day, at: Date.now(), kind: 'setup', level: 'info',
      detail: `Filter: ${gate.kept.length + gate.dropped.length} card(s) → `
        + `${gate.kept.length} passed (${universeFilter.describe(setup.universe)})`
        + (Object.keys(gate.reasons).length
          ? ` · removed by ${Object.entries(gate.reasons)
            .map(([k, n]) => `${n}× ${k}`).join('; ')}`
          : ''),
    });
  }

  /*
   * Always say something, including "nothing" — from a phone, a setup that
   * published nothing and a setup that never ran look exactly the same.
   *
   * EXCEPT on the middle bars of a watch window. `PML breakout` is asked
   * thirty-one times between 09:40 and 10:10 and answers once; thirty-one
   * "nothing qualified" lines would bury the one that mattered and teach you
   * to stop reading the feed. It says so ONCE, on the last bar of the window,
   * which is the moment the answer for the day is final.
   */
  const windowShutting = !setup.watch
    || !decisionBar
    || decisionBar >= (setup.decidesUntilBar || setup.windowEnd || setup.decisionTime);
  if (!fires.length && !windowShutting) {
    console.log(`[Setups] ${setup.id}: nothing on the ${decisionBar} bar `
      + `(window ${setup.decisionTime}–${setup.windowEnd}, still open)`);
    return { ok: true, picks: 0, fires: [], quiet: true };
  }
  if (!fires.length) {
    fires.push({
      ruleId: setup.id, rule: setup.name, ticker: null, toolId: config.toolId,
      date: day, at: Date.now(), kind: 'setup', level: 'info',
      detail: `Nothing qualified. ${out.counts.evaluated} evaluated, `
        + `${out.counts.signalled} had a direction, ${out.counts.invalidated} invalidated`
        + `${out.counts.skipped ? `, ${out.counts.skipped} short of bars` : ''}.`,
    });
  }

  /*
   * The ranking is only as comparable as the tape underneath it. Extension
   * decides which two names are taken, extension comes from VWAP, and VWAP
   * comes from volume — so candidates measured on different feeds were not
   * ranked against each other on the same ruler. That is a caveat about the
   * SELECTION, not about any one pick, so it gets its own line.
   */
  if (data.mixed) {
    fires.push({
      ruleId: setup.id, rule: setup.name, ticker: null, toolId: config.toolId,
      date: day, at: Date.now(), kind: 'setup', level: 'warn',
      detail: `Ranked across mixed feeds (${data.used.join(' + ')}) — no single feed `
        + 'covered the list. Extensions from different tapes are not directly '
        + 'comparable, so the choice of the top 2 is less reliable than usual.',
    });
  }

  /*
   * WHAT THE RANKING WAS, and who it removed.
   *
   * "2 picks from 12" is not interpretable without it: top 2 of what, by which
   * number. A run that ranked and one that took everything look identical
   * otherwise, and that difference is the whole of backtest #231.
   */
  const rank = decided.rank || {};
  /*
   * A cut that was asked for and could not be honoured. "Take the top 2" with
   * no metric named is two of an unordered list — indistinguishable from a
   * working ranking, which is why it is dropped rather than obeyed, and why
   * dropping it has to be said.
   */
  if (rank.ignored_top_n) {
    fires.push({
      ruleId: setup.id, rule: setup.name, ticker: null, toolId: config.toolId,
      date: day, at: Date.now(), kind: 'setup', level: 'warn',
      detail: `"Take top ${rank.ignored_top_n}" was IGNORED — no ranking metric is `
        + 'set, so there is no top. Every signal is here. Pick a metric in '
        + 'edit filter, or clear the count.',
    });
  }
  if (rank.metric) {
    fires.push({
      ruleId: setup.id, rule: setup.name, ticker: null, toolId: config.toolId,
      date: day, at: Date.now(), kind: 'setup', level: 'info',
      detail: `Ranked by ${rank.metric} (${rank.direction})`
        + `${rank.top_n ? `, kept top ${rank.top_n}` : ', all kept'}`
        + ` of ${out.counts.signalled} signal(s).`,
    });
  }
  /*
   * Unscorable is not weakest. A signal the metric could not read is unusable,
   * and it was excluded from the ranking rather than sorted to the bottom —
   * which is a different thing from being the last pick on a thin day.
   */
  if ((decided.dropped_unscorable || []).length) {
    fires.push({
      ruleId: setup.id, rule: setup.name, ticker: null, toolId: config.toolId,
      date: day, at: Date.now(), kind: 'setup', level: 'warn',
      detail: `${decided.dropped_unscorable.length} signal(s) could not be scored `
        + `by ${rank.metric} and were left out of the ranking entirely: `
        + `${decided.dropped_unscorable.map(d => d.symbol).join(', ')}.`,
    });
  }

  // A gap in the universe changes the ranking, because the ranking is over the
  // universe. Worth its own line rather than a footnote on a pick.
  if (data.missing.length) {
    fires.push({
      ruleId: setup.id, rule: setup.name, ticker: null, toolId: config.toolId,
      date: day, at: Date.now(), kind: 'setup', level: 'warn',
      detail: `No ${setup.decidesOnBar || lastWantedBar(setup.decisionTime)} bar for `
        + `${data.missing.slice(0, 8).join(', ')}`
        + `${data.missing.length > 8 ? ` +${data.missing.length - 8} more` : ''}`
        + ' — these were ranked against nothing and could not be picked.',
    });
  }

  if (!dryRun) alertStore.publishFires(fires, day);

  const result = {
    ok: true,
    setupId: setup.id,
    date: day,
    universe: list.length,
    gate: { filtered: gate.filtered, kept: list.length, dropped: gate.dropped.length },
    picks: out.picks,
    counts: out.counts,
    data: {
      feed: data.feed,
      mixed: data.mixed,
      used: data.used,
      coverage: data.coverage,
      missing: data.missing,
      degraded: data.degraded,
      waitedMs: data.waitedMs,
      attempts: data.attempts,
    },
    tookMs: Date.now() - started,
    // Picks that fired on an earlier bar and were refused. Carried out of the
    // run because "the setup found something on a bar it could not act on" is
    // a fact about the day, not a log line — the session report reads it.
    staleBars: out.staleBars,
    fires,
  };
  console.log(`[Setups] ${setup.id}: ${out.picks.length} pick(s) from ${list.length} cards `
    + `on ${data.feed || data.used.join('+') || 'no feed'} `
    + `(${Math.round(data.coverage * 100)}% had bars, waited ${Math.round(data.waitedMs / 1000)}s)`);
  return result;
}

/** Every setup this tool owns, run in turn. Used by the scheduler. */
async function runDue(decisionTime, opts = {}) {
  // Read live, so a strategy built in qp this morning runs this morning and one
  // deleted there stops — the whole reason the catalog is not a snapshot.
  const mine = (await catalog.forTool(config.toolId))
    // A clock setup matches its one minute; a watch setup matches any bar in
    // its window. Same predicate — a clock setup is a one-minute window.
    // Matched on the bars the setup DECIDES on, which for a next-open fill are
    // one bar before its entry window. Matching on the entry window would ask
    // the setup about a bar it does not trade from, and a clock setup would
    // then never fire at all.
    .filter(s => catalog.withinWindow(decisionTime,
                                      s.decidesOnBar || s.decisionTime,
                                      s.decidesUntilBar || s.windowEnd))
    // Switched off from the alerts page. Silently skipped rather than
    // publishing "nothing qualified": you turned it off, and a message every
    // morning saying so is the thing that makes people stop reading the feed.
    .filter(s => prefs.isEnabled(s.id));
  const out = [];
  for (const setup of mine) {
    try {
      out.push(await runSetup(setup, { ...opts, bar: decisionTime }));
    } catch (err) {
      console.error(`[Setups] ${setup.id} failed:`, err.message);
      // A crash must not be silence either.
      const day = opts.date || toETDate(Date.now());
      alertStore.publishFires([{
        ruleId: setup.id, rule: setup.name, ticker: null, toolId: config.toolId,
        date: day, at: Date.now(), kind: 'setup', level: 'error',
        detail: `Did not run: ${err.message}`,
      }], day);
      out.push({ ok: false, setupId: setup.id, error: err.message });
    }
  }
  return out;
}

module.exports = {
  runSetup, runDue, universe, describePick, lastWantedBar, orderLine, unmanagedLine, borrowNote,
};
