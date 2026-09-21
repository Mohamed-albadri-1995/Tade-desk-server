/*
 * THE SETUPS TAB WAS RANDOM, AND MOST OF IT WAS THE SAME WORDS AGAIN.
 *
 * Reported as: "Check setup tab it's still random and has too much useless
 * text."
 *
 * Both halves were true and they were four separate things:
 *
 *   RANDOM. The list of strategies not yet assigned to a screener came out in
 *   whatever order qp's database returned them — 10:00, 09:30, 10:00, 09:30,
 *   10:00, 09:59, 10:00, 09:40 — directly beneath a list that IS ordered by
 *   decision time. Eight rows you have to read all of to find anything.
 *
 *   THE SAME SENTENCE TWICE. A two-leg exit warned "leg 1 stop follows an
 *   indicator — it goes out as a fixed level and will not trail" and then said
 *   it again for leg 2. One fact, two lines, and only two lines are shown
 *   before the rest folds — so a second, different warning was pushed out of
 *   sight by a duplicate of the first.
 *
 *   SIXTY WORDS ABOUT THE FEED, on every card, saying the same thing every
 *   time, under a heading four characters long.
 *
 *   THE SAME CAUTION ON EVERY CARD. "Backtest it in qp before trusting it
 *   live" is true and worth saying once. Printed per card it is the same words
 *   twice on one screen, and the reader stops seeing it — the one outcome a
 *   caution must not have.
 *
 * And the thing that was actually longest: ELEVEN TOOL CHIPS, twice per setup
 * card and once per unassigned row — eighty-eight of them on one screen, six
 * of which name screeners that have stopped collecting.
 */

const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'alerts.html'), 'utf8');
const script = (html.match(/<script>([\s\S]*?)<\/script>/) || [])[1] || '';

/** Lift one named function out of the page and make it callable. */
function fn(name, extra = '') {
  const from = script.indexOf(`function ${name}(`);
  if (from < 0) {
    throw new Error(`public/alerts.html no longer defines ${name}() — the `
      + 'setups tab is where a strategy is switched on');
  }
  // eslint-disable-next-line no-new-func
  return new Function(`${extra}${script.slice(from, script.indexOf('\n}', from) + 2)}
    ; return ${name};`)();
}

/*
 * ── THE ORDER ────────────────────────────────────────────────────────────
 */
describe('the unassigned strategies are in time order', () => {
  test('the sort is on the decision time, then the name', () => {
    const at = script.indexOf('const waiting = [...groups.values()]');
    expect({ found: at >= 0 }).toEqual({ found: true });
    const sort = script.slice(at, script.indexOf(';', at));
    // Sorted at all — it was `[...groups.values()].filter(...)` and nothing else.
    expect(sort).toContain('.sort(');
    expect(sort).toContain("String(a.at || '').localeCompare(String(b.at || ''))");
    expect(sort).toContain("String(a.base || '').localeCompare(String(b.base || ''))");
  });

  test('and one with no entry window sorts last, not first', () => {
    /*
     * An empty string sorts BEFORE every time, so the strategies that cannot
     * be assigned at all — no entry window, so no decision time — would take
     * the top of a list ordered by when things run. They are not candidates
     * for "what runs next"; they are candidates for "fix this in qp".
     */
    const at = script.indexOf('const waiting = [...groups.values()]');
    expect(script.slice(at, script.indexOf(';', at)))
      .toContain('(Number(!a.at) - Number(!b.at))');
  });

  test('the real list, run through the real comparator', () => {
    // The eight from the report, in the order they arrived.
    const rows = [['T2 10:00 VWAP Extension', '10:00'], ['PM Breakout (2m)', '09:30'],
      ['Fashionably Late Scalp', '10:00'], ['HitchHiker Scalp', '09:30'],
      ['Back$ide Scalp', '10:00'], ['Second Chance Scalp', '09:59'],
      ['RubberBand Scalp', '10:00'], ['PML breakout', '09:40'],
      ['No window yet', null]].map(([base, at]) => ({ base, at }));
    const at = script.indexOf('const waiting = [...groups.values()]');
    const body = script.slice(at, script.indexOf(';', at));
    const cmp = body.slice(body.indexOf('.sort(') + 6, body.lastIndexOf(')'));
    // eslint-disable-next-line no-new-func
    const sorted = rows.slice().sort(new Function(`return ${cmp}`)());
    expect(sorted.map(r => r.base)).toEqual([
      'HitchHiker Scalp',          // 09:30
      'PM Breakout (2m)',          // 09:30
      'PML breakout',              // 09:40
      'Second Chance Scalp',       // 09:59
      'Back$ide Scalp',            // 10:00
      'Fashionably Late Scalp',    // 10:00
      'RubberBand Scalp',          // 10:00
      'T2 10:00 VWAP Extension',   // 10:00
      'No window yet',             // nothing to sort by — last
    ]);
  });
});

/*
 * ── THE PICKER ───────────────────────────────────────────────────────────
 */
describe('a setup is only offered the screeners that are running', () => {
  const choices = (mine, all, on) => fn('toolChoices',
    `let TOOL_IDS = ${JSON.stringify(all)}; let TOOLS_ON = ${JSON.stringify(on)};`)(mine);

  const ALL = ['T1', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'T8', 'T9', 'T10', 'T11'];
  const ON = ['T1', 'T2', 'T6', 'T7', 'T11'];

  test('a stopped screener is not offered', () => {
    /*
     * `enabled: false` means the tool has stopped SCANNING. A setup assigned
     * to one ranks an empty card list every morning and reports "no cards" —
     * which is the same words a running tool says on a quiet day. Offering it
     * is offering to assign a strategy to nothing.
     */
    expect(choices([], ALL, ON)).toEqual(ON);
    for (const dead of ['T3', 'T4', 'T5', 'T8', 'T9', 'T10']) {
      expect({ dead, offered: choices([], ALL, ON).includes(dead) })
        .toEqual({ dead, offered: false });
    }
  });

  test('but one this setup already names is kept, however dead', () => {
    // A setup pointing at a sleeping tool is a fact ABOUT that setup. Hiding
    // the chip would make it invisible and unassignable at the same time.
    expect(choices(['T10'], ALL, ON)).toEqual(['T1', 'T2', 'T6', 'T7', 'T10', 'T11']);
  });

  test('and the registry order is kept, not the order of the two lists', () => {
    expect(choices(['T10', 'T1'], ALL, ON)).toEqual(['T1', 'T2', 'T6', 'T7', 'T10', 'T11']);
  });

  test('a registry that could not be read offers everything, not nothing', () => {
    /*
     * AN ERROR IS NEVER A ZERO. With no enabled-list the honest answer is "I
     * do not know which are running", and an empty picker is a tab on which no
     * setup can be assigned at all.
     */
    expect(choices([], ALL, [])).toEqual(ALL);
  });

  test('the setup card and the unassigned row both use it', () => {
    expect(script).toContain('toolChoices(s.tools || [])');
    expect(script).toContain('toolChoices().map(t =>');
    // And neither draws the raw list any more.
    expect(script).not.toContain('TOOL_IDS.map(t =>');
    expect(script).not.toContain('${TOOL_IDS.map(t => `<span');
  });

  test('the enabled flag is read where the registry is read', () => {
    const at = script.indexOf('async function ensureTools()');
    const body = script.slice(at, script.indexOf('\n}', at));
    expect(body).toContain("x.enabled !== false");
    // Both lists come from ONE fetch: two would be two answers that can
    // disagree about which tools exist.
    expect((body.match(/await fetch\(/g) || []).length).toBe(1);
  });

  test('the unassigned picker is folded, not eight copies of it open', () => {
    const at = script.indexOf("out.innerHTML = `<div class=\"unassigned\">");
    const block = script.slice(at, script.indexOf('</div>`;', at));
    expect(block).toContain('<details class="why ua-pick">');
    expect(block).toContain('<summary>assign to a screener</summary>');
  });

  test('and that fold does not wear the mark that means "explanation"', () => {
    // details.why draws a "?" before its summary. This one is an action.
    expect(html).toContain('.ua-pick > summary::before { content:none; }');
  });
});

/*
 * ── THE REPEATED TEXT ────────────────────────────────────────────────────
 */
describe('the caution belongs to the group, not to every card', () => {
  const cautionFor = () => fn('cautionFor');
  const C = 'Backtest it in qp before trusting it live.';

  test('one caution shared by every unfinished setup is hoisted', () => {
    expect(cautionFor()([{ stage: 'dev', caution: C }, { stage: 'dev', caution: C }]))
      .toBe(C);
  });

  test('two different cautions are NOT hoisted — that is two facts', () => {
    expect(cautionFor()([{ stage: 'dev', caution: C },
                         { stage: 'dev', caution: 'Something else entirely' }])).toBeNull();
  });

  test('a finished setup never contributes one', () => {
    expect(cautionFor()([{ stage: 'ready', caution: C }])).toBeNull();
    expect(cautionFor()([])).toBeNull();
    expect(cautionFor()(null)).toBeNull();
  });

  test('the card no longer prints it', () => {
    const at = script.indexOf('<div class="setup-def');
    const card = script.slice(at, script.indexOf('paintAlgoState();', at));
    expect(card).not.toContain('class="su-caution">${esc(s.caution)}');
    // It is under the group heading instead, and only for the dev group.
    expect(script).toContain("stage === 'dev' && cautionFor(ordered)");
  });
});

/*
 * ── WHICH LABEL IS WHICH ─────────────────────────────────────────────────
 */
test('the two labels on a card do not both begin with the same word', () => {
  /*
   * "runs in" was the broker account and "runs on" was the screener, four
   * lines apart. The only way to tell them apart was to read the values —
   * which is the opposite of what a label is for.
   */
  expect(html).toContain('<span class="ua-label">orders to</span>');
  expect(html).toContain('<span class="ua-label">cards from</span>');
  expect(html).not.toContain('<span class="ua-label">runs in</span>');
  expect(html).not.toContain('<span class="ua-label">runs on</span>');
});

test('the time tag cannot wrap away from the name it belongs to', () => {
  // "HitchHiker Scalp 09:30" broke after the name and left "ET" alone on the
  // next line — on the one row where the time is what you are sorting by.
  expect(html).toContain('.ua-name .su-tag { white-space:nowrap; }');
});
