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
  const at = script.indexOf('<div class="or-head">SENT');
  expect(at).toBeGreaterThan(-1);
  const after = script.slice(at, at + 700);
  expect(after).toContain('loadHistory()');
  expect(after).toContain('loadFires()');
});

/*
 * The broker settings, after two accounts became possible.
 *
 * The old page had one hook and one balance in fixed inputs, so "which
 * account" was not a question it could ask. These pin the parts of the new
 * shape that would fail silently: a hook printed in full is a credential
 * published, and a setup card that cannot draw its accounts is a routing
 * control that does not exist.
 */

test('the single-hook inputs are gone, and nothing still reads them', () => {
  for (const id of ['bk-url', 'bk-test-url', 'bk-power', 'bk-max', 'bk-maxtrades']) {
    expect(html).not.toContain(`id="${id}"`);
    expect(script).not.toContain(`'${id}'`);
  }
  expect(markup).toContain('id="bk-dests"');
});

test('an account row never prints a hook, only what the server masked', () => {
  // publicSettings masks it; the page must not have a path that would show the
  // real one even if it arrived. The only hook value rendered is the masked
  // `webhookUrl` the server sends, and it goes into a PLACEHOLDER.
  const at = script.indexOf('function paintDests(');
  expect(at).toBeGreaterThan(-1);
  const body = script.slice(at, script.indexOf('\n}\n', at));
  expect(body).toContain('placeholder="${d.hasWebhook');
  // …and the input itself is never given a value
  expect(body).not.toMatch(/class="d-hook"[^>]*value=/);
});

test('the accounts are loaded before the setup cards that draw them', () => {
  // A setup card shows which accounts it sends to, so it cannot paint those
  // chips until it knows what accounts exist. The other direction is handled
  // by paintAlgoState, which either loader may call last.
  expect(script).toContain('loadBroker().then(loadSetups)');
  expect(script).toContain('function paintAlgoState()');
});

test('every routing control is a top-level function', () => {
  // Same invariant as alerts.page.globals: an inline onclick resolves on
  // window and nowhere else. These are all called from generated markup.
  const re = /^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm;
  const top = new Set([...script.matchAll(re)].map(m => m[1]));
  for (const n of ['paintDests', 'readDests', 'saveDests', 'addDest', 'createDest',
                   'toggleDest', 'removeDest', 'toggleDestSetup', 'accountChips',
                   'sizeNote', 'testBroker', 'toggleArm']) {
    expect({ name: n, top: top.has(n) }).toEqual({ name: n, top: true });
  }
});

test('the review carries the account through to the send', () => {
  // Previewing against one balance and sending against another would be a
  // reviewed order and an unreviewed one wearing its numbers.
  expect(script).toContain('async function reviewOrder(plan, destination)');
  expect(script).toContain("if (destination) plan = { ...plan, destination };");
});

/*
 * The bug that made "+ Add an account" do nothing.
 *
 * The add form is styled with `.dest` so it lines up with the saved rows. That
 * made readDests() pick it up as a row — a destination with no data-id — and
 * the server rejected the whole save for having an unnamed destination. From
 * the outside: you filled the form, pressed the button, and nothing appeared.
 *
 * The pair of facts below is what keeps them apart, and neither is safe to
 * change without the other.
 */
test('the add form is excluded from the rows that get saved', () => {
  expect(script).toContain("'#bk-dests .dest:not(.dest-form)'");
  expect(script).toContain('class="dest dest-form"');
});

test('a saved row carries the identity readDests needs', () => {
  // It used to read a positional data-i index into the last fetched list, which
  // broke the moment a row was added or removed between paint and save.
  const at = script.indexOf('function paintDests(');
  const body = script.slice(at, script.indexOf('function deskHint', at));
  for (const attr of ['data-id=', 'data-dialect=', 'data-off=']) {
    expect(body).toContain(attr);
  }
  expect(script).not.toContain("el.getAttribute('data-i')");
});

test('no account is configured through a prompt() box', () => {
  /*
   * Adding an account was three prompts in a row. On a phone a prompt is easy
   * to dismiss by accident and dismissing any one of them returned silently,
   * so the button read as broken. Anything that needs several answers is a
   * form now.
   *
   * Two prompt-family calls stay and both are fine: confirm() before spending
   * money, which is exactly what it is for, and one prompt() in copyCallback
   * that shows the callback URL as selectable text when the clipboard is
   * refused — it collects nothing.
   */
  // Comments in this region DISCUSS prompt() — that is the bug being described
  // — so the check has to look at code. Stripped crudely; good enough to tell a
  // call from a sentence about one.
  const code = script.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const from = code.indexOf('function paintDests(');
  const to = code.indexOf('async function toggleDest(');
  expect(from).toBeGreaterThan(-1);
  expect(to).toBeGreaterThan(from);
  expect(code.slice(from, to)).not.toMatch(/(^|[^.\w])prompt\s*\(/m);
  // …and the only one left in the whole page is that clipboard fallback.
  expect([...code.matchAll(/(^|[^.\w])prompt\s*\(/gm)]).toHaveLength(1);
  expect(script).toContain('Copy this into SignalStack');
});

test('an account is sized as a multiple of the standard, and says what it may do', () => {
  /*
   * Sizing every account off one balance is how a $5,000 account gets an order
   * meant for $20,000 — refused by the broker, at 09:36. And the mode is on the
   * ACCOUNT, not the setup: the arrangement that matters most is the same
   * strategy watched by hand in one account and automatic in another, which a
   * flag on the strategy cannot express at all.
   */
  const at = script.indexOf('function paintDests(');
  const body = script.slice(at, script.indexOf('async function toggleDestSetup', at));
  for (const cls of ['d-scale', 'd-mode', 'd-setups']) expect(body).toContain(cls);
  expect(script).toContain("['d-scale', 'scale']");
  expect(body).toContain('FULL AUTO');
});

test('an account owns its setups — the setup card writes nothing back', () => {
  // One direction. Two objects describing one decision is how they came to
  // disagree, which is the whole reason for this shape.
  expect(script).toContain('async function toggleDestSetup(');
  expect(script).not.toContain('function toggleSetupBroker(');
  expect(script).not.toContain('function toggleAutoTrade(');
  expect(script).not.toContain("body: JSON.stringify({ autoTrade: next })");
});

test('the review says which account, and so does the send button', () => {
  // The order body cannot carry it — SignalStack decides the account from the
  // hook it arrived on — so it is the one fact that has to be on the screen.
  expect(script).toContain('class="or-dest"');
  expect(script).toContain('Send${name ? ` to ${esc(name)}` : \' it\'}');
});

/*
 * ONE MODEL, THREE LAYERS, IN ORDER.
 *
 * The page had two designs stacked on each other: a standard account size at
 * the top that looked like the account being traded, and broker accounts below
 * that also had capital — with "which setups" and "auto or not" living on the
 * SETUP, a third place. Three descriptions of one decision, which is how they
 * came to disagree.
 *
 *   1  the standard account   a reference; nothing trades against it
 *   2  the broker accounts    hook, size as a multiple, mode, setups
 *   3  the box                armed, flatten, brackets
 *
 * The tests below pin the shape, not the styling: the order of the sections,
 * that the reference says it is one, and that the setup card cannot write back.
 */

test('the settings tab is the three layers, in order', () => {
  const pane = markup.slice(markup.indexOf('<div class="pane" data-t="settings"'));
  const heads = [...pane.matchAll(/<span>(\d[^<]*)<\/span>/g)].map(m => m[1].trim());
  expect(heads).toEqual(['1 · Standard account', '1b · Calculator',
                         '2 · Broker accounts', '3 · This machine']);
});

test('the standard account says outright that it is a reference', () => {
  // The screenshot that started this: a $5,000 "Account size" at the top of a
  // page listing two real accounts, with nothing saying which one trades.
  const at = markup.indexOf('1 · Standard account');
  const after = markup.slice(at, at + 700);
  expect(after).toMatch(/reference only/i);
  expect(after).toMatch(/no order is ever placed against it/i);
});

test('a mode is a real choice, and full auto is not the quiet one', () => {
  const at = script.indexOf('const MODE_LABEL');
  expect(at).toBeGreaterThan(-1);
  const body = script.slice(at, at + 400);
  for (const m of ['alert', 'manual', 'auto']) expect(body).toContain(`${m}:`);
  expect(body).toContain('FULL AUTO');
  // …and it is visually distinct, because an account that trades by itself
  // must never look like one that does not.
  expect(html).toContain('.dest.md-auto');
});

test('an account shows what its multiplier MEANS in money', () => {
  // "0.5x" is the setting; "$5,000 risking $50" is what tells you it is wrong.
  // The arithmetic must mirror risk.forAccount or the row is a second opinion.
  const at = script.indexOf('function sizeNote(d)');
  const body = script.slice(at, script.indexOf('\n}\n', at));
  expect(body).toContain('r.accountSize * scale');
  expect(body).toContain('r.riskPerTrade * scale');
  expect(body).toContain('risks $');
});

test('a setup an account claims still shows when the catalogue does not list it', () => {
  // qp down, or a renamed strategy: the row would otherwise show NO setups
  // while the account still trades the one it has stored.
  const at = script.indexOf('function paintDests(');
  const body = script.slice(at, script.indexOf('async function toggleDestSetup', at));
  expect(body).toContain('not in the catalogue');
});

test('the send picker lists every account, always', () => {
  /*
   * Not conditional on there being more than one, and not filtered to the
   * accounts that run this setup. The order body cannot say where it went —
   * SignalStack decides that from the hook — so the account is a question that
   * can only be answered before the tap.
   */
  const at = script.indexOf('const dests = r.destinations || [];');
  const body = script.slice(at, at + 1200);
  expect(body).toContain('or-pick');
  expect(body).toContain('dests.map(');
  expect(body).toContain('not its setup');
  expect(body).not.toMatch(/dests\.length > 1/);
});

test('the calculator sends through the same review, not its own path', () => {
  // It used to POST straight to the order endpoint — the one path where
  // "which account" was never asked, which with two accounts is a real order
  // into whichever one the server happened to resolve.
  const at = script.indexOf('async function sendManual()');
  const body = script.slice(at, script.indexOf('\n}\n', at));
  expect(body).toContain('reviewOrder(');
  expect(body).not.toContain("fetch('/api/broker/order'");
});

test('arming names the accounts that will trade by themselves', () => {
  const at = script.indexOf('async function toggleArm()');
  const body = script.slice(at, script.indexOf('\n}\n', at));
  expect(body).toContain("d.mode === 'auto'");
  expect(body).toContain('BY THEMSELVES');
  expect(body).toContain('buyingPower');
});

/*
 * THE LOOK, checked where it can be checked statically.
 *
 * Four complaints, and each has one fact in the file that makes it true or
 * false. Not a substitute for looking at the page — that is what the browser
 * probe is for — but these are the ones that regress silently when someone
 * adds a rule in a hurry.
 */

test('prose is a UI face and numbers are monospace', () => {
  // The whole page was monospace, including nine-tenths of it that is prose.
  // Monospace is for things compared column-wise: prices, counts, times, JSON.
  expect(html).toMatch(/body\s*{[^}]*font-family:var\(--ui\)/);
  expect(html).toMatch(/--ui:system-ui/);
  expect(html).toMatch(/\.h-n[^{]*{\s*font-family:var\(--mono\)|font-family:var\(--mono\);?\s*}/);
  expect(html).toContain('font-variant-numeric:tabular-nums');
});

test('there are real surfaces to stack things on', () => {
  // Three greys eight points apart is one grey on a phone in daylight.
  const vars = html.slice(html.indexOf(':root'), html.indexOf('* { box-sizing'));
  for (const v of ['--bg:', '--panel:', '--panel2:', '--panel3:', '--line:', '--line2:']) {
    expect({ token: v, defined: vars.includes(v) }).toEqual({ token: v, defined: true });
  }
});

test('sizes and gaps come from a scale, not from guesses', () => {
  const vars = html.slice(html.indexOf(':root'), html.indexOf('* { box-sizing'));
  for (const v of ['--f-xs', '--f-sm', '--f-md', '--f-lg', '--f-xl',
                   '--s1', '--s2', '--s3', '--s4', '--s5']) {
    expect({ token: v, defined: vars.includes(v) }).toEqual({ token: v, defined: true });
  }
});

test('long explanations fold behind a why', () => {
  /*
   * Every control carries a paragraph saying why it exists. That reasoning is
   * worth keeping — it is the difference between a setting and a superstition
   * — but at the same weight as the data it is a wall, and a wall is not read
   * at 09:36.
   */
  expect(script).toContain('function foldWhy(');
  expect(script).toContain('const WHY_LIMIT');
  expect(html).toContain('details.why');
  // Only explanations. Warnings, counts and errors are never folded.
  const at = script.indexOf('function foldWhy(');
  const body = script.slice(at, script.indexOf('\n}\n', at));
  expect(body).toContain('.risk-hint');
  expect(body).not.toContain('.warn');
});

test('a heading and its status note do not share a line', () => {
  // They were flex-between: a three-word heading beside a fifteen-word note
  // turned both into narrow columns of wrapped capitals.
  const at = html.indexOf('.sec {');
  const rule = html.slice(at, html.indexOf('}', at));
  expect(rule).toContain('flex-wrap:wrap');
  expect(html).toMatch(/\.sec > span:first-child \{[^}]*flex:1 0 100%/);
});

test('every control states its own background', () => {
  // .lnk was written for <a> and used on <button>. A button with no background
  // takes the browser's light grey, which on a dark page is a white pill
  // nobody designed.
  const at = html.indexOf('.lnk {');
  expect(html.slice(at, html.indexOf('}', at))).toContain('background:');
  const at2 = html.indexOf('.h-send {');
  expect(html.slice(at2, html.indexOf('}', at2))).toContain('background:');
});
