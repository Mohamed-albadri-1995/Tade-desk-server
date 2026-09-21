/*
 * THE ALERT TOLD YOU TO TAKE THE WHEEL FROM A MACHINE THAT WAS STEERING.
 *
 * Reported as: "It's not just collapsing. It's not useful and I think it's
 * even wrong statement."
 *
 * The NOTE on every order from a setup whose stop follows an indicator:
 *
 *     the stop trails an indicator — sent as a fixed level, so it will NOT
 *       follow. Manage it yourself
 *
 * It is false, and false in the direction that makes things worse. Three
 * places in this repo already knew better:
 *
 *   src/setups/manager.js   closes the position when `answer.breached &&
 *                           answer.stop_kind === 'anchored'`, on every bar
 *
 *   manager.js's header     "Test has a stop that MOVES and RATCHETS — up with
 *                           the lower VWAP band, never down. A broker is handed
 *                           one price. Neither can be sent. BOTH CAN BE
 *                           WATCHED. This is the watching."
 *
 *   chart/manage.py         managed = has_rules or (stop_kind == 'anchored'
 *                           and not frozen)
 *
 * So the desk had built the following, wired it in, run it every bar — and
 * then told the reader on every alert that it had not. Someone acting on that
 * instruction closes by hand a position the box is already managing, which is
 * the one piece of advice here that can only do harm.
 *
 * WHAT IS TRUE is the cost qp already states: a synthetic stop fills at the
 * NEXT OBSERVATION, not at the level. The backtest fills a within-bar touch AT
 * the stop and this side cannot see inside a bar. That is a real difference
 * between live and tested on every trade — a number to watch, not a reason to
 * intervene.
 *
 * RUN, not grepped: the file's comments now quote the sentence they replaced,
 * so a substring search over the source would find it and pass.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(ROOT, 'src', 'setups', 'runner.js'), 'utf8');

/** unmanagedLine(), lifted out and made callable. */
function note(plan) {
  const from = src.indexOf('function unmanagedLine(plan)');
  if (from < 0) {
    throw new Error('src/setups/runner.js no longer says what the broker was '
      + 'not handed — that note is the only place an order says who is '
      + 'watching the exit');
  }
  // eslint-disable-next-line no-new-func
  return new Function(`${src.slice(from, src.indexOf('\n}', from) + 2)}
    ; return unmanagedLine;`)()(plan);
}

const ANCHORED = { stop_anchored: true, legs: [] };

describe('what the order says about a stop that follows a line', () => {
  test('it does not tell you to manage it yourself', () => {
    const out = note(ANCHORED);
    expect(out).not.toMatch(/Manage it yourself/i);
    expect(out).not.toMatch(/will\s+NOT\s+follow/i);
  });

  test('it says the box follows it and closes on a breach', () => {
    const out = note(ANCHORED);
    expect(out).toContain('the box follows it and closes on a breach');
  });

  test('and it names the cost that is actually there', () => {
    // The fill, not the following. This is the live-vs-backtest gap and it is
    // the only part of the old sentence that was pointing at something real.
    const out = note(ANCHORED);
    expect(out).toContain('NEXT bar, not at the level');
    expect(out).toMatch(/worse than the backtest/);
  });

  test('the claim matches what the manager actually does', () => {
    /*
     * THE CROSS-CHECK, and the reason this file exists. The sentence on the
     * alert is a claim about another file. If that file stops closing on an
     * anchored breach the sentence becomes false again, silently, and every
     * other test here would still pass.
     */
    const mgr = fs.readFileSync(path.join(ROOT, 'src', 'setups', 'manager.js'), 'utf8');
    expect(mgr).toContain("answer.breached && answer.stop_kind === 'anchored'");
    expect(mgr).toContain('the trailing stop at ${answer.stop_now} was breached');
  });

  test('a fixed stop gets no note about following at all', () => {
    // Nothing to say is nothing printed. A note on every order is a note on
    // no order.
    expect(note({ stop_anchored: false, legs: [] })).toBe('');
    expect(note(null)).toBe('');
    expect(note({})).toBe('');
  });
});

describe('the other notes are unchanged', () => {
  test('an exit rule still says the box closes it', () => {
    const out = note({ exit_rule: true, legs: [] });
    expect(out).toContain('it also leaves on a RULE');
    expect(out).toContain('the box watches for that');
  });

  test('breakeven after the first leg is still yours to move', () => {
    // THIS one really is manual: nothing on this side moves a resting stop,
    // and the broker will not do it either.
    expect(note({ breakeven_after_leg: true, legs: [] }))
      .toContain('move it yourself');
  });

  test('an anchored target still rides the stop', () => {
    expect(note({ legs: [{ anchored: true }] }))
      .toContain('cannot rest at the broker');
  });

  test('several notes are joined into one sentence, once', () => {
    const out = note({ exit_rule: true, stop_anchored: true, legs: [] });
    expect(out.startsWith(' · NOTE: ')).toBe(true);
    expect((out.match(/NOTE:/g) || []).length).toBe(1);
    expect(out.endsWith('.')).toBe(true);
  });
});
