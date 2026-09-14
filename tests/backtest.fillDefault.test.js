/*
 * A BACKTEST MUST BE OF THE REAL SITUATION.
 *
 * The qp backtest page offers three fill models, and one of them is labelled
 * "what you really get". It was not the one selected. Every backtest this desk
 * has ever run — including #353, the one that put real money on PL — used
 * `next_open`.
 *
 * WHAT next_open DOES, and why it is not the desk. It fills at open[j+1] and
 * then MEASURES THE STOP AND EVERY TARGET FROM THAT FILL. The live desk cannot
 * do that and never could: the bracket is priced at the moment of deciding,
 * from close[j], and sent to SignalStack as absolute prices. There is no
 * amending it when the fill comes in somewhere else.
 *
 * So next_open quietly restores the exact R the strategy was designed for,
 * every trade, whatever the fill did. That is not a rounding difference. On
 * 2026-08-19 a WULF short decided at 15.37 filled at 15.24 against a 15.74
 * stop: the plan said 2.00R and the position was 1.31R. On 2026-09-08 PL
 * decided at 17.75 filled at 17.515 against a 17.935 stop — 1.27R gone before
 * the trade began, and the "2R" target the broker was holding was 0.32R from
 * the price actually paid.
 *
 * `desk` is the model that reproduces that: the fill from open[j+1], every
 * LEVEL from close[j]. Two prices doing the two jobs they do live.
 *
 * It is now the default. next_open stays available and says what it does.
 */

const fs = require('fs');
const path = require('path');

const PAGE = fs.readFileSync(
  path.join(__dirname, '..', 'quant-platform', 'chart', 'static', 'index.html'), 'utf8');
const STRATEGY = fs.readFileSync(
  path.join(__dirname, '..', 'quant-platform', 'chart', 'strategy.py'), 'utf8');

/** The <select id="btFill"> element, whole. */
const fillSelect = () => {
  const m = /<select id="btFill">[\s\S]*?<\/select>/.exec(PAGE);
  expect(m).not.toBeNull();
  return m[0];
};

describe('the backtest opens on the model that reproduces the desk', () => {
  test('desk is the selected option', () => {
    const sel = fillSelect();
    expect(sel).toMatch(/<option value="desk"[^>]*\bselected\b/);
  });

  /*
   * AND ONLY ONE OPTION IS SELECTED. Two `selected` attributes is not a draw —
   * the browser takes the last, which would put the default back on next_open
   * while the markup read as though it had been fixed.
   */
  test('and it is the only one', () => {
    expect((fillSelect().match(/\bselected\b/g) || [])).toHaveLength(1);
    expect(fillSelect()).not.toMatch(/<option value="next_open"[^>]*\bselected\b/);
    expect(fillSelect()).not.toMatch(/<option value="close"[^>]*\bselected\b/);
  });

  /*
   * THE SAVED DEFAULT TOO. The page restores the last spec from storage, and a
   * stored `next_open` would beat the markup on every reload — so the fix
   * would appear to work once and then quietly undo itself.
   */
  test('the page\'s own remembered default is desk, not next_open', () => {
    expect(PAGE).toMatch(/btFill:\s*'desk'/);
    expect(PAGE).not.toMatch(/btFill:\s*'next_open'/);
  });

  test('next_open is still offered, and says what it costs you', () => {
    const sel = fillSelect();
    expect(sel).toMatch(/<option value="next_open"/);
    expect(sel).toMatch(/re-prices R from the fill/);
  });
});

/*
 * THE MODEL ITSELF IS UNCHANGED — this is a default, not a new simulation.
 * These pin the property the default is being chosen FOR, so that if anyone
 * ever makes `desk` re-measure levels from the fill, this fails rather than
 * the default silently becoming a second next_open.
 */
describe('what makes desk the honest one', () => {
  test('it is a known model', () => {
    expect(STRATEGY).toMatch(/FILL_MODELS = \('close', 'next_open', 'desk', 'live'\)/);
  });

  test('it takes the fill from the next open and the LEVELS from the decision', () => {
    expect(STRATEGY).toMatch(/dp = close\[j\] if \(desk_fill or live_fill\) else ep/);
    expect(STRATEGY).toMatch(/ep = opn\[j \+ 1\] if next_open else close\[j\]/);
  });

  test('and the reason is written down where the model is', () => {
    expect(STRATEGY).toMatch(/quietly restoring the exact R the strategy was tested at/);
  });
});
