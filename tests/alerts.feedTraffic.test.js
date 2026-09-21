/*
 * TWENTY LINES CARRYING ONE FACT.
 *
 * The Algo page's feed opened with this, four times in a row, once per name,
 * each one five lines long and every one of them the same five lines:
 *
 *   REHEARSAL — 1 leg(s) did not come back: Cards on the list: the tool has no
 *   cards today, so there is nothing for the setup to rank. Check the tool is
 *   scanning and not paused. Nothing was published or placed; this was a check
 *   of the chain, taken on the current bar.
 *
 * That is not a feed, it is traffic, and the cost is not the pixels. A reader
 * who learns that the top of this page is repetition stops reading the top of
 * this page — and the alert that matters arrives into that habit.
 *
 * Two rules, and both are checked by RUNNING the grouper rather than reading
 * it, because every failure below is a failure of what it returns:
 *
 *   ONE FACT, ONE ROW, and the row names every ticker it stands for. Grouping
 *   that hides a name is not grouping, it is losing an alert.
 *
 *   A TRADE NEVER GROUPS. Two trade cards with identical words are two
 *   different trades — different entry, different stop, their own send button.
 *   Merging them would hide one thing you are supposed to do.
 */

const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'alerts.html'), 'utf8');
const script = (html.match(/<script>([\s\S]*?)<\/script>/) || [])[1] || '';

function loadGrouper() {
  const from = script.indexOf('function groupSameSentence');
  if (from < 0) {
    throw new Error('public/alerts.html no longer groups repeated alerts — '
      + 'the feed said the same sentence once per ticker');
  }
  const to = script.indexOf('\n}', from) + 2;
  // eslint-disable-next-line no-new-func
  return new Function(`${script.slice(from, to)}; return groupSameSentence;`)();
}

const REH = 'REHEARSAL — 1 leg(s) did not come back: Cards on the list: the tool '
  + 'has no cards today, so there is nothing for the setup to rank. Check the tool '
  + 'is scanning and not paused.';

const plain = (ticker, over = {}) => ({
  kind: 'setup', rule: 'Test', level: 'warn', ticker, at: 1000, detail: REH, ...over,
});

describe('the same sentence is said once', () => {
  test('four identical rehearsals become one row', () => {
    const g = loadGrouper();
    const out = g(['MSFT', 'NVDA', 'TSLA', 'AAPL'].map(t => plain(t)));
    expect(out.length).toBe(1);
    expect(out[0].alsoCount).toBe(4);
  });

  test('and that row names every ticker it stands for', () => {
    // Grouping that drops a name is not grouping, it is losing an alert.
    const g = loadGrouper();
    const out = g(['MSFT', 'NVDA', 'TSLA', 'AAPL'].map(t => plain(t)));
    expect(out[0].alsoTickers).toEqual(['MSFT', 'NVDA', 'TSLA', 'AAPL']);
  });

  test('the group carries the NEWEST time, whatever order it arrived in', () => {
    /*
     * "4m ago" on a group means "the last time this happened". Stamped with
     * its oldest member it would say the thing had stopped while it is still
     * going — and the feed's order is not something this should have to trust.
     */
    const g = loadGrouper();
    const asc = g([plain('A', { at: 100 }), plain('B', { at: 900 })]);
    const desc = g([plain('B', { at: 900 }), plain('A', { at: 100 })]);
    expect({ asc: asc[0].at, desc: desc[0].at }).toEqual({ asc: 900, desc: 900 });
  });

  test('a different sentence is a different row', () => {
    const g = loadGrouper();
    const out = g([plain('A'), plain('B', { detail: 'something else entirely.' })]);
    expect(out.length).toBe(2);
  });

  test('the same words at a different LEVEL do not merge', () => {
    /*
     * Folding an error into a warning quietly downgrades it, and the page you
     * open because something went wrong is the last place for that.
     */
    const g = loadGrouper();
    const out = g([plain('A'), plain('B', { level: 'error' })]);
    expect(out.length).toBe(2);
    expect(out.map(f => f.level)).toEqual(['warn', 'error']);
  });

  test('the same words from a different setup do not merge', () => {
    const g = loadGrouper();
    const out = g([plain('A'), plain('B', { rule: 'OR + VWAP 09:35' })]);
    expect(out.length).toBe(2);
  });

  test('the CONTROL is kept apart from an ordinary alert', () => {
    // It is a diagnostic that writes to the same feed. Folding it in with a
    // real finding would read as one more of the same thing.
    const g = loadGrouper();
    const out = g([plain('A'), plain('B', { control: true })]);
    expect(out.length).toBe(2);
  });
});

describe('a trade card never groups', () => {
  const trade = (ticker) => ({
    kind: 'setup', rule: 'Test', level: 'trade', ticker, at: 1000, detail: REH,
    setup: { entry: 10, stop: 9, target: 13, signal: 'LONG' },
  });

  test('two identical-looking trades stay two rows', () => {
    const g = loadGrouper();
    const out = g([trade('MSFT'), trade('MSFT')]);
    expect(out.length).toBe(2);
  });

  test('and a rule fire is untouched', () => {
    // Rules are not setups and have their own row shape entirely.
    const g = loadGrouper();
    const rule = { kind: 'rule', rule: 'pmHigh break', ticker: 'X', at: 1, detail: REH };
    expect(g([rule, { ...rule }]).length).toBe(2);
  });
});

describe('nothing is lost on the way through', () => {
  test('an empty feed stays empty', () => {
    expect(loadGrouper()([])).toEqual([]);
  });

  test('a fire with no ticker still makes a row', () => {
    // A rehearsal publishes with ticker null — it is about the SETUP, not a
    // name. A grouper keyed on ticker would have dropped it entirely.
    const g = loadGrouper();
    const out = g([plain(null), plain(null)]);
    expect(out.length).toBe(1);
    expect({ count: out[0].alsoCount, tickers: out[0].alsoTickers })
      .toEqual({ count: 2, tickers: [] });
  });

  test('the originals are not mutated', () => {
    /*
     * FIRES is what the status strip counts and what announce() dedupes on. A
     * grouper that wrote its bookkeeping onto those objects would have the
     * strip counting rows this renderer invented.
     */
    const g = loadGrouper();
    const src = [plain('A'), plain('B')];
    g(src);
    for (const f of src) {
      expect({ t: f.ticker, also: f.alsoCount }).toEqual({ t: f.ticker, also: undefined });
    }
  });
});

/*
 * ONE DEFINITION OF "FIRED TODAY".
 *
 * The strip said 4 and the feed heading said 5, three hundred pixels apart,
 * under the same three words. The strip is the one that is right and says why:
 * the control is a diagnostic that writes to the same feed, and a morning of
 * "17 fired today" that was mostly the control is a check of the machine being
 * read as a trading day.
 */
describe('the page counts fires the same way twice', () => {
  test('the strip and the feed heading both drop the control', () => {
    expect(script).toContain('const today = (FIRES || []).filter(f => !f.control)');
    expect(script).toContain('const real = fires.filter(f => !f.control).length');
    expect(script).toContain('tabBadge(\'today\', real)');
  });

  test('and the control is named rather than silently subtracted', () => {
    // A number that drops with no explanation is how you end up counting rows
    // by hand to find out which one lied.
    expect(script).toContain('control');
    expect(script).toMatch(/\$\{ctrl \? ` · \$\{ctrl\} control` : ''\}/);
  });

  test('its rows are still on the feed', () => {
    // It is the one alert that proves the feed itself is alive.
    expect(script).toContain("f.control ? '<span class=\"su-tag\">CONTROL</span>' : ''");
  });
});

/*
 * A HUNDRED PHONE SCREENS OF SCROLL.
 *
 * Measured in a browser rather than read: opening History rendered 500 rows
 * and 103,448 pixels into one pane. Nobody reaches the bottom of that, and
 * there is nothing at the bottom worth reaching — so the tab that keeps the
 * record was, in practice, a tab that did not.
 *
 * Most of it was the same few sentences once per name, which is the traffic
 * the live feed had just been rid of: the grouper was only ever wired to
 * Today, so the tab holding the MOST copies was the one still printing all of
 * them. After grouping and a cap the same session is 10,150 pixels.
 *
 * A CAP IS NOT A TRUNCATION, and that is what these check: the count is said
 * out loud and the rest is one tap away.
 */
describe('history is one screen, not a hundred', () => {
  const hist = script.slice(script.indexOf('async function loadHistory('),
                            script.indexOf('/* ── the rules ── */'));

  test('the same grouper runs here, not a second one', () => {
    // Two implementations of "these say the same thing" would eventually
    // disagree, and the one that drifts is the tab you look at least.
    expect(hist).toContain('groupSameSentence(fires)');
  });

  test('it renders a page, and says how many there are', () => {
    expect(hist).toContain('HIST_PAGE');
    expect(hist).toContain('show the other ');
    expect(script).toContain('function showAllHistory()');
  });

  test('a count that shrank explains itself', () => {
    /*
     * "500 records, shown as 353" — a number that drops with no explanation
     * is how you end up counting rows by hand to find out which one lied.
     */
    expect(hist).toContain('rows.length < fires.length');
    expect(hist).toContain('records, shown as');
  });

  test('choosing another day starts folded again', () => {
    // "Show the other 313" was a decision about the day it was asked of.
    // Carried over, picking any other session drops a hundred screens on you
    // without being asked — the thing the cap exists to stop.
    expect(hist).toContain('if (want !== HIST_SHOWN) { HIST_ALL = false; HIST_SHOWN = want; }');
  });

  test('the page size is one screenful, not a token gesture', () => {
    const n = Number(/const HIST_PAGE = (\d+)/.exec(script)[1]);
    expect({ n, sane: n >= 20 && n <= 100 }).toEqual({ n, sane: true });
  });
});
