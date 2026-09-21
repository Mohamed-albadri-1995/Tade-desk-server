/*
 * HISTORY AND LOG WERE TWO TABS ANSWERING HALF A QUESTION EACH.
 *
 *   the log      575 evaluated, 0 signalled     — what the desk DID
 *   the history  here are the 0                 — what it SAID
 *
 * Neither answers "was that day normal" on its own, they are read at the same
 * moment for the same reason, and each had its own date picker — so the two
 * halves of one answer could be showing two different days, which is the one
 * thing a record must never do.
 *
 * They are now one tab, split by TIME rather than by which table the rows came
 * out of:
 *
 *   Live   what do I do in the next minute      (kept current, has send buttons)
 *   Day    was that day normal                   (a record, one picker, static)
 *
 * The distinction is real, so both may cover today without overlapping.
 */

const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'alerts.html'), 'utf8');
const script = (html.match(/<script>([\s\S]*?)<\/script>/) || [])[1] || '';

const sections = (open, close) => {
  const from = html.indexOf(open);
  return [...html.slice(from, html.indexOf(close, from))
    .matchAll(/<button class="tb[^"]*" data-t="([a-z]+)"/g)].map(m => m[1]);
};

describe('five tabs, split by time', () => {
  test('Log is gone as a tab, in both navigations', () => {
    expect(sections('<aside class="al-side"', '</aside>')).toEqual(
      ['today', 'history', 'setups', 'settings']);
    expect(sections('<div class="tabs" id="tabs">', '</div>')).toEqual(
      ['today', 'history', 'setups', 'settings']);
    expect(html).not.toContain('data-t="log"');
  });

  test('and the names say what they are for', () => {
    // "Today" and "History" are both about time and neither says which
    // question it answers. Live is the monitor; Day is the record.
    expect(html).toContain('data-t="today">Live<');
    expect(html).toContain('data-t="history">Day<');
  });

  test('a browser that remembers "log" is not left staring at nothing', () => {
    /*
     * The chosen tab is remembered in localStorage, so every browser that last
     * sat on Log has 'log' saved. An unknown name hides every pane and shows
     * none — a blank page on the next visit, with nothing on it to act on.
     */
    // A TABLE now, because 'rules' joined 'log' in being retired. Each dead
    // name points at whatever absorbed it; an unknown name hides every pane
    // and shows none, which is a blank page with nothing on it to act on.
    expect(script).toContain("const MOVED = { log: 'history', rules: 'today' };");
    expect(script).toContain("const want = MOVED[name] || name || 'today';");
  });
});

describe('one day, both halves, one picker', () => {
  const pane = html.slice(html.indexOf('<div class="pane" data-t="history"'),
                          html.indexOf('</div><!-- /history -->'));

  test('the funnel and the alerts are in the same pane', () => {
    for (const id of ['log-summary', 'log-runs', 'history']) {
      expect({ id, inPane: pane.includes(`id="${id}"`) }).toEqual({ id, inPane: true });
    }
  });

  test('the funnel comes FIRST — "did it work" before "what did it say"', () => {
    expect(pane.indexOf('id="log-summary"')).toBeLessThan(pane.indexOf('id="history"'));
  });

  test('only one picker is on screen', () => {
    /*
     * The log's date input is still in the DOM because loadLog() reads it, and
     * a second way of holding "which day" is a second thing that can be wrong.
     * It is hidden; the select is what a person touches.
     */
    expect(pane).toContain('<input type="date" id="log-date" hidden>');
    expect(pane).not.toContain('onchange="loadLog()"');
    const visible = [...pane.matchAll(/<(select|input)[^>]*id="(hist-date|log-date)"[^>]*>/g)]
      .filter(m => !m[0].includes('hidden'));
    expect(visible.map(m => m[0].match(/id="([a-z-]+)"/)[1])).toEqual(['hist-date']);
  });

  test('and one function keeps the two in step', () => {
    const fn = script.slice(script.indexOf('function loadDay()'),
                            script.indexOf('\n}', script.indexOf('function loadDay()')));
    expect(fn).toContain('log.value = pick.value');
    expect(fn).toContain('loadLog()');
    expect(fn).toContain('loadHistory(');
    // Both controls call it, so neither can move the day on its own.
    expect(pane).toContain('onchange="loadDay()"');
    expect(pane).toContain('onclick="loadDay()"');
  });

  test('the day is fetched when the tab is opened, not on a timer', () => {
    /*
     * Live is kept current because it answers a question about the next few
     * minutes. This is a record of what already happened: polling it would add
     * a request every few seconds all morning to keep a hidden pane fresh.
     */
    expect(script).toContain("if (want === 'history') loadDay();");
    expect(script).not.toMatch(/setInterval\(\s*loadLog/);
  });
});

/*
 * THE LIVE SCREEN IS A MONITOR.
 *
 * The sound and notification switches sat above the morning's alerts on the
 * one tab that is watched during the open — two settings touched once a month,
 * given the top of the screen the desk is actually run from.
 */
describe('the live screen carries no settings', () => {
  const live = html.slice(html.indexOf('<div class="pane" data-t="today">'),
                          html.indexOf('</div><!-- /today -->'));

  test('the switches are off it', () => {
    expect(live).not.toContain('class="noise"');
    expect(live).not.toContain('id="snd"');
  });

  test('they are in Settings, not deleted', () => {
    const set = html.slice(html.indexOf('<div class="pane" data-t="settings"'));
    for (const id of ['snd', 'ntf', 'ntf-test', 'noise-note']) {
      expect({ id, kept: set.includes(`id="${id}"`) }).toEqual({ id, kept: true });
    }
  });

  test('the hidden nodes two painters write to went with them', () => {
    // A missing node is a thrown error at 09:35, and both of these are written
    // to by painters that run on every tab.
    for (const id of ['next-decision', 'algo-state']) {
      expect({ id, present: html.includes(`id="${id}"`) }).toEqual({ id, present: true });
    }
  });

  test('and the state is still said out loud, on every tab', () => {
    /*
     * An alerting page whose sound is off without saying so is worse than one
     * with no sound. Moving the switch must not move the FACT — the strip above
     * the tabs carries it, and that is outside every pane.
     */
    expect(html.indexOf('id="deskstrip"')).toBeLessThan(html.indexOf('<div class="tabs"'));
  });
});
