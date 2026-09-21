/*
 * THE RECORD WAS ONE SCROLL, AND MOST OF IT WAS "NOTHING HAPPENED".
 *
 * Reported as: "what you named it day I don't know what the name mean also
 * it's not organized and also every section of it need to be collapsed by
 * default".
 *
 * Three complaints and all three were the same tab.
 *
 *   THE NAME. It was "Day". "Day" says WHEN, and the tab is not about when —
 *   it is about going back over a session that has already happened, which is
 *   a thing you DO. Named for the verb now.
 *
 *   NOT ORGANISED. The control, then every setup, then every BAR of every
 *   setup, then the day's alerts, all open, all the same weight, in one
 *   column. On 2026-09-21 that was 242 rows of "nothing on this bar (window
 *   still open)" between the counts and the alerts.
 *
 *   COLLAPSED BY DEFAULT. Every section, and the summary carries its answer —
 *   a fold that hides the one fact it was cheapest to show is worse than no
 *   fold. Shut, the tab is three lines that answer "was that day normal".
 *
 * MEASURED in a browser at 430px, on 242 runs and 59 alerts:
 *   shut  294px      open  17,449px
 */

const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'alerts.html'), 'utf8');
const script = (html.match(/<script>([\s\S]*?)<\/script>/) || [])[1] || '';
const pane = html.slice(html.indexOf('<div class="pane" data-t="history"'),
                        html.indexOf('</div><!-- /history -->'));

describe('the name says what you came to do', () => {
  test('the tab is Review, in both navigations', () => {
    expect((html.match(/data-t="history">Review</g) || []).length).toBe(2);
    expect(html).not.toContain('data-t="history">Day<');
  });

  test('and the heading is not the old one either', () => {
    expect(pane).toContain('<span>Review a session</span>');
    expect(pane).not.toContain('<span>The day</span>');
  });

  test('a browser that remembers the old tab name still lands somewhere', () => {
    // The stored value is the data-t, not the label, so renaming the LABEL
    // cannot strand anyone. Pinned because it is exactly the sort of thing a
    // rename breaks silently.
    expect(script).toContain("const MOVED = { log: 'history', rules: 'today' };");
    expect(script).toContain("localStorage.setItem('alertsTab', want)");
  });
});

describe('every section is shut, and says its answer while shut', () => {
  /** The class list of every <details> the pane or the loaders create. */
  const folds = () => [...script.matchAll(/<details class="lg-fold([^"]*)"/g)]
    .concat([...pane.matchAll(/<details class="lg-fold([^"]*)"/g)])
    .map(m => ({ cls: m[1].trim() }));

  test('not one of them is written open', () => {
    /*
     * THE WHOLE REQUEST. A single `open` attribute anywhere here is one
     * section that ignores it, and it would be the longest one — because the
     * longest one is the one somebody was most recently looking at.
     */
    const all = [...script.matchAll(/<details class="lg-fold[^"]*"([^>]*)>/g)]
      .concat([...pane.matchAll(/<details class="lg-fold[^"]*"([^>]*)>/g)]);
    expect(all.length).toBeGreaterThanOrEqual(4);
    for (const m of all) {
      expect({ tag: m[0], open: /\bopen\b/.test(m[1]) }).toEqual({ tag: m[0], open: false });
    }
  });

  test('there are four kinds of section, and no more', () => {
    /*
     * control · setup · every bar · alerts. A fifth is a fifth thing to
     * scroll past, and the point of this tab is that there is nothing to
     * scroll past. The alerts fold is the one in the markup; the other three
     * are built by the loaders.
     *
     * Only the LITERAL class tokens count — a class list is part markup and
     * part template (`lg-set${g.failed ? ' bad' : ''}`), and taking the first
     * whitespace-separated word off that gives a fragment of JavaScript.
     */
    const kinds = new Set();
    for (const f of folds()) {
      for (const w of f.cls.split(/[\s$]/)) {
        if (/^lg-[a-z]+$/.test(w)) kinds.add(w);
      }
    }
    expect([...kinds].sort()).toEqual(['lg-bars', 'lg-ctl', 'lg-set']);
  });

  test('"did the desk run" carries the count of checks', () => {
    const ctl = script.slice(script.indexOf('function lgControl('),
                             script.indexOf('async function loadLog'));
    expect(ctl).toContain('<summary><b>Did the desk run</b>');
    expect(ctl).toContain('fired on ${fired} of ${rows.length} check');
    // AN ERROR IS NEVER A ZERO: a control that never ran must not read as a
    // control that ran and found nothing, and it must say so while shut.
    expect(ctl).toContain('<span class="when">NOT RUN</span>');
  });

  test('a setup carries how many times it ran and how many it took', () => {
    const at = script.indexOf('sum.innerHTML = control + setups.map');
    const body = script.slice(at, script.indexOf('runs.innerHTML', at));
    expect(body).toContain('${g.runs} run${g.runs === 1 ? \'\' : \'s\'} · ${g.picked || 0} taken');
    // NEVER RAN is not "0 runs" — see lgFunnel's note. It is its own answer.
    expect(body).toContain("`NEVER RAN · due ${esc(g.dueBar || '')}`");
  });

  test('and a failure is visible without opening anything', () => {
    /*
     * The one day worth finding is the day something broke. Shut, that setup
     * says FAILED and is outlined in red; if it only said so inside, the fold
     * would be hiding the single fact this tab exists for.
     */
    const at = script.indexOf('sum.innerHTML = control + setups.map');
    const body = script.slice(at, script.indexOf('runs.innerHTML', at));
    expect(body).toContain("${g.neverRan || g.failed ? ' bad' : ''}");
    expect(body).toContain('${g.failed} FAILED');
    expect(body).toContain("g.lagBars ? ' · FEED BEHIND' : ''");
    expect(html).toContain('.lg-set.bad { border-color:var(--red); }');
  });

  test('the alerts fold carries how many fired', () => {
    expect(pane).toContain('<summary><b>Alerts published</b> <span id="hist-count"');
    expect(script).toContain('function setHistCount(fires, rows)');
    expect(script).toContain('setHistCount(fires.length, rows.length)');
    // A day with none says so rather than leaving the summary blank.
    expect(script).toContain("if (!fires) { el.textContent = 'none'; return; }");
    expect(script).toContain('setHistCount(0, 0)');
  });

  test('two numbers when they differ, because they answer two questions', () => {
    // `fires` is how many the desk published; `rows` is how many lines you
    // will see, because alerts carrying the same sentence are one row. One
    // number silently meaning sometimes one and sometimes the other is how
    // you end up counting rows by hand.
    const fn = script.slice(script.indexOf('function setHistCount('),
                            script.indexOf('\n}', script.indexOf('function setHistCount(')));
    // eslint-disable-next-line no-new-func
    const run = (fires, rows) => {
      const el = { textContent: '' };
      // eslint-disable-next-line no-new-func
      new Function('document', `${fn}\n}; setHistCount(${fires}, ${rows});`)(
        { getElementById: () => el });
      return el.textContent;
    };
    expect(run(59, 59)).toBe('59');
    expect(run(474, 24)).toBe('474 · 24 rows');
    expect(run(0, 0)).toBe('none');
  });

  test('a history that could not be read does not read as "none"', () => {
    // AN ERROR IS NEVER A ZERO, on the one line that is visible while shut.
    const at = script.indexOf('function loadHistory(');
    const body = script.slice(at, script.indexOf('\n}\n', at));
    expect(body).toContain("c.textContent = 'could not read'");
  });
});

describe('every bar is kept, and is not the tab', () => {
  test('the 242 rows are behind a fold of their own, inside the setup', () => {
    const at = script.indexOf('sum.innerHTML = control + setups.map');
    const body = script.slice(at, script.indexOf('runs.innerHTML', at));
    expect(body).toContain('<details class="lg-fold lg-bars">');
    expect(body).toContain('<summary>every bar <span class="when">');
    // Nothing is thrown away — the same rows, the same renderer.
    expect(body).toContain('(byId[id] || []).map(lgRun).join(\'\')');
  });

  test('a setup with no runs gets no empty fold', () => {
    const at = script.indexOf('sum.innerHTML = control + setups.map');
    const body = script.slice(at, script.indexOf('runs.innerHTML', at));
    expect(body).toContain("${(byId[id] || []).length ? `<details");
  });

  test('the funnel and the problems stay ABOVE it', () => {
    // "Did it work" before "what did it say", which is why these two were
    // merged into one tab in the first place.
    const at = script.indexOf('sum.innerHTML = control + setups.map');
    const body = script.slice(at, script.indexOf('runs.innerHTML', at));
    expect(body.indexOf('lgFunnel(')).toBeLessThan(body.indexOf('lg-bars'));
    expect(body.indexOf('lg-prob')).toBeLessThan(body.indexOf('lg-bars'));
  });
});

describe('the fold is a control, and reads as one', () => {
  test('the marker turns instead of changing words', () => {
    expect(html).toContain(".lg-fold > summary::before { content:'\\25B8'");
    expect(html).toContain('.lg-fold[open] > summary::before { transform:rotate(90deg); }');
  });

  test('it is a tap target on a phone', () => {
    const rule = html.slice(html.indexOf('.lg-fold > summary {'),
                            html.indexOf('}', html.indexOf('.lg-fold > summary {')));
    expect(rule).toContain('cursor:pointer');
    expect(rule).toMatch(/min-height:3[4-9]px/);
    // The default triangle is removed on both engines, or there are two.
    expect(rule).toContain('list-style:none');
    expect(html).toContain('.lg-fold > summary::-webkit-details-marker { display:none; }');
  });

  test('the count sits at the far end, so the eye lands in one place', () => {
    expect(html).toContain('.lg-fold > summary .when { margin-left:auto;');
  });

  test('a nested fold does not draw a second box around itself', () => {
    expect(html).toContain('.lg-fold .lg-fold { background:none; border:0;');
  });
});
