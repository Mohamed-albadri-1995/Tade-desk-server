/*
 * Closing what the box opened, before the bell.
 *
 * WHY THIS HAD TO EXIST. A strategy can leave part of a position with no exit
 * the broker can hold. "Take half at 2R and let the rest run" — the 09:35
 * opening-range setup does exactly this — sends a runner with a stop and no
 * target. In a backtest that runner is closed at the session's end. At a broker
 * it is not: it sits there overnight, in an account that is not allowed to hold
 * overnight, and nothing anywhere says so.
 *
 * The same is true of any position whose stop and target both simply never get
 * hit. A bracket is not an exit plan; it is two prices that might be reached.
 *
 * WHY IT RUNS HERE. The alerts process is the only one with no TOOL_ID — the
 * account is one account, and nine screeners each closing what they opened
 * would be nine processes racing to flatten the same symbol. This one reads the
 * shared ledger and closes everything.
 *
 * WHAT IT CANNOT KNOW. Whether a position is still open. SignalStack has no
 * endpoint for that, and a stop that filled at 11:04 leaves no trace here
 * unless the callback happened to say so. So it deliberately OVER-closes:
 * `close` on a symbol that is already flat is a no-op at the broker, and
 * missing one that is still open is an overnight position.
 */

const broker = require('../broker/signalstack');
const reconcile = require('./../broker/reconcile');
const store = require('./store');
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

/*
 * Fired once per session, tracked in memory AND on the ledger.
 *
 * In memory so a minute tick that runs twice does not send twice; on the ledger
 * because the process can restart at 15:49 and the memory would be empty at
 * exactly the wrong moment. openSymbols() already excludes what has been
 * closed, so a second pass after a restart finds nothing left to do.
 */
let lastRun = null;

/**
 * Close everything, if this is the minute.
 *
 * Runs regardless of whether anything is open — openSymbols() answers that, and
 * it answering "nothing" is the normal case on a day with no fills.
 */
async function check(at = Date.now()) {
  const cfg = broker.settings();
  if (!cfg.flatten || !cfg.armed) return { ran: false };
  if (!etWeekday(at)) return { ran: false };

  const now = etNow(at);
  if (now !== cfg.flattenAt) return { ran: false };

  const day = toETDate(at);
  if (lastRun === day) return { ran: false, reason: 'already run today' };
  lastRun = day;

  const open = broker.openSymbols(day);

  /*
   * AND ANYTHING THAT SURVIVED AN EARLIER SESSION.
   *
   * openSymbols() is keyed by DAY, and so was this whole function. A position
   * not closed on the day it was opened — because this process was down at
   * 15:50, because the desk was disarmed, because the close was refused — is
   * invisible to every flatten that follows: the next day asks about a new
   * date, finds nothing, closes nothing. It was not missed once. It was missed
   * for good, and it sat in the account until somebody opened the broker's app
   * and saw it. That is how this was found.
   *
   * carriedOver() asks Alpaca what it is actually holding and matches each name
   * against the WHOLE ledger, so a stale position is found however old it is.
   * It also separates the two cases that must never be treated alike:
   *
   *   `carried`  this desk opened it and never closed it. Closing it is
   *              finishing a job this desk started, and it is closed.
   *
   *   `foreign`  nothing here ever opened it. That may be a trade taken by hand
   *              for reasons no algorithm on this box knows about, and closing
   *              it would be the worst thing in this file. Said, never touched.
   *
   * Alpaca only. TTP5k is behind TraderEvolution with no position feed, so a
   * position carried over there is still invisible — and this says so rather
   * than implying the account is covered.
   */
  let stale = { ok: false };
  try { stale = await reconcile.carriedOver(day); }
  catch (err) { stale = { ok: false, error: err.message }; }

  const carried = stale.ok ? stale.carried : [];
  const foreign = stale.ok ? stale.foreign : [];
  const extra = carried.map(p => p.symbol).filter(s => !open.includes(s));

  if (!open.length && !extra.length && !foreign.length) return { ran: true, closed: [] };

  const results = await broker.flattenAll(day, cfg);
  for (const sym of extra) {
    /*
     * To the accounts that OPENED it, not to today's default. A close sent to
     * an account that never held it is a no-op there and leaves the position
     * exactly where it was.
     */
    const p = carried.find(x => x.symbol === sym);
    const dests = (p.destinations || []).length ? p.destinations : [null];
    for (const d of dests) {
      results.push(await broker.closePosition(sym, day,
        (d && broker.destinationCfg(d)) || cfg));
    }
  }

  const done = results.filter(r => r.sent).map(r => r.symbol);
  const failed = results.filter(r => !r.sent);

  /*
   * Always published, including the successful case. "I closed your two
   * positions" is worth reading; a failure to close is worth acting on within
   * the ten minutes that are left, and from a phone the two must not look the
   * same as each other or as silence.
   */
  store.publishFires([{
    ruleId: 'broker-flatten',
    rule: 'End of session',
    ticker: null,
    toolId: 'ALERTS',
    date: day,
    at: Date.now(),
    kind: 'broker',
    level: (failed.length || foreign.length) ? 'error' : 'info',
    detail: (failed.length
      ? `COULD NOT CLOSE ${failed.map(f => f.symbol).join(', ')} — `
        + `${failed[0].error || 'refused'}. Close it yourself before the bell.`
        + (done.length ? ` (${done.join(', ')} did close.)` : '')
      : `Closed at ${cfg.flattenAt}: ${done.join(', ') || 'nothing was open'}. `
        + 'Any that were already flat ignored it.')
      // What was carried in from an earlier session, so it is visible that this
      // was not a normal day's close.
      + (extra.length
        ? ` · ${extra.join(', ')} had been left open from an EARLIER session and `
          + 'was closed too — find out why it survived its own day.'
        : '')
      /*
       * AND WHAT WAS DELIBERATELY LEFT. A position this desk never opened is
       * not this desk's to close: it may be a trade taken by hand. But going
       * quiet about it is how one goes overnight, which is the failure that
       * started all of this.
       */
      + (foreign.length
        ? ` · ALPACA STILL HOLDS ${foreign.map(f => `${f.symbol} (${f.qty})`).join(', ')}`
          + ' — nothing here opened it, so it was NOT closed. If you want it flat,'
          + ' do it yourself before the bell.'
        : '')
      + (stale.ok ? '' : ` · could not ask Alpaca what is really open (${stale.error
          || 'no reason given'}), so only today's ledger was closed`),
  }], day);

  console.log(`[Flatten] ${cfg.flattenAt} — closed ${done.length}/${results.length}`);
  return { ran: true, closed: done, failed };
}

/**
 * Watch the clock.
 *
 * A minute tick rather than a cron so there is one scheduler in this process
 * and no second dependency; the check is two string comparisons and a settings
 * read, which is nothing once a minute.
 */
function start({ intervalMs = 30000 } = {}) {
  const cfg = broker.settings();
  console.log(`[Flatten] end-of-session close at ${cfg.flattenAt} ET`
    + `${cfg.flatten ? '' : ' (switched off)'}`);
  const t = setInterval(() => { check().catch(err => {
    console.error('[Flatten] failed:', err.message);
  }); }, intervalMs);
  t.unref?.();
  return { stop() { clearInterval(t); } };
}

/** Test seam — a new session must be able to run again. */
function reset() { lastRun = null; }

module.exports = { start, check, reset, etNow, etWeekday };
