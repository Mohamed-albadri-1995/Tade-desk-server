/*
 * Where things live on the alerts page, checked statically.
 *
 * Two invariants, both of which failed as real bugs rather than as opinions:
 *
 * 1. TODAY and HISTORY are separate tabs. They were one scroll, so every look
 *    at the morning's fires ended somewhere in last Tuesday, and the manual
 *    send button was down there with the old sessions instead of next to the
 *    signal it belonged to.
 *
 * 2. The order review is attached to the PAGE, not to a pane. It used to be a
 *    static div inside the history section. That was harmless while history
 *    was the only place a review could be asked for; the moment "review
 *    order…" appeared on today's fires it became a button that fetches a
 *    preview and renders it into a hidden pane — a tap that does nothing, on
 *    the one control that sends real money.
 *
 * Static because the alternative is a browser, and these are questions about
 * the file: which pane an element is written into, and whether the box is
 * created rather than declared.
 */

const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'alerts.html'), 'utf8');
const script = (html.match(/<script[^>]*>([\s\S]*?)<\/script>/) || [])[1] || '';
const markup = html.slice(0, html.indexOf('<script'));

/** The pane a given id is written inside, or null if it is in no pane. */
function paneOf(id) {
  const at = markup.indexOf(`id="${id}"`);
  if (at < 0) return null;
  const before = markup.slice(0, at);
  const opens = [...before.matchAll(/<div class="pane" data-t="([a-z]+)"/g)];
  if (!opens.length) return null;
  const last = opens[opens.length - 1];
  // …unless that pane already closed before this element.
  const closed = before.lastIndexOf('<!-- /', last.index);
  return closed > last.index ? null : last[1];
}

test('every tab button has a pane and every pane has a tab button', () => {
  const tabs = [...markup.matchAll(/class="tb[^"]*" data-t="([a-z]+)"/g)].map(m => m[1]);
  const panes = [...markup.matchAll(/<div class="pane" data-t="([a-z]+)"/g)].map(m => m[1]);
  expect(tabs).toEqual(['today', 'history', 'setups', 'rules', 'settings']);
  // A pane may appear more than once (two blocks of "today"); what must not
  // happen is a pane nobody can reach, or a tab that shows nothing.
  expect([...new Set(panes)].sort()).toEqual([...tabs].sort());
});

test('the history list is in the history pane, not in today', () => {
  expect(paneOf('history')).toBe('history');
  expect(paneOf('hist-date')).toBe('history');
});

test("today's fires stayed in today", () => {
  expect(paneOf('fires')).toBe('today');
  expect(paneOf('fire-count')).toBe('today');
});

test('the order review is built on the body, never written into a pane', () => {
  // If this id is in the markup at all it is inside SOME pane, and that pane
  // will be hidden about four-fifths of the time.
  expect(markup).not.toContain('id="order-review"');
  expect(script).toContain("document.body.appendChild(box)");
});

test('a review can be closed from the markup that offers it', () => {
  // The Cancel button used to reach into the div by id and set display:none,
  // which leaves the shade behind now that there is one.
  expect(script).toContain('function closeReview()');
  expect(script).not.toMatch(/order-review'\)\.style\.display\s*=\s*'none'/);
});

test("today's fires carry the numbers and the send button", () => {
  /*
   * The point of an alert-only week is to look at each signal and decide, in
   * the ten minutes after it fires. histNumbers is what renders the levels and
   * the "review order…" button, and it was called only from loadHistory — so
   * firing this morning's fourth name meant scrolling past the whole week.
   */
  const at = script.indexOf('async function loadFires()');
  expect(at).toBeGreaterThan(-1);
  const body = script.slice(at, script.indexOf('\n}', script.indexOf('catch', at)));
  expect(body).toContain('histNumbers(f)');
});

test('a sent order refreshes both lists', () => {
  // Whichever list it was sent from has to stop offering "review order…" for
  // it, or the same trade goes out twice.
  const at = script.indexOf('<div class="or-head">SENT</div>');
  expect(at).toBeGreaterThan(-1);
  const after = script.slice(at, at + 700);
  expect(after).toContain('loadHistory()');
  expect(after).toContain('loadFires()');
});
