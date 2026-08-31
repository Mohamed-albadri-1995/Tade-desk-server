/*
 * One alert per name, per setup, per session.
 *
 * WHAT HAPPENED ON 2026-08-19. The end-of-day report said:
 *
 *     ⚠ THE SAME NAME ALERTED MORE THAN ONCE — the once-a-day latch did not
 *       hold:  2×  OR + VWAP 09:35@09:35  WULF
 *     ⚠ WULF  alerts 2  entries 1 in 1 account(s)  orders 2  (2/entry)
 *
 * One entry, two alerts. The ORDER guard held — `sentAlready` reads the ledger
 * and refused the second, so it cost nothing — and the alert went out twice
 * anyway: a phone buzz for a trade that did not happen, on a feed whose entire
 * value is that every line on it is real.
 *
 * THE CAUSE was a guard reading `setup.watch && !dryRun`, on the reasoning
 * written in the code that "a clock setup runs once, so it cannot repeat
 * itself". That is an assumption about a scheduler, not a property of the
 * world. OR + VWAP 09:35 is a clock setup, so the latch was skipped entirely —
 * and a clock setup CAN run twice: a process restarting inside its window, a
 * scheduler firing on both edges of a minute, a deploy at 09:35.
 *
 * The latch now applies to every setup, which also makes it agree with the
 * order guard: one entry per setup per name per day is already the rule money
 * follows, and the alert must not describe a different desk.
 */

const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'setups', 'runner.js'), 'utf8');

describe('the once-a-day latch', () => {
  /* The fix itself: no longer conditional on the kind of setup. */
  test('applies to every setup, not only watch setups', () => {
    expect(SRC).not.toMatch(/if \(setup\.watch && !dryRun\) \{/);
    // The guard on the latch block is the dry-run one and nothing else. Matched
    // loosely across the declarations between, so adding one there does not
    // read as the kind-of-setup condition coming back.
    expect(SRC).toMatch(/const alreadyToday = new Set\(\);\n(?:\s*(?:let|const)[^\n]*\n)*\s*if \(!dryRun\) \{/);
  });

  /*
   * A DRY RUN STILL SEES EVERYTHING. It places nothing, so it cannot repeat
   * anything — and latching it would hide the very picks somebody ran it to
   * look at.
   */
  test('a dry run is still exempt', () => {
    expect(SRC).toMatch(/if \(!dryRun\) \{/);
  });

  /* It reads the alert feed, which is the record that survives a restart. */
  test('it reads what already fired today, keyed by setup and ticker', () => {
    expect(SRC).toMatch(/alertStore\.recentFires\(day, 500\)/);
    expect(SRC).toMatch(/if \(f\.ruleId === setup\.id && f\.ticker\)/);
  });

  /* Dropped BEFORE sizing or sending, or the guard would only be cosmetic. */
  test('the name is dropped before anything is sized or sent', () => {
    const latch = SRC.indexOf('out.picks = out.picks.filter(p => !alreadyToday');
    expect(latch).toBeGreaterThan(-1);
    expect(latch).toBeLessThan(SRC.indexOf('await broker.placeOrder'));
  });

  /*
   * The reasoning that was wrong is kept, with what disproved it — the next
   * person to read "a clock setup cannot repeat itself" should see the date it
   * did.
   */
  test('the corrected assumption is written down, with its evidence', () => {
    expect(SRC).toMatch(/assumption about a scheduler, not a property of the/);
    expect(SRC).toMatch(/2026-08-19/);
  });
});
