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
const canslim = read('canslim.html');
const compare = read('compare.html');
const server = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.js'), 'utf8');

/*
 * Ids the landing page must never render again.
 *
 * `cs-out` and `cmp-out` are NOT here: CANSLIM and the comparison have since
 * moved on again, off the suite page and onto their own, so a test asserting
 * they live on /screeners would now be asserting the arrangement before last.
 * What is checked is that they are not on the LANDING page, which is the
 * separation this file exists for.
 */
const NOT_ON_LANDING = ['id="cards"', 'id="uni-out"', 'id="cs-out"', 'id="cmp-out"',
                        'id="now-bar"', 'class="tool-card', 'cmp-btn'];
/** …and the subset the suite page itself still owns. */
const SUITE_OWNS = ['id="cards"', 'id="uni-out"', 'id="now-bar"', 'class="tool-card'];

describe('the landing page', () => {
  test('has the app grid and nothing from the suite', () => {
    expect(home).toContain('id="apps"');
    for (const marker of NOT_ON_LANDING) expect({ marker, on: home.includes(marker) })
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
  test('has everything that left the landing page and stayed here', () => {
    for (const marker of SUITE_OWNS) expect({ marker, on: suite.includes(marker) })
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
  test('the palette is linked, not copied', () => {
    // Four pages with four private copies of one palette is exactly how they
    // came apart the first time.
    expect(suite).toContain('href="/desk.css"');
    expect(suite).not.toContain(':root {');
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
    // Two left with CANSLIM and the comparison; the shortlist keeps its own.
    const opens = [...suite.matchAll(/<details class="why"/g)].length;
    expect(opens).toBeGreaterThanOrEqual(2);
    for (const page of [suite, canslim, compare]) {
      expect(page).not.toMatch(/<details class="why" open/);
    }
  });

  test('the type face is the screener\'s, from the shared sheet', () => {
    // The screener is monospace throughout and it is the page that reads best
    // on this phone. What was wrong was never the face — it was four of them.
    const desk = read('desk.css');
    expect(desk).toMatch(/--ui:'SF Mono'/);
    expect(desk).toMatch(/body \{[^}]*font-family:var\(--ui\)/);
  });
});

/*
 * THE SUITE PAGE, ORDERED BY URGENCY.
 *
 * Shortlist, CANSLIM and the comparison were three strips at the bottom of the
 * page, under the nine tool cards, in the order they happened to be written.
 * They answer questions of completely different urgency: the shortlist is what
 * to look at this morning and changes hourly; CANSLIM turns over on the
 * earnings calendar; the comparison is a month-end question. Putting them in
 * one scroll made the daily one the hardest to reach.
 *
 *   /screeners            the shortlist, then two doors, then the nine tools
 *   /screeners/canslim    a card per member
 *   /screeners/compare    the table, with room for it
 */

describe('the suite page puts today first', () => {
  test('the shortlist comes before the nine tool cards', () => {
    expect(suite.indexOf('id="uni-wrap"')).toBeLessThan(suite.indexOf('id="cards"'));
  });

  test('CANSLIM and the comparison are doors, not panels', () => {
    expect(suite).toContain('href="/screeners/canslim"');
    expect(suite).toContain('href="/screeners/compare"');
    // …and their content is not also rendered here
    expect(suite).not.toContain('id="cmp-out"');
    expect(suite).not.toContain('function loadComparison(');
  });

  test('the CANSLIM door still carries its count', () => {
    // The number is the reason to open it, so it has to be legible while shut.
    expect(suite).toContain('id="cs-count"');
    expect(suite).toContain('function loadCanslim(');
  });

  test('a shortlist name is a row, not a pill', () => {
    /*
     * It was a 30px chip with the ticker, a count and three tool ids pressed
     * together — the same information made hard to read and impossible to hit
     * accurately. The ticker is the biggest thing on the row now, and the
     * tools that picked it are their own links underneath.
     */
    expect(suite).toContain('class="sl-row');
    expect(suite).toContain('class="sl-tkr"');
    const at = suite.indexOf('.sl-tkr {');
    expect(suite.slice(at, suite.indexOf('}', at))).toContain('var(--f-lg)');
    // Agreement between tools is marked, since it is why nine lists are merged.
    expect(suite).toContain('tools agree');
    expect(suite).toContain('.sl-row.agreed');
  });
});

describe('the CANSLIM page', () => {
  test('is reachable and comes back', () => {
    expect(server).toContain("app.get('/screeners/canslim'");
    expect(canslim).toMatch(/class="crumb" href="\/screeners"/);
  });

  test('gives each member a card, not a chip', () => {
    // held and expiring were a tooltip, which on a phone is invisible — and
    // they are the two numbers that decide anything.
    expect(canslim).toContain('class="cs-card');
    expect(canslim).toContain('until it drops off');
    expect(canslim).toContain('>held<');
    const at = canslim.indexOf('.cs-v {');
    expect(canslim.slice(at, canslim.indexOf('}', at))).toContain('var(--f-xl)');
  });

  test('marks the ones about to drop off, and nothing else', () => {
    // When a name expires its badge turns off on every tool at once, and a
    // change nobody was warned about reads as a bug.
    expect(canslim).toContain('.cs-card.soon');
    expect(canslim).toContain('expiresIn <= 14');
  });

  test('links the shared sheet rather than carrying a third palette', () => {
    expect(canslim).toContain('href="/desk.css"');
    expect(canslim).not.toContain(':root {');
    // …and gets the sunlight toggle every other page has.
    expect(canslim).toContain('id="sun-btn"');
  });
});

describe('the comparison page', () => {
  test('is reachable and comes back', () => {
    expect(server).toContain("app.get('/screeners/compare'");
    expect(compare).toMatch(/class="crumb" href="\/screeners"/);
  });

  test('holds the only copy of the comparison code', () => {
    // Two implementations of one table is how they come to disagree.
    expect(compare).toContain('function loadComparison(');
    expect(compare).toContain('function renderPairs(');
    expect(suite).not.toContain('function renderPairs(');
  });

  test('runs on arrival — the page exists for one answer', () => {
    expect(compare).toContain('TOOLS_READY.then(loadComparison)');
  });
});
