/*
 * THREE LEVELS, NOT ONE SCROLL.
 *
 * The landing page used to be five things at once: the app list, the nine
 * screener cards, the shared shortlist, the CANSLIM list and a comparison
 * table. The first question of a trading morning is "which program", and
 * everything below the answer was competing with it.
 *
 *   /             which program
 *   /screeners    which of the nine, and the lists all of them read
 *   a tool        the screener itself
 *
 * These check the SEPARATION, which is the part that rots: someone adds one
 * useful widget to the landing page, then another, and it is one scroll again.
 */

const fs = require('fs');
const path = require('path');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', 'public', f), 'utf8');
const home = read('home.html');
const suite = read('screeners.html');
const server = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.js'), 'utf8');

/** Ids only the screener dashboard has any business rendering. */
const SUITE_ONLY = ['id="cards"', 'id="uni-out"', 'id="cs-out"', 'id="cmp-out"',
                    'id="now-bar"', 'class="tool-card', 'cmp-btn'];

describe('the landing page', () => {
  test('has the app grid and nothing from the suite', () => {
    expect(home).toContain('id="apps"');
    for (const marker of SUITE_ONLY) expect({ marker, on: home.includes(marker) })
      .toEqual({ marker, on: false });
  });

  test('is small enough to be one screen of decisions', () => {
    // Not a style rule — a proxy for "did the dashboard come back". The whole
    // page was 60KB; four doors do not need that.
    expect(home.length).toBeLessThan(12000);
  });

  test('every door is a link, including the screener suite', () => {
    /*
     * The suite card used to be an inert "you are here" marker, because this
     * page WAS the suite. Now it is a door to level 2, and an inert card there
     * would be a dead end where the main path should be.
     */
    expect(home).toContain('<a class="app-card"');
    expect(home).not.toContain('is-self');
    expect(home).toContain("a.suitePath || '/screeners'");
  });

  test('it still renders when the app list cannot be read', () => {
    // A landing page with no doors and no explanation is the worst outcome.
    expect(home).toContain('Could not read the app list');
  });
});

describe('the screener suite page', () => {
  test('has everything that left the landing page', () => {
    for (const marker of SUITE_ONLY) expect({ marker, on: suite.includes(marker) })
      .toEqual({ marker, on: true });
  });

  test('does not keep a second copy of the app grid', () => {
    // One choice on two screens is the shape of every duplication in this repo.
    expect(suite).not.toContain('id="apps"');
    expect(suite).not.toContain('function appCard(');
  });

  test('has a way back that does not rely on the browser', () => {
    // On a phone, the back button is not where a person looks for it.
    expect(suite).toMatch(/class="crumb" href="\/"/);
  });

  test('is a complete document — the split did not eat the stylesheet', () => {
    /*
     * It did, once. An edit anchored on "/* The applications." matched the CSS
     * comment of the same name near the top of the file and deleted everything
     * from there to the script, stylesheet and body included. The page still
     * served, with 200 and no styles.
     */
    for (const tag of ['<style>', '</style>', '</body>', '</html>']) {
      expect({ tag, on: suite.includes(tag) }).toEqual({ tag, on: true });
    }
  });
});

test('the server serves all three levels', () => {
  expect(server).toContain("app.get('/screeners'");
  expect(server).toContain('screeners.html');
  expect(server).toContain('home.html');
  expect(server).toContain("app.get('/scanner'");
});

/*
 * THE THREE SHARED PANELS, after the design pass.
 *
 * Shortlist, CANSLIM and the comparison were three centred blocks of prose
 * running into each other with no edges — and the explanation was set larger
 * than the data it explained. Four lines of centred text about the shortlist,
 * above a shortlist rendered in 13px chips. The prose is not the product.
 */
describe('the shared lists read like data', () => {
  test('the same tokens as the alerts page, not a second palette', () => {
    const vars = suite.slice(suite.indexOf(':root'), suite.indexOf('* { box-sizing'));
    for (const v of ['--panel:', '--panel2:', '--line2:', '--f-xs', '--f-lg',
                     '--s3', '--mono', '--ui']) {
      expect({ token: v, defined: vars.includes(v) }).toEqual({ token: v, defined: true });
    }
  });

  test('prose is left-aligned and capped at a readable measure', () => {
    // A centred paragraph is read by hunting for the start of each line in a
    // different place every time. Headings may centre; prose does not.
    const at = suite.indexOf('.cmp-hint {');
    const rule = suite.slice(at, suite.indexOf('}', at));
    expect(rule).toContain('text-align:left');
    expect(rule).toMatch(/max-width:\d+ch/);
    // …and the panel that holds it no longer centres everything inside it.
    const at2 = suite.indexOf('.cmp-wrap {');
    expect(suite.slice(at2, suite.indexOf('}', at2))).toContain('text-align:left');
  });

  test('each panel has an edge of its own', () => {
    const at = suite.indexOf('.cmp-wrap {');
    const rule = suite.slice(at, suite.indexOf('}', at));
    expect(rule).toContain('background:var(--panel)');
    expect(rule).toContain('border:1px solid var(--line)');
    expect(rule).toContain('border-radius');
  });

  test('the list comes before the paragraph about the list', () => {
    // Heading, then the names, then the reasoning — not heading, four lines of
    // prose, and only then the thing you came for.
    const panel = suite.slice(suite.indexOf('id="uni-wrap"'), suite.indexOf('id="cs-wrap"'));
    expect(panel.indexOf('id="uni-out"')).toBeLessThan(panel.indexOf('details class="why"'));
  });

  test('a ticker is bigger than the sentence describing tickers', () => {
    const at = suite.indexOf('.uni-tkr {');
    expect(suite.slice(at, suite.indexOf('}', at))).toContain('font-size:var(--f-md)');
    const at2 = suite.indexOf('.cmp-hint {');
    expect(suite.slice(at2, suite.indexOf('}', at2))).toContain('font-size:var(--f-xs)');
  });

  test('every explanation folds, and none starts open', () => {
    const opens = [...suite.matchAll(/<details class="why"/g)].length;
    expect(opens).toBeGreaterThanOrEqual(4);
    expect(suite).not.toMatch(/<details class="why" open/);
  });

  test('tickers stay monospace while sentences do not', () => {
    expect(suite).toMatch(/\.uni-tkr[^{]*\{[^}]*font-family:var\(--mono\)|font-family:var\(--mono\);/);
    expect(suite).toMatch(/body\s*\{[\s\S]{0,400}font-family:var\(--ui\)/);
  });
});
