/*
 * The minute-by-minute record of what the desk saw.
 *
 * WHAT WAS MISSING, and why this file exists at all. Everything the desk SENDS
 * was already recorded: the ledger holds every order attempt and the broker's
 * reply, the alert history holds every fire with the plan behind it. Both are
 * append-only and both survive a restart.
 *
 * Nothing recorded what it DECIDED NOT TO DO. The manager looks at every open
 * position once a minute and almost always concludes "not yet", and that
 * conclusion is the entire content of a trading day for a position that ran
 * from 09:36 to 15:50. So these had no answer after the fact — not a hard one,
 * none:
 *
 *     why did it not close at 10:47, when I would have?
 *     where was the trailing stop at 11:00?
 *     was the exit rule ever close to firing?
 *     did Alpaca and this side agree all day, or only at the end?
 *
 * These tests hold the four properties a review actually depends on:
 *
 *   1. it never throws, because it runs inside the loop that closes positions
 *   2. "Alpaca did not answer" stays distinguishable from "Alpaca says flat"
 *   3. a day collapses to its CHANGES, or 390 identical lines hide the shape
 *   4. a corrupt line costs one line, not the day
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

let DIR;
let log;

beforeEach(() => {
  DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'session-log-'));
  process.env.SESSION_LOG_DIR = DIR;
  jest.resetModules();
  log = require('../src/setups/sessionLog');
});

afterEach(() => {
  delete process.env.SESSION_LOG_DIR;
  fs.rmSync(DIR, { recursive: true, force: true });
});

const pass = (over = {}) => log.passOf({ date: '2026-08-19', ...over });

// ── where it goes ──────────────────────────────────────────────────────────

describe('the file', () => {
  test('is named by MONTH, so a day is one grep and a year is not one file', () => {
    expect(path.basename(log.fileFor('2026-08-19'))).toBe('session-2026-08.jsonl');
    expect(path.basename(log.fileFor('2026-09-01'))).toBe('session-2026-09.jsonl');
  });

  test('a missing date still lands somewhere rather than at a path of ""', () => {
    expect(path.basename(log.fileFor(undefined))).toBe('session-unknown.jsonl');
  });

  test('one line per pass, appended, never rewritten', () => {
    log.record(pass({ at: 1 }));
    log.record(pass({ at: 2 }));
    const raw = fs.readFileSync(log.fileFor('2026-08-19'), 'utf8');
    expect(raw.trim().split('\n')).toHaveLength(2);
  });

  test('the directory is made if it is not there', () => {
    fs.rmSync(DIR, { recursive: true, force: true });
    expect(log.record(pass({ at: 1 }))).toBe(true);
  });
});

// ── the one rule that outranks everything else here ────────────────────────

describe('it never throws', () => {
  /*
   * THIS IS AN OBSERVER. It runs at the end of the pass that closes positions,
   * and a full disk or a bad permission must cost the observation, never the
   * close. A thrown error here would be caught by the manager's own handler and
   * would take the whole pass with it.
   */
  test('an unwritable directory is reported and returns false', () => {
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(fs, 'appendFileSync').mockImplementation(() => {
      throw new Error('ENOSPC: no space left on device');
    });
    expect(() => log.record(pass({ at: 1 }))).not.toThrow();
    expect(log.record(pass({ at: 1 }))).toBe(false);
    expect(spy).toHaveBeenCalled();
    fs.appendFileSync.mockRestore();
    spy.mockRestore();
  });

  test('reading a day that was never written is an empty list, not a crash', () => {
    expect(log.read('2019-01-01')).toEqual([]);
    expect(log.trackOf('2019-01-01', 'EYPT')).toEqual([]);
    expect(log.symbolsOn('2019-01-01')).toEqual([]);
  });
});

// ── the distinction the whole loop depends on ──────────────────────────────

describe('"could not ask" versus "holds nothing"', () => {
  /*
   * The manager filters closes against what Alpaca says it holds, and treats an
   * unanswered question as "do not filter". A log that flattened the two into an
   * empty list would make a day where Alpaca was unreachable read exactly like a
   * day where every position had already stopped out — opposite facts.
   */
  test('null is kept as null, not turned into an empty list', () => {
    expect(pass({ held: null }).heldAtBroker).toBeNull();
  });

  test('an empty set is an empty list, which is a different answer', () => {
    expect(pass({ held: new Set() }).heldAtBroker).toEqual([]);
  });

  test('a Set survives JSON, which it would not without the copy', () => {
    log.record(pass({ at: 1, held: new Set(['EYPT']) }));
    expect(log.read('2026-08-19')[0].heldAtBroker).toEqual(['EYPT']);
  });

  test('the track says which of the three it was, per pass', () => {
    const p = { symbol: 'EYPT', stop_now: 5 };
    log.record(pass({ at: 1, positions: [p], held: null }));
    log.record(pass({ at: 2, positions: [p], held: new Set(['EYPT']) }));
    log.record(pass({ at: 3, positions: [p], held: new Set() }));
    expect(log.trackOf('2026-08-19', 'EYPT').map(t => t.heldAtBroker))
      .toEqual([null, true, false]);
  });
});

// ── what is kept, and what is deliberately not ─────────────────────────────

describe('what a pass records', () => {
  const answer = {
    symbol: 'EYPT', setupId: 'or-vwap', side: 'long', entry: 5.42,
    stop_now: 5.31, stop_moved: true, breached: false, exit_now: false,
    bars_held: 12, exit_bars_ago: null, managed: true,
  };

  test('the three that move — the reason the file exists', () => {
    const p = pass({ positions: [answer] }).positions[0];
    expect(p).toMatchObject({ stop: 5.31, stopMoved: true, breached: false, exitNow: false });
  });

  test('how LATE the exit rule was caught, which is a cost the backtest never paid', () => {
    const p = pass({ positions: [{ ...answer, exit_now: true, exit_bars_ago: 4 }] });
    expect(p.positions[0]).toMatchObject({ exitNow: true, exitBarsAgo: 4 });
  });

  /*
   * A stop on the wrong side of the entry is reported by qp and deliberately
   * never acted on. That makes this file and one alert its only trace.
   */
  test('a wrong-side stop is recorded even though nothing was done about it', () => {
    expect(pass({ positions: [{ ...answer, stop_wrong_side: true }] })
      .positions[0].wrongSide).toBe(true);
    expect(pass({ positions: [answer] }).positions[0].wrongSide).toBeUndefined();
  });

  /*
   * An error every minute for a name qp cannot price is the thing a review most
   * needs to find, and it is invisible in the alert feed because it never
   * produced an order.
   */
  test('a position that could not be judged is kept, with the reason', () => {
    const p = pass({ positions: [{ symbol: 'ZZZZ', setupId: 's', error: 'no bars' }] });
    expect(p.positions[0]).toMatchObject({ symbol: 'ZZZZ', error: 'no bars' });
  });

  test('a skipped position keeps its ledger fill price, which is spelled `price`', () => {
    const p = pass({ positions: [{ symbol: 'X', price: 3.2, skipped: 'no setup by that id' }] });
    expect(p.positions[0]).toMatchObject({ entry: 3.2, skipped: 'no setup by that id' });
  });

  test('a missing stop is null, never 0 — 0 is a price and null is an absence', () => {
    expect(pass({ positions: [{ symbol: 'X' }] }).positions[0].stop).toBeNull();
  });

  test('what it acted on rides in the same line as what it saw', () => {
    const p = pass({ acted: [{ symbol: 'EYPT', why: 'the exit rule fired', sent: 2 }] });
    expect(p.acted[0]).toMatchObject({ symbol: 'EYPT', sent: 2 });
  });

  test('a dry run is marked as one, so it is never read as a trade', () => {
    const p = pass({ acted: [{ symbol: 'E', why: 'x', sent: false, dryRun: true }] });
    expect(p.acted[0].dryRun).toBe(true);
  });

  /*
   * DELIBERATELY NOT THE WHOLE ANSWER. A pass a minute for six hours is 390
   * copies of every field, and the ones that never change — the strategy's
   * name, its shape, qp's standing note about synthetic stops — are noise
   * repeated 390 times.
   */
  test('the fields that never change are dropped', () => {
    const p = pass({ positions: [{ ...answer, name: 'OR + VWAP long',
      note: 'a synthetic stop fills at the next observation', bar: { time: 't' } }] });
    expect(p.positions[0].note).toBeUndefined();
    expect(p.positions[0].bar).toBeUndefined();
  });
});

// ── reading a day back ─────────────────────────────────────────────────────

describe('reading it back', () => {
  test('oldest first, whatever order the lines are in', () => {
    log.record(pass({ at: 300 }));
    log.record(pass({ at: 100 }));
    log.record(pass({ at: 200 }));
    expect(log.read('2026-08-19').map(p => p.at)).toEqual([100, 200, 300]);
  });

  test('one month\'s file, one day\'s answer', () => {
    log.record(log.passOf({ at: 1, date: '2026-08-18' }));
    log.record(log.passOf({ at: 2, date: '2026-08-19' }));
    // Same file — they share a month — and the other day is filtered out.
    expect(log.fileFor('2026-08-18')).toBe(log.fileFor('2026-08-19'));
    expect(log.read('2026-08-19')).toHaveLength(1);
  });

  /* A truncated last line — a crash mid-append — costs that line and no more. */
  test('a corrupt line costs one line, not the day', () => {
    log.record(pass({ at: 1 }));
    fs.appendFileSync(log.fileFor('2026-08-19'), '{"at":2,"date":"2026-08-19"\n');
    log.record(pass({ at: 3 }));
    expect(log.read('2026-08-19').map(p => p.at)).toEqual([1, 3]);
  });

  test('symbolsOn lists each name once, in the order it was first seen', () => {
    log.record(pass({ at: 1, positions: [{ symbol: 'EYPT' }, { symbol: 'CAPR' }] }));
    log.record(pass({ at: 2, positions: [{ symbol: 'CAPR' }, { symbol: 'BRUN' }] }));
    expect(log.symbolsOn('2026-08-19')).toEqual(['EYPT', 'CAPR', 'BRUN']);
  });
});

// ── the shape of a day ─────────────────────────────────────────────────────

describe('the track for one position', () => {
  const at = n => ({ at: n });

  /*
   * THE POINT OF THE FILE IS THE SHAPE OF A DAY — where the stop went, when the
   * rule came close — and 390 near-identical rows hide that as thoroughly as
   * having no file at all.
   */
  test('passes that said the same thing collapse to one', () => {
    for (let i = 1; i <= 5; i += 1) {
      log.record(pass({ ...at(i), positions: [{ symbol: 'EYPT', stop_now: 5.1 }] }));
    }
    expect(log.trackOf('2026-08-19', 'EYPT')).toHaveLength(1);
  });

  test('a stop that moves is a new row, at the minute it moved', () => {
    log.record(pass({ ...at(1), positions: [{ symbol: 'EYPT', stop_now: 5.1 }] }));
    log.record(pass({ ...at(2), positions: [{ symbol: 'EYPT', stop_now: 5.1 }] }));
    log.record(pass({ ...at(3), positions: [{ symbol: 'EYPT', stop_now: 5.4 }] }));
    const t = log.trackOf('2026-08-19', 'EYPT');
    expect(t.map(x => [x.at, x.stop])).toEqual([[1, 5.1], [3, 5.4]]);
  });

  /*
   * `barsHeld` moves every single minute by definition. Counting it as a change
   * would collapse nothing and the file would be as unreadable as no file.
   */
  test('the clock ticking is not a change', () => {
    log.record(pass({ ...at(1), positions: [{ symbol: 'EYPT', stop_now: 5, bars_held: 1 }] }));
    log.record(pass({ ...at(2), positions: [{ symbol: 'EYPT', stop_now: 5, bars_held: 2 }] }));
    expect(log.trackOf('2026-08-19', 'EYPT')).toHaveLength(1);
  });

  test('the exit rule firing is always a row', () => {
    log.record(pass({ ...at(1), positions: [{ symbol: 'EYPT', stop_now: 5 }] }));
    log.record(pass({ ...at(2), positions: [{ symbol: 'EYPT', stop_now: 5, exit_now: true }] }));
    expect(log.trackOf('2026-08-19', 'EYPT').map(x => x.exitNow)).toEqual([false, true]);
  });

  test('a name that was never open has no track, and does not borrow another\'s', () => {
    log.record(pass({ ...at(1), positions: [{ symbol: 'EYPT', stop_now: 5 }] }));
    expect(log.trackOf('2026-08-19', 'CAPR')).toEqual([]);
  });

  test('it matches on the name however it was cased', () => {
    log.record(pass({ ...at(1), positions: [{ symbol: 'eypt', stop_now: 5 }] }));
    expect(log.trackOf('2026-08-19', 'EYPT')).toHaveLength(1);
  });

  /*
   * The broker going quiet mid-session is exactly the kind of thing a review is
   * looking for, and it is a change in what the desk KNEW even when the numbers
   * it computed stayed put.
   */
  test('Alpaca going unreachable is a change even when nothing else moved', () => {
    const p = { symbol: 'EYPT', stop_now: 5 };
    log.record(pass({ ...at(1), positions: [p], held: new Set(['EYPT']) }));
    log.record(pass({ ...at(2), positions: [p], held: null }));
    expect(log.trackOf('2026-08-19', 'EYPT')).toHaveLength(2);
  });
});

// ── it is wired in ─────────────────────────────────────────────────────────

describe('the manager writes to it', () => {
  const SRC = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'setups', 'manager.js'), 'utf8');

  test('every pass is recorded, with what it saw and what it did', () => {
    expect(SRC).toMatch(/require\('\.\/sessionLog'\)/);
    expect(SRC).toMatch(/sessionLog\.record\(sessionLog\.passOf\(\{/);
    expect(SRC).toMatch(/positions: looked, held: stillHeld, acted/);
  });

  /*
   * LAST IN THE PASS. The log is an observer; writing it before the closes go
   * out would put a disk between a breached stop and the order that answers it.
   */
  test('it is written after the loop, not inside it', () => {
    const write = SRC.indexOf('sessionLog.record');
    expect(write).toBeGreaterThan(SRC.indexOf('await broker.closePosition'));
    expect(write).toBeLessThan(SRC.indexOf('return { ran: true, positions: positions.length'));
  });

  test('the ledger fill price is carried through, since qp does not return it', () => {
    expect(SRC).toMatch(/entry: pos\.price/);
  });
});

/*
 * The session log rotates into data/history/, next to the alert history — one
 * directory to archive a day. That directory was the alert feed's alone, and
 * one function in it read EVERY .jsonl file by extension.
 */
describe('it does not contaminate the alert history', () => {
  const SRC = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'alerts', 'store.js'), 'utf8');

  /*
   * Session lines carry a `date` too. Read by the date picker, they would put a
   * day in the list because a POSITION was watched on it — and choosing that day
   * would show an empty feed, which reads as "the alerts were lost".
   */
  test('the date picker reads alert files by NAME, not by extension', () => {
    expect(SRC).toMatch(/startsWith\('alert-history-'\) && f\.endsWith\('\.jsonl'\)/);
  });

  test('the two files cannot collide', () => {
    expect(path.basename(log.fileFor('2026-08-19'))).not.toMatch(/^alert-history-/);
  });
});

describe('the day report reads it', () => {
  const SRC = fs.readFileSync(
    path.join(__dirname, '..', 'scripts', 'today.js'), 'utf8');

  test('there is a section for it, and it runs', () => {
    expect(SRC).toMatch(/HOW EACH POSITION WAS MANAGED/);
    expect(SRC).toMatch(/^\s*managed\(\);$/m);
  });

  /*
   * "Nothing was open" and "the manager was not running" produce the same empty
   * file, and a report that silently printed nothing would let a dead loop pass
   * for a quiet day for as long as it took to notice.
   */
  test('an empty log says it cannot tell a quiet day from a dead loop', () => {
    expect(SRC).toMatch(/no manager passes recorded/);
    expect(SRC).toMatch(/the manager was down/);
  });
});
