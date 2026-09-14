/*
 * SLIP IN R, BECAUSE PERCENT OF PRICE EXPLAINS NOTHING.
 *
 * PL, 2026-09-08. Decided on the 09:34 close at 17.75 with the stop at 17.935,
 * so one R is 18.5 cents. The setup run took 19.4 seconds and the market order
 * filled at 17.515.
 *
 *     in dollars   0.235 worse
 *     in percent   1.32%   — reads as nothing, and this is what was reported
 *     in R         1.27R   — the trade began more than a whole R behind
 *
 * And the slip re-prices everything after it. The bracket was built from 17.75,
 * so the 2R target went out at 17.38. From the price actually paid, 17.38 is
 * 0.32R. Half the position was banked at roughly a third of the way to its
 * first target, and the rest carried 2.3x the intended risk because R was
 * really 0.42, not 0.185.
 *
 * That is the distance between +$611 in the backtest and +$69 in the account,
 * and none of it was on a screen.
 */

const broker = require('../src/broker/signalstack');

/** PL as it actually happened. */
const PL = { action: 'sell', price: 17.75, stop: 17.935 };
const plSlip = () => broker.slipOf(PL, { fillPrice: 17.515 });

describe('the day the desk gave away an R before the trade started', () => {
  test('the dollar and percent figures are unchanged', () => {
    const s = plSlip();
    expect(s.slip).toBeCloseTo(0.235, 4);
    expect(s.slipPct).toBeCloseTo(1.3239, 3);
  });

  test('and in R it is 1.27, which is the number that means something', () => {
    expect(plSlip().slipR).toBeCloseTo(1.27, 2);
  });

  /*
   * MEASURED AGAINST THE R THE BRACKET WAS BUILT FROM, not against the risk
   * the position ended up carrying. Dividing by the wider, real distance would
   * shrink the very number that says the risk moved: 0.235 / 0.42 = 0.56R,
   * which understates it by half.
   */
  test('R is the DECISION\'s distance, not the fill\'s', () => {
    const s = plSlip();
    expect(s.plannedR).toBeCloseTo(0.185, 4);
    expect(s.realR).toBeCloseTo(0.42, 4);
    expect(s.slipR).not.toBeCloseTo(0.235 / 0.42, 2);
  });

  test('it says the position now risks 2.3x what was intended', () => {
    const note = broker.slipNote(plSlip());
    expect(note).toMatch(/1\.27R before the trade started/);
    expect(note).toMatch(/risks 0\.42 a share instead of 0\.18/);
    expect(note).toMatch(/2\.3x/);
    // And that the target the broker is holding is not the target that was tested.
    expect(note).toMatch(/what the bracket calls 2R is really 0\.88R/);
  });
});

describe('the sign follows the position, not the number line', () => {
  test('a short filled BELOW the decision is worse', () => {
    expect(broker.slipOf({ action: 'sell', price: 10, stop: 10.5 },
                         { fillPrice: 9.75 }).slipR).toBeCloseTo(0.5, 6);
  });

  test('a short filled ABOVE the decision is better, and reads negative', () => {
    expect(broker.slipOf({ action: 'sell', price: 10, stop: 10.5 },
                         { fillPrice: 10.25 }).slipR).toBeCloseTo(-0.5, 6);
  });

  test('a long filled ABOVE the decision is worse', () => {
    expect(broker.slipOf({ action: 'buy', price: 10, stop: 9.5 },
                         { fillPrice: 10.25 }).slipR).toBeCloseTo(0.5, 6);
  });
});

/* ── what it refuses to say ──────────────────────────────────────────────── */

describe('a slip it cannot measure in R is not a slip of zero', () => {
  test('no stop on the row means no R, and it says null', () => {
    const s = broker.slipOf({ action: 'sell', price: 17.75 }, { fillPrice: 17.515 });
    expect(s.slip).toBeCloseTo(0.235, 4);      // dollars still work
    expect(s.slipR).toBeNull();
    expect(s.plannedR).toBeNull();
    expect(broker.slipNote(s)).toBeNull();
  });

  test('a stop AT the decision price is not a zero-risk trade, it is no answer', () => {
    const s = broker.slipOf({ action: 'sell', price: 17.75, stop: 17.75 },
                            { fillPrice: 17.515 });
    expect(s.slipR).toBeNull();
    expect(Number.isFinite(s.slipR)).toBe(false);
  });

  test('no fill at all reports nothing, in every unit', () => {
    const s = broker.slipOf(PL, { fillPrice: null });
    expect(s).toEqual({ slip: null, slipPct: null, slipR: null });
  });
});

/*
 * AND IT IS QUIET WHEN THE FILL WAS ORDINARY. A note on every order is a note
 * nobody reads by the second week, which is the same way the 04:00 control
 * alarm stopped working.
 */
describe('it only speaks when the trade actually moved', () => {
  test('a tenth of an R is the cost of a market order, and says nothing', () => {
    const s = broker.slipOf({ action: 'buy', price: 50, stop: 49 },
                            { fillPrice: 50.1 });
    expect(s.slipR).toBeCloseTo(0.1, 6);
    expect(broker.slipNote(s)).toBeNull();
  });

  test('a quarter of an R is where it starts speaking', () => {
    const s = broker.slipOf({ action: 'buy', price: 50, stop: 49 },
                            { fillPrice: 50.25 });
    expect(s.slipR).toBeCloseTo(broker.SLIP_R_LOUD, 6);
    expect(broker.slipNote(s)).toMatch(/0\.25R before the trade started/);
  });

  /*
   * A FILL IN YOUR FAVOUR IS WORTH SAYING TOO — it is the same measurement
   * pointing the other way — but it does not get the lecture about risk, which
   * would be wrong: a better entry SHRINKS the risk.
   */
  test('a large fill in your favour is reported without the risk warning', () => {
    const note = broker.slipNote(broker.slipOf({ action: 'buy', price: 50, stop: 49 },
                                               { fillPrice: 49.5 }));
    expect(note).toMatch(/in favour of the decision/);
    expect(note).not.toMatch(/instead of/);
  });
});
