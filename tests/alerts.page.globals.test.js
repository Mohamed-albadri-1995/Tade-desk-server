/*
 * Every function the alerts page calls from markup must be GLOBAL.
 *
 * This exists because of a bug that took the whole page down and looked like a
 * server problem. Five functions were added to alerts.html using an insertion
 * point that turned out to be a line INSIDE `loadHistory` — so they were
 * declared in that function's scope, not at the top level.
 *
 * Nothing complained. The file parsed, the tests passed, the markup was
 * correct. But `showTab` was undefined when the boot code called it, which
 * threw, which meant every statement after it never ran: no loadFires, no
 * loadRules, no loadSetups. The page rendered its static HTML and then sat
 * there saying "Loading…" for ever, while push notifications kept arriving —
 * so it read exactly like a broken API, and the one place the fault was not.
 *
 * An inline `onclick="foo()"` resolves `foo` on window and nowhere else, so
 * "declared at the top level" is a real invariant of this page rather than a
 * style preference. Checking it statically costs nothing and would have caught
 * that bug the moment it was written.
 *
 * A function declared at the start of a line is top-level here: this file has
 * no other unindented code, and everything nested is indented. Crude, and it
 * catches the failure that actually happened.
 */

const fs = require('fs');
const path = require('path');

const PAGE = path.join(__dirname, '..', 'public', 'alerts.html');
const html = fs.readFileSync(PAGE, 'utf8');
/* The INLINE script, not the first <script> tag — the head now links
   /desk.js, and matching that gave an empty string and eleven silent passes. */
const script = (html.match(/<script>([\s\S]*?)<\/script>/) || [])[1] || '';

/** Names called from an inline handler — onclick, onchange, oninput. */
function inlineHandlerNames() {
  const names = new Set();
  const re = /\bon(?:click|change|input|submit)\s*=\s*["']([^"']+)["']/g;
  let m;
  while ((m = re.exec(html))) {
    // Only a BARE call at the start of the handler: `foo(...)` needs a global,
    // while `document.getElementById(x).remove()` needs nothing of the sort and
    // was making this fail on `getElementById`.
    const call = /^\s*([A-Za-z_$][\w$]*)\s*\(/.exec(m[1]);
    if (call) names.add(call[1]);
  }
  return [...names].sort();
}

/*
 * Names declared at column 0 — i.e. on window.
 *
 * Both files: the page's own inline block, and /desk.js, which the head links
 * and which carries the handlers every page shares (the sunlight toggle). A
 * check that read only the inline block would report those as missing and be
 * wrong; one that read only desk.js would miss the page's own.
 */
const shared = fs.readFileSync(path.join(__dirname, '..', 'public', 'desk.js'), 'utf8');

function topLevelNames() {
  const names = new Set();
  for (const src of [script, shared]) {
    let m;
    const re = /^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm;
    while ((m = re.exec(src))) names.add(m[1]);
    const re2 = /^(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\(|function)/gm;
    while ((m = re2.exec(src))) names.add(m[1]);
  }
  return names;
}

test('the page has exactly one INLINE script block', () => {
  // The check below reads one block. Two would make it silently partial.
  // The head also links /desk.js — a src tag, with no body to read.
  expect((html.match(/<script>/g) || []).length).toBe(1);
  expect(script.length).toBeGreaterThan(1000);
});

test('every function called from markup is declared at the top level', () => {
  const top = topLevelNames();
  const missing = inlineHandlerNames().filter(n => !top.has(n));
  expect({ missing, hint: missing.length
    ? 'declared inside another function — an inline handler cannot see it'
    : 'ok' }).toEqual({ missing: [], hint: 'ok' });
});

test('the functions the boot sequence calls are declared at the top level', () => {
  // These are called by top-level statements at the end of the script. One of
  // them being nested is what emptied the page: the throw stopped every loader
  // that came after it.
  const boot = ['showTab', 'paintNoise', 'loadFires', 'loadRules', 'loadRisk',
                'loadSetups', 'loadHistory', 'loadUnassigned', 'subscribePush'];
  const top = topLevelNames();
  expect(boot.filter(n => !top.has(n))).toEqual([]);
});

test('no function is declared between loadHistory and its first statement', () => {
  /*
   * The specific shape of the bug, pinned. `loadHistory` was chosen as an
   * insertion anchor because a line inside it looked like a good landmark, and
   * five functions ended up in its body. Any future edit that does the same
   * thing fails here with the name it added.
   */
  const at = script.indexOf('async function loadHistory(date) {');
  expect(at).toBeGreaterThan(-1);
  const body = script.slice(at, script.indexOf('\n}', at));
  const nested = [...body.matchAll(/^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm)]
    .map(m => m[1])
    .filter(n => n !== 'loadHistory');
  expect(nested).toEqual([]);
});
