/*
 * A minute-by-minute record of what the desk saw and what it decided.
 *
 * WHY. Everything the desk SENDS is already recorded: the ledger holds every
 * order attempt and the broker's reply, and the alert history holds every fire
 * with the whole plan behind it. Both are append-only and both survive.
 *
 * Nothing recorded what it DECIDED NOT to do.
 *
 * The manager looks at every open position once a minute and almost always
 * concludes "not yet". That conclusion is the entire content of a trading day
 * for a position that ran from 09:36 to 15:50, and it was thrown away — so
 * these questions had no answer at all after the fact:
 *
 *     why did it not close at 10:47, when I would have?
 *     where was the trailing stop at 11:00?
 *     was the exit rule ever close to firing?
 *     did Alpaca and this side agree all day, or only at the end?
 *
 * Not "hard to answer". No answer: the numbers existed for a few milliseconds
 * inside one pass and were dropped.
 *
 * WHY IT IS NOT THE ALERT FEED. The feed is for things worth waking a phone
 * for, and a line a minute saying "still holding" would bury the one line that
 * mattered — the failure that teaches you to stop reading it. This is the other
 * half: everything, unread, until a day is being reviewed.
 *
 * WHY IT IS NOT THE LEDGER. That file is what went to a broker, and its value
 * is that every line is a thing that really happened to money. Mixing
 * observations into it would end that.
 *
 * ONE LINE PER PASS, not per position — a pass is what the manager actually did
 * and its positions belong together. Roughly 390 lines a session, a few hundred
 * kilobytes a day, rotated by month like the alert history.
 */

const fs = require('fs');
const path = require('path');

const DIR = process.env.DATA_DIR || path.join(__dirname, '..', '..', 'data');
const LOG_DIR = process.env.SESSION_LOG_DIR || path.join(DIR, 'history');

/** `session-2026-08.jsonl` — by month, so a day's review is one grep. */
function fileFor(date) {
  const month = String(date || '').slice(0, 7) || 'unknown';
  return path.join(LOG_DIR, `session-${month}.jsonl`);
}

/**
 * Record one pass.
 *
 * NEVER THROWS. This is an observer; a full disk or a bad permission must not
 * take down the loop that closes positions. A failed write is reported once to
 * the console and the pass carries on.
 */
function record(entry) {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(fileFor(entry.date), `${JSON.stringify(entry)}\n`);
    return true;
  } catch (err) {
    console.error('[SessionLog] could not write:', err.message);
    return false;
  }
}

/**
 * What the manager saw on one pass, reduced to what a review actually needs.
 *
 * DELIBERATELY NOT the whole qp answer. A pass a minute for six hours is 390
 * copies of every field, and the ones that never change — the strategy's name,
 * its shape — are noise repeated 390 times. What is kept is what MOVES: the
 * stop, whether the rule fired, whether the broker still held it.
 */
function passOf({ at, date, positions = [], held = null, acted = [] }) {
  return {
    at: at || Date.now(),
    date,
    // `null` means Alpaca was not asked or did not answer, which is NOT the
    // same as an empty list, and a review has to be able to tell them apart.
    heldAtBroker: held === null ? null : [...held],
    positions: positions.map(p => ({
      symbol: p.symbol,
      setupId: p.setupId,
      side: p.side,
      // A skipped position carries the ledger row rather than a qp answer, and
      // there the fill price is `price`. Same fact, two spellings.
      entry: p.entry === undefined ? (p.price === undefined ? null : p.price) : p.entry,
      // The three that move, and the reason the file exists.
      stop: p.stop_now === undefined ? null : p.stop_now,
      stopMoved: !!p.stop_moved,
      breached: !!p.breached,
      exitNow: !!p.exit_now,
      // How late the rule was caught. 0 is "this bar"; anything else is a cost
      // the backtest did not pay, and it is invisible unless it is written down.
      exitBarsAgo: p.exit_bars_ago === undefined ? null : p.exit_bars_ago,
      // Reported by qp and deliberately never acted on, so the ONLY trace it
      // leaves is here and in one alert.
      wrongSide: p.stop_wrong_side ? true : undefined,
      // Whether this pass had anything to decide at all. A frozen stop with no
      // exit rule is entirely the broker's, and a review that cannot tell that
      // apart from "watched and held" is reading the wrong thing.
      managed: p.managed === undefined ? undefined : !!p.managed,
      barsHeld: p.bars_held === undefined ? null : p.bars_held,
      // Only when there is one — an error every minute for a symbol qp cannot
      // price is the thing a review most needs to find, and it is invisible in
      // the alert feed because it never produced an order.
      error: p.error || undefined,
      skipped: p.skipped || undefined,
    })),
    acted: acted.map(a => ({
      symbol: a.symbol, why: a.why, sent: a.sent,
      alreadyFlat: a.alreadyFlat || undefined,
      dryRun: a.dryRun || undefined,
    })),
  };
}

/** Every pass recorded for a date, oldest first. */
function read(date) {
  let raw;
  try { raw = fs.readFileSync(fileFor(date), 'utf8'); } catch { return []; }
  const out = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const o = JSON.parse(line);
      if (!date || o.date === date) out.push(o);
    } catch { /* one bad line does not spoil the day */ }
  }
  return out.sort((a, b) => (a.at || 0) - (b.at || 0));
}

/**
 * The day for one position, as a story rather than 390 rows.
 *
 * The point of the file is the SHAPE of a day — where the stop went, when the
 * rule came close — and 390 near-identical lines hide that as thoroughly as
 * having no file at all. So consecutive passes that say the same thing are
 * collapsed, and only the changes are returned.
 */
function trackOf(date, symbol) {
  const want = String(symbol || '').toUpperCase();
  const out = [];
  let last = null;
  for (const pass of read(date)) {
    const p = (pass.positions || []).find(x => String(x.symbol).toUpperCase() === want);
    if (!p) continue;
    // The fields whose CHANGE is the story. `barsHeld` moves every minute by
    // definition, so it is carried but never counted as a change — otherwise
    // nothing would ever collapse.
    const key = JSON.stringify([p.stop, p.breached, p.exitNow, p.wrongSide,
                                p.error, p.skipped,
                                pass.heldAtBroker === null
                                  ? null : pass.heldAtBroker.includes(want)]);
    if (key === last) continue;
    last = key;
    out.push({ at: pass.at, ...p,
               heldAtBroker: pass.heldAtBroker === null ? null
                 : pass.heldAtBroker.includes(want) });
  }
  return out;
}

/** Every name the manager looked at on a date, in the order it first saw them. */
function symbolsOn(date) {
  const seen = [];
  for (const pass of read(date)) {
    for (const p of pass.positions || []) {
      const s = String(p.symbol || '').toUpperCase();
      if (s && !seen.includes(s)) seen.push(s);
    }
  }
  return seen;
}

module.exports = { record, passOf, read, trackOf, symbolsOn, fileFor, LOG_DIR };
