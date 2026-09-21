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
 *
 * AND THEN IT ASKS WHETHER IT WORKED.
 *
 * 2026-09-21, 15:57 ET, found by opening the broker's app: one position of
 * 1,045 shares still on, seven minutes after this ran. This had published
 * "End of session" at 15:50:04 at level INFO — the level that means nothing
 * failed.
 *
 * It could not have known. `sent` means SignalStack ACCEPTED THE WEBHOOK. It
 * does not mean the broker moved anything, and this asked Alpaca what was held
 * BEFORE it sent the closes and never again afterwards. So the alert said
 * "Closed at 15:50: U" whether or not U closed — a field that says the same
 * thing whatever happened, which is the same as no field at all.
 *
 * It asks again now. Anything this desk just closed that Alpaca is still
 * holding is an ERROR, by name and share count, at 15:50 with ten minutes of
 * session left to act in — instead of at 15:57 from the broker's app.
 *
 * IT DOES NOT RE-SEND. `close` carries no quantity, so a second close issued
 * while the first is still working is two sells of the same position and a
 * SHORT if both fill. Over-closing is safe on a symbol that is already flat
 * and is not safe here. The desk says what is wrong; the person closes it.
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

/*
 * HOW LONG TO GIVE THE BROKER BEFORE CALLING IT A FAILURE.
 *
 * A market order at 15:50 fills in seconds, but "seconds" is not zero, and an
 * alert that cries wolf on every slow fill is one that stops being read — which
 * is the same outcome as not having it. Three looks, stopping at the first one
 * that comes back flat, so the normal case costs four seconds and the bad case
 * is known twenty seconds in, with nine and a half minutes still on the clock.
 */
const VERIFY_WAITS_MS = [4000, 6000, 10000];

const nap = ms => new Promise(r => { setTimeout(r, ms); });

/**
 * Of the symbols just closed, which is Alpaca still holding?
 *
 * `{ asked: false }` when the question could not be put — no Alpaca account, or
 * it did not answer. AN ERROR IS NEVER A ZERO: "Alpaca says you are flat" and
 * "Alpaca did not say" are opposite facts, and the second one must not render
 * as the first on the one alert that exists to catch this.
 */
async function stillHeld(symbols, { waits = VERIFY_WAITS_MS, sleep = nap } = {}) {
  const want = new Set(symbols.map(s => String(s || '').toUpperCase()));
  if (!want.size) return { asked: false, held: [], why: 'nothing was closed' };

  let held = null;
  let why = 'Alpaca was not asked';
  for (const ms of waits) {
    await sleep(ms);
    let r;
    try { r = await reconcile.heldNow({ maxAgeMs: 0 }); }
    catch (err) { why = err.message; continue; }
    // maxAgeMs:0 because heldNow caches for eight seconds, and the cached
    // answer here is the one taken BEFORE the closes went out.
    if (!r || !r.ok) { why = (r && r.error) || 'Alpaca did not answer'; continue; }
    if (r.verifiable === false) {
      return { asked: false, held: [], why: r.reason || 'no Alpaca account to ask' };
    }
    held = (r.positions || []).filter(
      p => want.has(String(p.symbol || '').toUpperCase()) && Number(p.qty) !== 0);
    if (!held.length) return { asked: true, held: [] };
    why = null;
  }
  // Every attempt threw or came back not-ok: no answer, not a clean sheet.
  if (!held) return { asked: false, held: [], why };
  return { asked: true, held };
}

/**
 * Close everything, if this is the minute.
 *
 * Runs regardless of whether anything is open — openSymbols() answers that, and
 * it answering "nothing" is the normal case on a day with no fills.
 */
async function check(at = Date.now(), opts = {}) {
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
  /*
   * AND THE ONES A CLOSE WAS ALREADY SENT FOR THAT ARE STILL ON.
   *
   * `notClosed` used to come back inside `foreign` — the bucket that is
   * reported and never touched, under a sentence reading "nothing here opened
   * it". Both halves were wrong: this desk DID open it, and finishing that job
   * is the most obviously correct thing to do with it. See carriedOver().
   */
  const notClosed = stale.ok ? (stale.notClosed || []) : [];
  const mine = [...carried, ...notClosed];
  const extra = [...new Set(mine.map(p => p.symbol))].filter(s => !open.includes(s));
  /*
   * TWO REASONS A NAME IS IN `extra`, AND THEY ARE DIFFERENT INSTRUCTIONS.
   * "left open from an earlier session" points at the 15:50 that did not run;
   * "a close was sent for it and it is still on" points at the broker. One
   * sentence covering both is a sentence that sends you to the wrong place.
   */
  const fromEarlier = extra.filter(s => carried.some(p => p.symbol === s));
  const closeMissed = extra.filter(s => !fromEarlier.includes(s));

  if (!open.length && !extra.length && !foreign.length) return { ran: true, closed: [] };

  const results = await broker.flattenAll(day, cfg);
  for (const sym of extra) {
    /*
     * To the accounts that OPENED it, not to today's default. A close sent to
     * an account that never held it is a no-op there and leaves the position
     * exactly where it was.
     */
    const p = mine.find(x => x.symbol === sym);
    const dests = (p.destinations || []).length ? p.destinations : [null];
    for (const d of dests) {
      results.push(await broker.closePosition(sym, day,
        (d && broker.destinationCfg(d)) || cfg,
        // The one caller for which this really IS the end of the session.
        { reason: 'end of session' }));
    }
  }

  const done = results.filter(r => r.sent).map(r => r.symbol);
  const failed = results.filter(r => !r.sent);

  /*
   * AND THEN ASK WHETHER IT WORKED.
   *
   * `sent` is SignalStack's answer to the webhook, taken in the same second it
   * was posted. What the BROKER does with it happens afterwards and is not in
   * that answer. On 2026-09-21 SignalStack accepted this close, Alpaca refused
   * it — "insufficient qty available for order (requested: 1045, available:
   * 0)", because the position's own protective stop was holding every share —
   * and the only place that appeared was an email. This published INFO.
   */
  const verify = await stillHeld(done, opts.verify || {});

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
    level: (failed.length || foreign.length || verify.held.length) ? 'error' : 'info',
    /*
     * THE VERIFIED ANSWER LEADS, when there is one. "Closed at 15:50: U" with
     * "still held" further down the same paragraph is a sentence that reads as
     * a success on a phone, and this is the line that has to be believed.
     */
    detail: (verify.held.length
      ? `STILL HELD AFTER THE CLOSE: ${verify.held.map(p => `${p.symbol} `
          + `${Math.abs(Number(p.qty))} sh${p.account ? ` (${p.account})` : ''}`).join(', ')}`
        + ' — the close was accepted by SignalStack and the position did not move.'
        + ' CLOSE IT YOURSELF NOW. The usual cause is the position\'s own stop'
        + ' order holding every share, which makes the quantity available to'
        + ' sell zero: cancel the working order first, then close.'
      : failed.length
      ? `COULD NOT CLOSE ${failed.map(f => f.symbol).join(', ')} — `
        + `${failed[0].error || 'refused'}. Close it yourself before the bell.`
        + (done.length ? ` (${done.join(', ')} did close.)` : '')
      : `Closed at ${cfg.flattenAt}: ${done.join(', ') || 'nothing was open'}`
        + (verify.asked ? ', and Alpaca confirms it is flat' : '')
        + '. Any that were already flat ignored it.')
      // What was carried in from an earlier session, so it is visible that this
      // was not a normal day's close.
      + (fromEarlier.length
        ? ` · ${fromEarlier.join(', ')} had been left open from an EARLIER session `
          + 'and was closed too — find out why it survived its own day.'
        : '')
      + (closeMissed.length
        ? ` · ${closeMissed.join(', ')} had a close sent for it already and was `
          + 'STILL HELD, so it was closed again — the first one did not take.'
        : '')
      /*
       * THE QUESTION WAS NOT PUT. Not the same as "it is flat", and on this
       * alert the difference is an overnight position.
       */
      + (done.length && !verify.asked && !verify.held.length
        ? ` · could not confirm the close landed (${verify.why}) — `
          + 'check the broker yourself'
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

  console.log(`[Flatten] ${cfg.flattenAt} — closed ${done.length}/${results.length}`
    + (verify.held.length
      ? ` — STILL HELD: ${verify.held.map(p => p.symbol).join(', ')}`
      : verify.asked ? ' — verified flat' : ` — unverified (${verify.why})`));
  return { ran: true, closed: done, failed, stillHeld: verify.held, verified: verify.asked };
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
