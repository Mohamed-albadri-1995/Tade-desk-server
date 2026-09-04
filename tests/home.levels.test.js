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
const SUITE_OWNS = ['id="cards"', 'id="now-bar"', 'class="tool-card'];

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
 * THE THREE PANELS THAT CAME OFF THIS PAGE.
 *
 * Shortlist, CANSLIM and "Compare screeners" sat under the tool cards. On
 * 2026-09-04 the trader asked for all three gone: the page answers "which
 * screener?", and three panels answering other questions were in the way of it.
 *
 * THE FEATURES ARE NOT DELETED, and that distinction is the whole point of
 * these tests. Starring a card still shortlists it, the union is still
 * published, and both lists still have pages of their own. What went is the
 * front doors — so this checks that the doors are gone AND that the rooms are
 * still standing, because deleting a panel and deleting a feature look
 * identical from the landing page and are not remotely the same thing.
 */
describe('the three panels are off the suite page', () => {
  test('the shortlist panel is gone, markup and code', () => {
    expect(suite).not.toContain('id="uni-wrap"');
    expect(suite).not.toContain('id="uni-out"');
    expect(suite).not.toContain('function loadUnifiedShortlist(');
    expect(suite).not.toContain('copyShortlistForTV');
  });

  test('the CANSLIM and Compare doors are gone', () => {
    expect(suite).not.toContain('href="/screeners/canslim"');
    expect(suite).not.toContain('href="/screeners/compare"');
    expect(suite).not.toContain('function loadCanslim(');
    expect(suite).not.toContain('class="shelf-card"');
  });

  /*
   * DEAD CODE THAT STILL FETCHES IS WORSE THAN DEAD CODE. A loader whose panel
   * no longer exists keeps making requests, keeps failing, and keeps being read
   * in review as if it ran. The CSS is checked too — three hundred lines of
   * rules for elements nothing renders is where the next reader loses an hour.
   */
  test('nothing is left painting a panel that no longer exists', () => {
    for (const dead of ['.sl-row', '.shelf-card', '.cmp-wrap', '.uni-chip', '.cs-summary']) {
      expect({ dead, on: suite.includes(dead) }).toEqual({ dead, on: false });
    }
  });

  test('...but the features themselves are untouched', () => {
    // The endpoints still answer, from any tool.
    expect(server).toContain("app.use('/api/shortlist'");
    expect(server).toContain("app.use('/api/canslim'");
    // Both lists still have their own page, still reachable by URL.
    expect(server).toContain("app.get('/screeners/canslim'");
    expect(server).toContain("app.get('/screeners/compare'");
    expect(compare).toContain('function loadComparison(');
    expect(canslim).toContain('class="cs-card');
  });

  test('the palette is still linked, not copied', () => {
    expect(suite).toContain('href="/desk.css"');
    expect(suite).not.toContain(':root {');
  });
});

/*
 * THE SLEEPING SCANNERS.
 *
 * Five tools are `enabled: false` — stopped, with the read-only archive serving
 * their history on the same ports. Left in the main list they were five
 * permanently red OFFLINE cards among six working ones, because the probe hits
 * /health and the archive does not serve it. A deliberate decision rendered as
 * five faults, in the colour of a fault.
 */
describe('the tools that are switched off have their own section', () => {
  test('there is a section, written from the registry', () => {
    expect(suite).toContain('id="sleeping"');
    expect(suite).toContain('function renderSleeping(');
    expect(suite).toContain('Sleeping scanners');
  });

  /*
   * AWAKE OR ASLEEP IS A FACT ABOUT THE CONFIG, not about whether a port
   * answers. `enabled !== false`, matching the deploy — absent means on, so a
   * registry entry written before the flag existed still renders as a live tool.
   */
  test('the split is on the registry flag, and absent means awake', () => {
    expect(suite).toContain('function isAwake(t) { return t.enabled !== false; }');
    expect(suite).not.toContain('t.enabled === true');
  });

  test('a sleeping tool is NOT probed — the archive has no /health', () => {
    // Five failed requests every thirty seconds, to report a state the registry
    // already stated, and each one paints the card red on the way.
    expect(suite).toMatch(/const live = TOOLS\.filter\(isAwake\)/);
    expect(suite).toMatch(/live\.forEach\(probe\)/);
    expect(suite).not.toMatch(/TOOLS\.forEach\(probe\)/);
  });

  test('and it says "sleeping" rather than "offline"', () => {
    expect(suite).toContain('>sleeping<');
    expect(suite).toContain('.status.asleep');
  });

  /*
   * FOLDED, NOT HIDDEN. A tool that vanished would leave months of frozen days
   * with no visible owner, and "where did T3's gappers go?" would have no
   * answer on the screen that used to hold it.
   */
  test('it is folded away, and says the history is still readable', () => {
    expect(suite).toContain('<details class="sleep-wrap">');
    expect(suite).toContain('still readable in qp');
    expect(suite).toMatch(/t\.archive/);
  });

  test('the section is not drawn at all when every tool is awake', () => {
    // An empty "Sleeping scanners" heading is a section about nothing.
    expect(suite).toMatch(/if \(!asleep\.length\) \{ el\.innerHTML = ''; return; \}/);
  });

  /*
   * THE COUNT IS COUNTED. "Nine of them" was written into the page, and stayed
   * there for a week after there stopped being nine — a sentence that was true
   * once and is now simply wrong, on the first line of the page.
   */
  test('nothing on the page claims a fixed number of screeners', () => {
    expect(suite).not.toMatch(/[Nn]ine of them/);
    expect(suite).not.toContain('The nine screeners');
    expect(suite).toContain("id=\"section-head\"");
    expect(suite).toMatch(/The \$\{ordered\.length\} screeners/);
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
