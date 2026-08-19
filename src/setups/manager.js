/*
 * Watching a position after the orders have gone in.
 *
 * WHAT WAS MISSING. Between placement and 15:50, nothing observed a position at
 * all. The broker holds a resting stop and a resting limit; everything else a
 * strategy does to a position, somebody has to watch for — and two of the three
 * live strategies need it:
 *
 *   OR + VWAP 09:35   leaves on a RULE, close crossing back through VWAP, and
 *                     in the backtest that rule closes the ENTIRE remaining
 *                     position — the 50% runner included. Nothing evaluated it,
 *                     so the runner rode its stop to the bell. The tested win
 *                     rate was measured with an exit the live trade never used.
 *
 *   Test              has a stop that MOVES and RATCHETS — up with the lower
 *                     VWAP band, never down. A broker is handed one price.
 *
 * Neither can be sent. Both can be watched. This is the watching.
 *
 * WHY IT LIVES IN THE ALERTS PROCESS, like the flattener and for the same
 * reason: the account is one account. Nine tool processes each managing what
 * they opened would race to close the same symbol, and `close` takes no
 * quantity — two of them arriving is one flat position and one accidental
 * reversal.
 *
 * WHAT IT DOES NOT DECIDE. Nothing. Every judgement comes from qp, out of the
 * same functions the simulation uses; this file finds the open positions, asks,
 * and sends what the answer implies. A second reading of "has the VWAP crossed"
 * on this side is exactly the divergence the platform spent a rewrite removing.
 *
 * THE LIMIT, and it is not small. A synthetic stop fills at the next
 * observation, not at the level: the backtest fills a within-bar touch AT the
 * stop, and this cannot see inside a bar. On a gap it is worse still. A
 * strategy whose stop moves is not executable through a channel that cannot
 * move stops — this makes it FOLLOWABLE, which is a different and lesser thing,
 * and the gap belongs in the results rather than in a footnote.
 */

const broker = require('../broker/signalstack');
const catalog = require('./catalog');
const qp = require('./qpClient');
const store = require('../alerts/store');
const { toETDate } = require('../utils/time');

/** HH:MM in New York — the market's clock, not the machine's. */
function etNow(at = Date.now()) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'America/New_York', hour12: false,
    hour: '2-digit', minute: '2-digit',
  }).format(new Date(at));
}

function etWeekday(at = Date.now()) {
  const d = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', weekday: 'short',
  }).format(new Date(at));
  return !['Sat', 'Sun'].includes(d);
}

/**
 * The positions this desk opened today and has not closed.
 *
 * From the LEDGER, because it is the only record written by the same call that
 * sends. Grouped by setup AND name: two accounts holding one signal is one
 * position to a strategy and two orders to a broker, and the question this
 * module asks — "should it be closed" — is a question about the position.
 *
 * `close` takes no quantity and flattens the whole symbol, so a symbol that two
 * different setups both hold cannot be closed for one of them. That is a real
 * limit of the channel and is reported rather than papered over.
 */
function openPositions(date) {
  const rows = broker.orders(date);
  const closed = new Set();
  for (const o of rows) {
    if (o.kind === 'flatten' && o.sent && o.symbol) {
      closed.add(String(o.symbol).toUpperCase());
    }
  }

  const by = new Map();
  for (const o of rows) {
    if (!o.sent || !o.symbol || !o.setupId) continue;
    if (o.kind === 'flatten' || o.kind === 'callback') continue;
    const sym = String(o.symbol).toUpperCase();
    if (closed.has(sym)) continue;
    const key = `${o.setupId}|${sym}`;
    const was = by.get(key);
    if (was) {
      if (!was.destinations.includes(o.destination)) was.destinations.push(o.destination);
      // The EARLIEST order is the entry. A later one for the same name is
      // another account's half of the same signal, not a second position.
      if ((o.at || 0) < (was.at || 0)) { was.at = o.at; was.price = o.price; was.stop = o.stop; }
      continue;
    }
    by.set(key, {
      setupId: o.setupId,
      symbol: sym,
      signal: o.signal,
      side: String(o.signal || '').toUpperCase() === 'SHORT' ? 'short' : 'long',
      price: o.price,
      stop: o.stop,
      at: o.at,
      decisionBar: o.decisionBar || null,
      destinations: [o.destination],
    });
  }
  return [...by.values()];
}

/**
 * The ET timestamp of the bar the decision was made on.
 *
 * From `decisionBar` when the order carries it, because that is the bar the
 * simulation entered on. Falling back to the SEND time is a whole bar late on a
 * 1-minute strategy — enough to seed a ratchet from the wrong level and to skip
 * the exact bar a cross fired on — so the fallback is used and SAID, never used
 * quietly.
 */
function entryIsoOf(pos, date) {
  if (pos.decisionBar && /^\d{2}:\d{2}$/.test(pos.decisionBar)) {
    return { iso: `${date} ${pos.decisionBar}`, exact: true };
  }
  const t = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'America/New_York', hour12: false,
    hour: '2-digit', minute: '2-digit',
  }).format(new Date(pos.at || Date.now()));
  return { iso: `${date} ${t}`, exact: false };
}

/** Which qp strategy this position is — the setup's half that matches its side. */
async function strategyFor(pos) {
  const setups = await catalog.list();
  const setup = setups.find(s => s.id === pos.setupId);
  if (!setup) return null;
  const names = setup.strategies || [];
  if (names.length === 1) return { name: names[0], setup };
  // A setup is usually a long and a short. The ledger recorded which one fired.
  const want = pos.side === 'short' ? /short/i : /long/i;
  const hit = names.find(n => want.test(n));
  return { name: hit || names[0], setup };
}

/**
 * One pass. Returns what it looked at and what it did, for the caller to log.
 *
 * Every position is independent: one that cannot be judged must not stop the
 * others, because the others may be the ones that need closing.
 */
async function check(at = Date.now(), { dryRun = false } = {}) {
  const cfgAll = broker.settings();
  if (!cfgAll.enabled || !cfgAll.armed) return { ran: false, reason: 'not armed' };
  if (!etWeekday(at)) return { ran: false, reason: 'weekend' };

  const day = toETDate(at);
  const positions = openPositions(day);
  if (!positions.length) return { ran: true, positions: 0, acted: [] };

  const acted = [];
  const looked = [];

  for (const pos of positions) {
    try {
      const found = await strategyFor(pos);
      if (!found) { looked.push({ ...pos, skipped: 'no setup by that id' }); continue; }

      const { iso, exact } = entryIsoOf(pos, day);
      const answer = await qp.manage({
        name: found.name,
        symbol: pos.symbol,
        side: pos.side,
        entry: pos.price,
        entryIso: iso,
        stopAtEntry: pos.stop,
        tf: found.setup.tf || '1m',
        feed: found.setup.feed || 'yahoo',
      });

      looked.push({ symbol: pos.symbol, setupId: pos.setupId, ...answer, entryExact: exact });

      /*
       * NOTHING TO MANAGE is the common case and must be cheap and silent.
       * A frozen stop with no exit rule is already entirely in the broker's
       * hands — T2 10:00 is exactly that — and a message every minute saying
       * so is what teaches you to stop reading the feed.
       */
      if (!answer.managed) continue;

      const why = answer.exit_now
        ? `the exit rule fired${answer.exit_bars_ago ? ` ${answer.exit_bars_ago} bar(s) ago` : ''}`
        : (answer.breached && answer.stop_kind === 'anchored'
            ? `the trailing stop at ${answer.stop_now} was breached` : null);

      if (!why) continue;

      /*
       * A STOP ON THE WRONG SIDE OF THE ENTRY is not a reason to close.
       *
       * It means the anchor was already past the fill — a stale line, a gap —
       * and acting on it would flatten a position opened minutes ago on a level
       * that is obviously wrong. Reported loudly and left alone; a person can
       * decide in a way this loop should not.
       */
      if (answer.stop_wrong_side && !answer.exit_now) {
        store.publishFires([{
          ruleId: pos.setupId, rule: 'Manager', ticker: pos.symbol,
          toolId: 'ALERTS', date: day, at: Date.now(), kind: 'broker', level: 'error',
          detail: `${pos.symbol}: the trailing stop computed to ${answer.stop_now}, which is `
            + `on the WRONG SIDE of the ${pos.price} entry. NOT closing it — look at this one.`,
        }], day);
        continue;
      }

      if (dryRun) { acted.push({ ...pos, why, sent: false, dryRun: true }); continue; }

      /*
       * Closed in EVERY account that holds it. `close` takes no quantity and
       * flattens the symbol, so one call per destination is one flat position
       * each — and a destination that is already flat ignores it.
       */
      const results = [];
      for (const dest of pos.destinations) {
        const cfg = broker.destinationCfg(dest) || cfgAll;
        results.push(await broker.closePosition(pos.symbol, day, cfg));
      }
      const sent = results.filter(r => r.sent).length;
      acted.push({ ...pos, why, sent, of: results.length });

      store.publishFires([{
        ruleId: pos.setupId, rule: 'Manager', ticker: pos.symbol,
        toolId: 'ALERTS', date: day, at: Date.now(), kind: 'broker',
        level: sent ? 'trade' : 'error',
        detail: sent
          ? `CLOSED ${pos.symbol} — ${why}. ${sent}/${results.length} account(s).`
            + (answer.exit_bars_ago > 0
                ? ' The rule fired on an earlier bar and was caught late — the'
                  + ' fill is worse than the backtest\'s by that much.'
                : '')
          : `COULD NOT CLOSE ${pos.symbol} — ${why}, but the close was refused: `
            + `${(results.find(r => !r.sent) || {}).error || 'no reason given'}. Do it by hand.`,
      }], day);
    } catch (err) {
      /*
       * An unanswered question is NOT "hold".
       *
       * A position whose exit could not be evaluated is one nobody is managing,
       * and staying quiet about it would look exactly like one that is fine.
       * Said once per position per pass; the loop keeps going.
       */
      looked.push({ symbol: pos.symbol, setupId: pos.setupId, error: err.message });
      console.error(`[Manager] ${pos.symbol}: ${err.message}`);
    }
  }

  return { ran: true, positions: positions.length, acted, looked };
}

/**
 * Watch the clock.
 *
 * A minute tick, like the flattener, so there is one scheduler in this process.
 * Overlap is prevented rather than queued: a slow qp must not stack passes that
 * would each independently decide to close the same position.
 */
let running = false;
function start({ intervalMs = 60000 } = {}) {
  console.log('[Manager] watching open positions for exit rules and trailing stops');
  const t = setInterval(() => {
    if (running) return;
    running = true;
    check()
      .then(r => {
        if (r.acted && r.acted.length) {
          console.log(`[Manager] closed ${r.acted.map(a => a.symbol).join(', ')}`);
        }
      })
      .catch(err => console.error('[Manager] pass failed:', err.message))
      .finally(() => { running = false; });
  }, intervalMs);
  t.unref?.();
  return { stop() { clearInterval(t); } };
}

module.exports = { start, check, openPositions, entryIsoOf, strategyFor, etNow, etWeekday };
