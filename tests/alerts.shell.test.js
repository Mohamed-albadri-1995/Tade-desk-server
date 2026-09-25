/*
 * THE SECTIONS AS A PLACE, NOT A CONTROL.
 *
 * A tab row is something you read when you want to move. A rail down the left
 * is on screen the whole time, so "which part of the desk am I looking at" is
 * answered without asking. On a 1400px screen the tab row was six words on an
 * otherwise empty line with four hundred pixels of margin either side.
 *
 * THE HAZARD IS HAVING TWO OF THEM. The reference design this was built from
 * had a sidebar AND a tab row showing the same six names — two controls that
 * can disagree about where you are. Here they are the SAME control: same `.tb`
 * class, same `data-t`, same click handler, same remembered tab, and exactly
 * one of them is ever visible.
 *
 * That arrangement has three failure modes and all three are cheap to check
 * and invisible to a reader:
 *
 *   THE TWO LISTS DRIFT. Someone adds a tab to the row and not the rail, and
 *   on a wide screen the section simply does not exist.
 *
 *   A BADGE LANDS ON THE HIDDEN ONE. `querySelector` takes the first match;
 *   with two navigations in the DOM that is whichever comes first in the
 *   markup, not whichever is on screen.
 *
 *   THE HIDE RULE LOSES. `display:none` in a media query is beaten by a plain
 *   `display:flex` further down the same stylesheet. This happened: the row
 *   went on showing at 1400px, beside the rail, looking exactly as intended to
 *   anyone reading the source.
 */

const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'alerts.html'), 'utf8');
const script = (html.match(/<script>([\s\S]*?)<\/script>/) || [])[1] || '';

/** The `data-t` values of the buttons inside one container, in order. */
function sectionsIn(openTag, closeTag) {
  const from = html.indexOf(openTag);
  expect({ openTag, found: from >= 0 }).toEqual({ openTag, found: true });
  const to = html.indexOf(closeTag, from);
  return [...html.slice(from, to).matchAll(/<button class="tb[^"]*" data-t="([a-z]+)"/g)]
    .map(m => m[1]);
}

const RAIL = () => sectionsIn('<aside class="al-side"', '</aside>');
const ROW = () => sectionsIn('<div class="tabs" id="tabs">', '</div>');

describe('one navigation, in two shapes', () => {
  test('the rail and the row list the same sections, in the same order', () => {
    /*
     * The drift this catches is silent in both directions: a section only in
     * the row does not exist on a desktop, and one only in the rail does not
     * exist on a phone — and whichever screen you use daily is the one where
     * you will never notice.
     */
    expect(RAIL()).toEqual(ROW());
  });

  test('and they are the five, Live first', () => {
    /*
     * Six, until History and Log were merged. They were two halves of one
     * question — the log says "575 evaluated, 0 signalled", the history says
     * "here are the 0" — read at the same moment, for the same day, from two
     * separate date pickers that could disagree about which day that was.
     * Split by TIME now: Live is the monitor, Day is the record.
     */
    // Health added 09-24: what took Termux and pm2 to answer.
    expect(RAIL()).toEqual(['today', 'history', 'check', 'setups', 'health', 'settings']);
  });

  test('both are the same control — one class, one handler, one memory', () => {
    // Not a second implementation: showTab, the click wiring and the stored
    // tab all address `.tb`, so the rail gets them by being `.tb` too.
    expect(script).toContain("document.querySelectorAll('.tb').forEach(b =>");
    expect(script).toContain("document.querySelectorAll('.tb').forEach(b => {");
    expect(script).toContain("localStorage.setItem('alertsTab', want)");
    // One <aside>, one .tabs — not two rails or two rows.
    expect((html.match(/<aside class="al-side"/g) || []).length).toBe(1);
    expect((html.match(/<div class="tabs" id="tabs">/g) || []).length).toBe(1);
  });

  test('a badge is painted on EVERY copy, not the first one', () => {
    /*
     * `querySelector` returns whichever comes first in the markup. The rail is
     * written first, so on a phone the count was being painted onto a hidden
     * rail and the row you were looking at said nothing had fired.
     */
    const fn = script.slice(script.indexOf('function tabBadge('),
                            script.indexOf('\n}', script.indexOf('function tabBadge(')));
    expect(fn).toContain('querySelectorAll');
    expect(fn).not.toMatch(/querySelector\(`/);
  });
});

describe('exactly one of them is on screen', () => {
  const css = html.slice(html.indexOf('<style>'), html.indexOf('</style>'));

  test('the rail is hidden on a phone and the row is hidden on a desktop', () => {
    expect(css).toMatch(/@media \(max-width:980px\)[\s\S]{0,200}\.al-side \{ display:none/);
    expect(css).toContain('@media (min-width:981px) { .tabs { display:none } }');
  });

  test('the hide rule comes AFTER the rule it has to beat', () => {
    /*
     * THE BUG, PINNED. Written up beside .al-shell — where it belongs by
     * topic — the media query sat hundreds of lines before `.tabs {
     * display:flex }` and lost to it on source order alone. Same specificity,
     * later wins. The row went on showing at 1400px.
     */
    const flex = css.indexOf('.tabs { position:sticky');
    const hide = css.indexOf('@media (min-width:981px) { .tabs { display:none } }');
    expect({ flex: flex >= 0, hide: hide >= 0 }).toEqual({ flex: true, hide: true });
    expect({ order: hide > flex, flex, hide }).toEqual({ order: true, flex, hide });
  });

  test('the breakpoints meet with no gap and no overlap', () => {
    // 980 and 981: one pixel apart, so there is no width at which both show
    // and none at which neither does.
    const max = /@media \(max-width:(\d+)px\)[\s\S]{0,200}\.al-side \{ display:none/.exec(css);
    const min = /@media \(min-width:(\d+)px\) \{ \.tabs \{ display:none \} \}/.exec(css);
    expect(Number(min[1])).toBe(Number(max[1]) + 1);
  });
});

/*
 * THE PANES ARE UNTOUCHED.
 *
 * The shell wraps them; it does not move them between sections. Every pane
 * that existed still exists, under the same data-t, so the loaders and the
 * ids they write into are exactly where they were.
 */
test('every section still has a pane to show', () => {
  const panes = new Set([...html.matchAll(/<div class="pane" data-t="([a-z]+)"/g)]
    .map(m => m[1]));
  for (const s of RAIL()) expect({ section: s, pane: panes.has(s) })
    .toEqual({ section: s, pane: true });
});

test('the shell opens and closes around them, and nothing else', () => {
  // An unbalanced wrapper here would swallow the panes into the rail, which
  // renders as a page that is simply blank below the strip.
  expect((html.match(/<div class="al-shell">/g) || []).length).toBe(1);
  expect((html.match(/<div class="al-main">/g) || []).length).toBe(1);
  expect(html).toContain('</div><!-- /al-main -->');
  expect(html).toContain('</div><!-- /al-shell -->');
  // The strip is INSIDE the main column — beside the rail, not above it.
  expect(html.indexOf('<div class="al-main">'))
    .toBeLessThan(html.indexOf('<div class="strip" id="deskstrip"'));
});

/*
 * THE NOISE CONTROLS ARE A ROW, NOT A BOX.
 *
 * Two settings you touch once a month, in a bordered panel with two large
 * buttons, directly above the morning's alerts on the tab you open at 09:35.
 * The state still says itself out loud — an alerting page whose sound is off
 * without saying so is worse than one with no sound — it just stops being the
 * biggest thing on the screen.
 */
test('the sound and notification controls still say their state', () => {
  expect(html).toContain('id="snd"');
  expect(html).toContain('id="ntf"');
  expect(html).toContain('id="ntf-test"');
  const rule = html.slice(html.indexOf('.noise {'), html.indexOf('}', html.indexOf('.noise {')));
  // No panel: it is a row of controls, not a thing with a border and a fill.
  expect(rule).not.toContain('border:1px solid');
  expect(rule).not.toContain('background:var(--panel)');
});
