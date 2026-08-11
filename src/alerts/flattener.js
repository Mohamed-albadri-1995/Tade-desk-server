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
  if (!open.length) return { ran: true, closed: [] };

  const results = await broker.flattenAll(day, cfg);
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
    level: failed.length ? 'error' : 'info',
    detail: failed.length
      ? `COULD NOT CLOSE ${failed.map(f => f.symbol).join(', ')} — `
        + `${failed[0].error || 'refused'}. Close it yourself before the bell.`
        + (done.length ? ` (${done.join(', ')} did close.)` : '')
      : `Closed at ${cfg.flattenAt}: ${done.join(', ')}. `
        + 'Any that were already flat ignored it.',
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
