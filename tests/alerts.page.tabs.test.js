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
/* The INLINE script, not the first <script> tag — the head now links
   /desk.js, and matching that gave an empty string and eleven silent passes. */
const script = (html.match(/<script>([\s\S]*?)<\/script>/) || [])[1] || '';
const markup = html.slice(0, html.indexOf('<script>'));

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
  expect(tabs).toEqual(['today', 'history', 'setups', 'log', 'rules', 'settings']);
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

test("today's fires can be sent from where they are read", () => {
  /*
   * The point of an alert-only week is to look at each signal and decide, in
   * the ten minutes after it fires — so the send has to be on the card, not
   * only on the permanent record where it used to live.
   */
  const at = script.indexOf('async function loadFires()');
  expect(at).toBeGreaterThan(-1);
  const body = script.slice(at, script.indexOf('\n}', script.indexOf('catch', at)));
  expect(body).toContain('setupFire(f, fresh)');
  const card = script.slice(script.indexOf('function setupFire('),
                            script.indexOf('function orderChips('));
  expect(card).toContain('readyButtons(f, t)');
});

/*
 * THE ALERT CARD: four zones, every fact once.
 *
 * It was a paragraph followed by a run of key-value pairs, and the two said
 * the same thing — entry, stop, target and the share count appeared in the
 * sentence AND again underneath. Nine pairs wrapped wherever the width ran
 * out, so "lag -31s EARLY" sat beside the send button, and the line that
 * mattered most (the stop does not trail) was a clause in mid-sentence.
 */
describe('the alert card', () => {
  const card = script.slice(script.indexOf('function setupFire('),
                            script.indexOf('function orderChips('));

  test('levels are three fixed columns, not a sentence', () => {
    // The eye lands in the same place on every card instead of reading prose
    // to find the stop.
    for (const k of ['entry', 'stop', 'target', 'risk/sh']) expect(card).toContain(`>${k}<`);
    expect(card).toContain('class="lv"');
    expect(html).toMatch(/\.lv \{[^}]*display:grid/);
  });

  test('the sentence is not printed beside the numbers it repeats', () => {
    /*
     * f.detail stays on the fire because a push notification shows it on a
     * locked phone, where there is no card and no zones. Rendering it here as
     * well is exactly the duplication this replaced — so it appears only on
     * the no-trade branch, where the sentence IS the content.
     */
    const withTrade = card.slice(card.indexOf('const n = (v, d = 2)'));
    expect(withTrade).not.toContain('esc(f.detail');
    expect(card).toContain('esc(f.detail || \'\')');   // the "nothing qualified" branch
  });

  test('warnings are their own block, not a clause', () => {
    expect(card).toContain('class="su-warns"');
    expect(card).toContain("(f.detail || '').match(/NOTE: (.+?)$/)");
  });

  test('actions sit in a row of their own', () => {
    // They used to be inline with the numbers and read as another field.
    expect(card).toContain('class="su-acts"');
    const acts = card.slice(card.indexOf('class="su-acts"'));
    expect(acts.slice(0, 400)).not.toContain('lv-v');
  });

  test('the diagnostics fold — they are read after the fact', () => {
    expect(card).toContain('<details class="why"><summary>detail</summary>');
    for (const k of ['extension', 'feed', 'lag', 'bar']) expect(card).toContain(`'${k}'`);
  });
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

test('an account is one fraction of the standard, and says what it may do', () => {
  /*
   * Sizing every account off one balance is how a $5,000 account gets an order
   * meant for $20,000 — refused by the broker, at 09:36. And the mode is on the
   * ACCOUNT, not the setup: the arrangement that matters most is the same
   * strategy watched by hand in one account and automatic in another, which a
   * flag on the strategy cannot express at all.
   */
  const at = script.indexOf('function paintDests(');
  const body = script.slice(at, script.indexOf('async function toggleDestSetup', at));
  for (const cls of ['d-ratio', 'd-mode', 'd-setups']) expect(body).toContain(cls);
  expect(script).toContain("['d-ratio', 'ratio']");
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

test('an account shows what its ratio MEANS in money and in shares', () => {
  /*
   * "0.05" is the setting. "$5,000 of the $100,000 standard — a 240-share
   * signal becomes 12" is what tells you the setting is wrong, and it is the
   * one a person can actually check. The arithmetic must mirror risk.scaleTo
   * or the row is a second opinion about the same number.
   */
  const at = script.indexOf('function sizeNote(d)');
  const body = script.slice(at, script.indexOf('\n}\n', at));
  expect(body).toContain('r.accountSize * ratio');
  expect(body).toContain('r.riskPerTrade * ratio');
  expect(body).toContain('Math.floor(240 * ratio)');
});

test('the settings tab states the pipeline before the controls', () => {
  // The tab was a pile of controls with no order to them, so you could not
  // tell which setting was upstream of the number you were unhappy with.
  const pane = markup.slice(markup.indexOf('<div class="pane" data-t="settings"'));
  expect(pane.indexOf('class="flow"')).toBeLessThan(pane.indexOf('1 · Standard account'));
  const flow = pane.slice(pane.indexOf('class="flow"'), pane.indexOf('</div>\n\n<!-- ── 1'));
  expect([...flow.matchAll(/flow-step/g)]).toHaveLength(4);
  // …in the order the code runs.
  expect(flow.indexOf('standard account')).toBeLessThan(flow.indexOf('algo switch'));
  expect(flow.indexOf('algo switch')).toBeLessThan(flow.indexOf('broker account'));
  expect(flow.indexOf('broker account')).toBeLessThan(flow.indexOf('auto'));
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

/*
 * THE DESIGN SYSTEM LIVES IN ONE FILE.
 *
 * Four pages had four palettes, three type scales and two ideas about what a
 * tab looks like, and the result was an app that felt like four apps. The
 * screener is the page that got this right — measured contrast, a colour
 * language with one meaning per hue, a sunlight mode — so its system was
 * lifted into public/desk.css and the other pages link it.
 *
 * What is checked here is that they link it and do NOT keep a private copy,
 * because a private copy is exactly how they came apart the first time.
 */
const desk = fs.readFileSync(path.join(__dirname, '..', 'public', 'desk.css'), 'utf8');

test('the page links the shared system and defines no palette of its own', () => {
  expect(html).toContain('href="/desk.css"');
  expect(html).toContain('src="/desk.js"');
  expect(html).not.toContain(':root {');
});

test('the system carries the screener\'s measured contrast, not a new palette', () => {
  // Every text colour in the screener carries its ratio against the
  // background. --text3 was 2.9:1 once — under the 4.5:1 minimum, and the
  // most-used colour on the page.
  expect(desk).toMatch(/--text3:\s*#868ea1/);
  expect(desk).toContain('5.8:1');
  expect(desk).toContain('--m-up');
  expect(desk).toContain('--m-model');
});

test('sunlight mode reaches every page, and is the default', () => {
  // A dark theme outdoors is a mirror. The screener has treated high contrast
  // as the normal case for a while; the other pages had no way out at all.
  expect(desk).toContain('body.sunlight');
  expect(html).toContain('id="sun-btn"');
  const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'desk.js'), 'utf8');
  expect(js).toContain("localStorage.getItem('sunlight') !== '0'");
});

test('sizes and gaps come from a scale, not from guesses', () => {
  for (const v of ['--f-xs', '--f-sm', '--f-md', '--f-lg', '--f-xl',
                   '--s1', '--s2', '--s3', '--s4', '--s5']) {
    expect({ token: v, defined: desk.includes(v) }).toEqual({ token: v, defined: true });
  }
});

test('long explanations fold behind a why, from the shared script', () => {
  const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'desk.js'), 'utf8');
  expect(js).toContain('function deskFoldWhy(');
  expect(js).toContain('DESK_WHY_LIMIT');
  expect(desk).toContain('details.why');
  // Only explanations. Warnings, counts and errors are never folded.
  expect(js).toContain('.risk-hint');
  expect(js).not.toContain('.warn');
});

test('the tabs are the screener\'s underlines, not filled pills', () => {
  // A filled pill at 390px is a button competing with the buttons below it.
  const at = html.indexOf('.tb {');
  const rule = html.slice(at, html.indexOf('}', at));
  expect(rule).toContain('border-bottom:2px solid transparent');
  expect(rule).toContain('background:none');
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

/*
 * THE SETUP CARD: said once, and folded when it is not urgent.
 *
 * It was a wall. A setup is usually a long AND a short, and readiness reports
 * each side, so the same warning printed twice — "short: leg 1 stop follows an
 * indicator…" then "long: leg 1 stop follows an indicator…" — and again for
 * the runner. Four lines carrying two facts, full width, one colour, reading
 * as a paragraph. Meanwhile "ranked by vwap_extension, top 6" appeared as a
 * bullet AND in the meta line underneath.
 */
describe('the setup card', () => {
  const warn = script.slice(script.indexOf('function setupWarnings(s)'),
                            script.indexOf('\n}\n', script.indexOf('function setupWarnings(s)')));

  test('the same warning on both sides is printed once, unprefixed', () => {
    expect(warn).toContain('/^(short|long):\\s*(.+)$/i');
    // Both sides, or neither named → the fact is about the setup, so no prefix.
    expect(warn).toContain('sides.size === 0 || sides.size === 2');
    // …and the prefix comes back only when the two sides genuinely differ,
    // which is the case actually worth seeing.
    expect(warn).toContain('${[...sides][0]} only:');
  });

  test('two warnings show and the rest fold', () => {
    // A setup with six warnings has a problem a longer card does not help with.
    expect(warn).toContain('lines.slice(0, 2)');
    expect(warn).toContain('lines.slice(2)');
  });

  test('what the setup IS folds; how it is DEPLOYED does not', () => {
    /*
     * The bullets are read once, on the day it is set up. The meta line is the
     * deployment and changes. Ranking belongs to the deployment — it used to be
     * printed in both.
     */
    // Located by the MARKUP it produces, not by the name of the variable it
    // maps over: that name changed when the list started ordering by stage,
    // and pinning it made three tests slice an empty string and fail on a
    // change that touched none of what they check.
    const at = script.indexOf('<div class="setup-def');
    const card = script.slice(at, script.indexOf('paintAlgoState();', at));
    expect(card).toContain('<summary>what this setup does</summary>');
    expect(card).toContain("['ranked by'");
    // the bullets no longer sit open above the meta line
    expect(card).not.toMatch(/<ul class="st-rules">\$\{\(s\.describe/);
  });

  test('the deployment facts are labelled values, not a run-on line', () => {
    // Located by the MARKUP it produces, not by the name of the variable it
    // maps over: that name changed when the list started ordering by stage,
    // and pinning it made three tests slice an empty string and fail on a
    // change that touched none of what they check.
    const at = script.indexOf('<div class="setup-def');
    const card = script.slice(at, script.indexOf('paintAlgoState();', at));
    for (const k of ['ranked by', 'feed', 'extra scan', 'max/day']) {
      expect(card).toContain(`'${k}'`);
    }
    expect(card).toContain('class="dg-i"');
  });

  test('"orders" is a state with the fix behind a tap, not a sentence', () => {
    // It was a status, an instruction and a location in one grey sentence.
    const at = script.indexOf('function accountChips(');
    const body = script.slice(at, script.indexOf('\n}\n', at));
    expect(body).toContain('<span class="bchip">alert only</span>');
    expect(body).toContain('<summary>how to trade it</summary>');
  });
});

test('no stylesheet rule is silently dropped by a bad selector', () => {
  /*
   * This is here because it happened. A stray quote left by a bad edit sat in
   * front of `.st-meta`, and a browser drops a rule with an invalid selector
   * without a word. The symptom was every value on the setup card running into
   * the next — "top 6feed yahooextra scan" — which reads like a
   * template-string bug and is not one.
   */
  const css = html.slice(html.indexOf('<style>') + 7, html.indexOf('</style>'));
  const bad = css.split('\n')
    .map((l, i) => [i + 1, l])
    // A line starting with a quote is never a valid selector. Comment bodies
    // legitimately do, so those are skipped.
    .filter(([, l]) => /^\s*"/.test(l) && !/^\s*"[^"]*"[.,;]?\s*(rather|than|\*\/)/.test(l))
    .filter(([, l]) => !l.includes('*/'));
  expect(bad).toEqual([]);
});
