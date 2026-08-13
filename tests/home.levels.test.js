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
