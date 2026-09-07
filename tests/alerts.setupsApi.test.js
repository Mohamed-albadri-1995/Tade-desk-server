/*
 * THE WINDOW REACHES THE PAGE.
 *
 * A setup whose qp strategy has window_start != window_end fires on ANY bar
 * between the two, and the scheduler has always evaluated it that way
 * (catalog.withinWindow). The page has always had the markup to say so:
 *
 *     s.watch ? `${s.decisionTime}–${s.windowEnd} ET` : `${s.decisionTime} ET`
 *
 * Both /api/setups payloads sent NEITHER field. So `s.watch` was undefined on
 * every setup, every one rendered as a one-minute clock setup, and a trader
 * asking "does Test run all day or once at 09:30" was shown "09:30 ET"
 * whatever the answer was. The only place the truth existed was the qp
 * strategy. A window the desk refuses to print cannot be checked.
 */
const fs = require('fs');
const path = require('path');

describe('a setup carries its whole window to the page', () => {
  const src = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');

  for (const file of [['src', 'alerts', 'server.js'], ['src', 'routes', 'setups.js']]) {
    test(`${file.join('/')} sends windowEnd and watch`, () => {
      const c = src(...file);
      expect(c).toContain('windowEnd: s.windowEnd || s.decisionTime');
      expect(c).toContain('watch: !!s.watch');
      // The BARS evaluated, which is the window shifted by the fill model.
      // "fires at 09:35" and "decided on the 09:34 bar" is the distinction
      // this desk has been bitten by more than once.
      expect(c).toContain('decidesOnBar: s.decidesOnBar || null');
      expect(c).toContain('decidesUntilBar: s.decidesUntilBar || null');
    });
  }

  test('the page reads exactly those names', () => {
    const p = src('public', 'alerts.html');
    expect(p).toContain('s.watch');
    expect(p).toContain('s.windowEnd');
  });
});
