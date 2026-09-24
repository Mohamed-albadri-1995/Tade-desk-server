/*
 * THE DESK READS ONE ACCOUNT AND TRADES ANOTHER.
 *
 * 2026-09-17, the first morning the 09:35 setup ran after the restart loop was
 * fixed. It evaluated 30 names, signalled 13, picked 2, and both were refused:
 *
 *     LONG  BETA 1470 sh @ 21.24 — From Alpaca: insufficient buying power
 *     SHORT CIFR 2089 sh @ 17.88 — From Alpaca: account is not allowed to short
 *
 * Minutes later, the account this box reads for that destination answered:
 *
 *     PA3D8KLCRNFN | BP $197,691 | cash $98,845 | shorting: true | mult 2 | ACTIVE
 *
 * $197,691 of buying power refusing a $31,222 order, and an account with
 * shorting enabled saying it is not allowed to short. Neither refusal can be
 * true of that account — and its own order list settles it: nothing at all
 * since 2026-09-15, while those two orders were certainly sent.
 *
 * ORDERS GO desk → SignalStack → Alpaca, and SignalStack holds its own copy of
 * the credentials. The desk READS one account and TRADES another, and nothing
 * anywhere compared the two.
 *
 * AND EVERY PROTECTION WAS SIZED AGAINST THE WRONG ACCOUNT. liveBuyingPower
 * reduces a position to fit the balance — the right rule, applied to a balance
 * belonging to an account that never receives the order. The same for the
 * borrow check, the same for the blocked check. All correct, all about the
 * wrong account, and all of them silent.
 *
 * On 2026-09-15 the SAME destination filled `sell 173 FTAI` and `sell 548
 * BLSH` in PA3D8KLCRNFN — shorts, in that account, on the day live matched the
 * backtest to $8.69. The account did not change. The destination did.
 *
 * NOTHING HERE GUESSES WHERE THE ORDER WENT. It cannot know. It states the
 * contradiction, which is a fact, and names the one thing that explains it.
 */

const path = require('path');

const broker = require(path.join(__dirname, '..', 'src', 'broker', 'signalstack'));
const { mismatchNote } = broker;

const ALPACA1 = { destinationId: 'alpaca1', destinationName: 'alpaca100k935' };

/** The morning, exactly as the session log recorded it. */
const BETA = {
  message: 'insufficient buying power',
  cfg: ALPACA1,
  liveBuyingPower: 197691,
  accountNumber: 'PA3D8KLCRNFN',
  shortingEnabled: true,
  notional: 1470 * 21.24,                      // $31,222
};
const CIFR = {
  message: 'account is not allowed to short',
  cfg: ALPACA1,
  liveBuyingPower: 197691,
  accountNumber: 'PA3D8KLCRNFN',
  shortingEnabled: true,
  notional: 2089 * 17.8847,                    // $37,361
};

describe('a refusal that contradicts what this box just read', () => {
  /*
   * THE TWO THAT WERE SILENT. Both of these produced a broker message and
   * nothing else — no sign anywhere that the message could not be true.
   */
  test('"no buying power" from an account with $197,691 is flagged', () => {
    expect(mismatchNote(BETA)).toBeTruthy();
  });

  test('"not allowed to short" from an account with shorting on is flagged', () => {
    expect(mismatchNote(CIFR)).toBeTruthy();
  });

  test('it names the account this box read, so there is something to check', () => {
    expect(mismatchNote(BETA)).toMatch(/PA3D8KLCRNFN/);
    expect(mismatchNote(BETA)).toMatch(/alpaca100k935/);
  });

  test('it quotes both numbers, so the contradiction is visible not asserted', () => {
    const n = mismatchNote(BETA);
    expect(n).toMatch(/\$197,691/);
    expect(n).toMatch(/\$31,22\d/);
  });

  /*
   * AND IT SAYS WHAT TO DO. "These numbers disagree" sends the reader nowhere.
   * The hook is the only thing between the two accounts and the only thing
   * that can be changed.
   */
  test('it points at the SignalStack hook, which is the thing to fix', () => {
    expect(mismatchNote(BETA)).toMatch(/SignalStack hook/);
    expect(mismatchNote(CIFR)).toMatch(/SignalStack hook/);
  });

  test('and says plainly that a different account received it', () => {
    expect(mismatchNote(BETA)).toMatch(/DIFFERENT account/);
  });
});

describe('an ordinary refusal is left alone', () => {
  /*
   * ONLY ON AN EXPLICIT CONTRADICTION. An unproven accusation on every
   * rejection teaches the reader to skip the line, and this line has to be
   * read on the morning it appears.
   */
  test('no buying power, when the account really has none', () => {
    expect(mismatchNote({ ...BETA, liveBuyingPower: 900 })).toBeNull();
  });

  test('no buying power for an order larger than the balance', () => {
    expect(mismatchNote({ ...BETA, notional: 400000 })).toBeNull();
  });

  /*
   * THE ASSET VS THE ACCOUNT. "asset cannot be sold short" is a fact about the
   * ticker and contradicts nothing — MMED on 2026-09-15 was exactly that.
   * Treating the two alike would cry wolf on every hard-to-borrow small cap,
   * which is most of what these screeners find.
   */
  test('an UNSHORTABLE ASSET is not a destination mismatch', () => {
    expect(mismatchNote({ ...CIFR,
      message: 'asset "MMED" cannot be sold short' })).toBeNull();
  });

  test('a rejection about something else entirely', () => {
    expect(mismatchNote({ ...BETA, message: 'market is closed' })).toBeNull();
  });

  test('a successful order has no message to contradict', () => {
    expect(mismatchNote({ ...BETA, message: null })).toBeNull();
  });
});

describe('an unread account accuses nobody', () => {
  /*
   * AN ERROR IS NEVER A ZERO, and a reading that never happened is not
   * evidence. When the balance could not be read there is nothing to
   * contradict, and inventing a contradiction from a missing number would be
   * the same fault in the opposite direction.
   */
  test('no balance read means no claim', () => {
    expect(mismatchNote({ ...BETA, liveBuyingPower: null })).toBeNull();
  });

  test('a shorting flag Alpaca did not send means no claim', () => {
    expect(mismatchNote({ ...CIFR, shortingEnabled: null })).toBeNull();
  });

  /*
   * null IS NEVER false AND NEVER true. An account that genuinely cannot short
   * and says so is not a mismatch — it is the truth, and the order was right
   * to fail.
   */
  test('an account that really cannot short is not a mismatch', () => {
    expect(mismatchNote({ ...CIFR, shortingEnabled: false })).toBeNull();
  });

  test('no notional means the buying-power comparison cannot be made', () => {
    expect(mismatchNote({ ...BETA, notional: null })).toBeNull();
    expect(mismatchNote({ ...BETA, notional: 0 })).toBeNull();
  });

  test('it never throws on an empty call', () => {
    expect(() => mismatchNote()).not.toThrow();
    expect(mismatchNote()).toBeNull();
  });
});

describe('the boundary is exact', () => {
  /*
   * AN ORDER THAT EXACTLY FITS IS STILL A CONTRADICTION when it is refused —
   * the account could afford it to the cent. One cent more and it could not,
   * and then the broker is simply right.
   */
  test('an order the balance exactly covers is a contradiction', () => {
    expect(mismatchNote({ ...BETA, liveBuyingPower: 31222, notional: 31222 }))
      .toBeTruthy();
  });

  test('an order a cent over the balance is not', () => {
    expect(mismatchNote({ ...BETA, liveBuyingPower: 31222, notional: 31222.01 }))
      .toBeNull();
  });
});

describe('it is wired into both send paths', () => {
  const fs = require('fs');
  const SRC = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'broker', 'signalstack.js'), 'utf8');

  /*
   * A one-leg order and a three-leg one are refused by the same broker for the
   * same reason. A check on only one of them is a check that is usually not
   * there — the 09:35 setup scales out, so its orders take the multi-leg path.
   */
  /**
   * A named function's body, so a region can be asserted about rather than the
   * file as a whole.
   */
  function bodyOf(name) {
    const i = SRC.indexOf(name);
    expect(i).toBeGreaterThan(-1);
    const j = SRC.indexOf('\n}\n', i);
    return SRC.slice(i, j);
  }

  /*
   * EVERY PLACE THAT REPORTS A REFUSAL RUNS IT — asserted as three regions,
   * not as a count. The first version of this said "exactly 2 call sites" and
   * broke the moment a third legitimate one was added, which is the same
   * brittleness as pinning a line of source: a test that fails on a change
   * that is not a regression gets edited instead of read.
   */
  test('the scale-out path runs it', () => {
    expect(SRC).toMatch(/only \$\{done\.length\} of[\s\S]{0,900}= mismatchNote\(\{/);
  });

  test('the single-order path runs it', () => {
    expect(SRC).toMatch(/order refused'\}`,[\s\S]{0,900}= mismatchNote\(\{/);
  });

  /*
   * AND THE TEST BUTTON, which is the place it matters most: it is what
   * somebody runs when they already suspect something is wrong. On 2026-09-17
   * one share of AAPL through alpaca1's live hook came back "insufficient
   * buying power" from an account holding $197,691, and the button reported
   * the broker's message and nothing else.
   */
  test('the one-share test button runs it', () => {
    expect(bodyOf('async function test({')).toMatch(/= mismatchNote\(\{/);
  });

  test('and there is still exactly one definition of it', () => {
    // CALL SITES, not mentions: `function mismatchNote({` matches the bare
    // name too, and counting the definition as a call site would let a version
    // with no call sites at all pass.
    expect(SRC.split('function mismatchNote(').length - 1).toBe(1);
    expect(SRC.split('= mismatchNote({').length - 1).toBeGreaterThanOrEqual(3);
  });

  test('the note is folded into the error the alert shows', () => {
    expect(SRC).toMatch(/out\.error = `\$\{out\.error\} — BUT \$\{note\}`/);
  });

  test('and kept as its own field for anything reading the row', () => {
    expect(SRC).toMatch(/out\.destinationMismatch = note;/);
  });

  test('liveBuyingPower reports the shorting flag at all', () => {
    expect(SRC).toMatch(/shortingEnabled: \(typeof r\.account\.shortingEnabled/);
  });
});

describe('the cached answer is the whole answer', () => {
  /*
   * THE CACHE HELD ONLY THE BALANCE. A second order in the same twenty seconds
   * — which is every scale-out leg, and every second account on the same bar —
   * would have got a hit with no account number and no shorting flag on it,
   * and the contradiction check would have gone quiet for exactly the orders
   * it exists to watch.
   */
  const fs = require('fs');
  const SRC = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'broker', 'signalstack.js'), 'utf8');

  /*
   * THE PROPERTY, NOT THE LINE. The first version of this pinned the exact
   * return statement and broke the moment `readAt` was added beside `cached` —
   * a test failing on a change that was not a regression teaches the next
   * person to edit the test rather than read it. What matters is that the
   * cached path hands back the WHOLE answer, not the balance alone.
   */
  test('the cache stores the answer, not just the number', () => {
    expect(SRC).toMatch(/POWER_CACHE\.set\(id, \{ at: now, answer \}\)/);
    expect(SRC).toMatch(/\.\.\.hit\.answer/);
  });
});
