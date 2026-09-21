/*
 * AN EMPTY FEED IS TWO COMPLETELY DIFFERENT DAYS.
 *
 * "Nothing has fired today." was the answer whether the desk had watched all
 * morning and found nothing, or had been switched off since Tuesday. Those are
 * opposite facts wearing the same sentence, and the second one is the whole
 * reason anybody would look at an empty feed at all.
 *
 * A FIELD THAT SAYS THE SAME THING WHATEVER HAPPENED is not a field. So the
 * armed state is read — from the same BROKER object the status strip is
 * painted from, so the two cannot disagree — and the line says which day this
 * is. These run it in each of the states it has to tell apart, because the
 * failure is not that the page looks wrong: it is that it looks fine and
 * reassures you about a desk that was never on.
 */

const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'alerts.html'), 'utf8');
const script = (html.match(/<script>([\s\S]*?)<\/script>/) || [])[1] || '';

function loadEmptyFeed(broker) {
  const from = script.indexOf('function emptyFeed()');
  if (from < 0) {
    throw new Error('public/alerts.html no longer says WHY the feed is empty — '
      + '"nothing fired" and "the desk was off" were one sentence');
  }
  const to = script.indexOf('\n}', from) + 2;
  // eslint-disable-next-line no-new-func
  return new Function('BROKER', 'esc',
    `${script.slice(from, to)}; return emptyFeed;`)(broker, s => String(s == null ? '' : s));
}

const withAuto = { broker: { enabled: true, armed: true, destinations: [
  { enabled: true, hasWebhook: true, mode: 'auto', setups: ['test'] }] } };

describe('an empty feed says which kind of empty', () => {
  test('the desk was OFF — nothing could have been sent', () => {
    const out = loadEmptyFeed({ broker: { enabled: false, armed: false } })();
    expect(out).toContain('OFF');
    expect(out).toContain('nothing would have been sent');
  });

  test('the desk was on but not armed', () => {
    // Two different switches, and only one of them is the one you forgot.
    const out = loadEmptyFeed({ broker: { enabled: true, armed: false } })();
    expect(out).toContain('not armed');
  });

  test('armed and watching — this is the quiet morning', () => {
    const out = loadEmptyFeed(withAuto)();
    expect(out).toContain('armed and watching');
    expect(out).toContain('no setup has produced a signal');
  });

  test('armed, but no account would have acted on it', () => {
    /*
     * The trap this exists for. The desk is armed, the strip is green, and
     * nothing can actually be placed because no account is on auto with a
     * setup — a day that looks identical to a quiet one from the feed.
     */
    const armedNoAuto = { broker: { enabled: true, armed: true, destinations: [
      { enabled: true, hasWebhook: true, mode: 'hand', setups: ['test'] }] } };
    const out = loadEmptyFeed(armedNoAuto)();
    expect(out).toContain('no account is on auto');
  });

  test('an account on auto with NO setup does not count as armed-and-watching', () => {
    // It is on auto and it will never be asked to do anything.
    const noSetups = { broker: { enabled: true, armed: true, destinations: [
      { enabled: true, hasWebhook: true, mode: 'auto', setups: [] }] } };
    expect(loadEmptyFeed(noSetups)()).toContain('no account is on auto');
  });

  test('before the broker has answered, it says so rather than guessing', () => {
    /*
     * AN ERROR IS NEVER A ZERO, and an unknown is never an "all clear".
     * loadFires() runs before /api/broker comes back, so this is the state the
     * page is genuinely in for the first moment — and a wrong reassurance here
     * costs a morning.
     */
    for (const b of [null, undefined, {}]) {
      const out = loadEmptyFeed(b)();
      expect({ b: JSON.stringify(b) || 'undefined', says: out.includes('has not said') })
        .toEqual({ b: JSON.stringify(b) || 'undefined', says: true });
    }
  });

  test('every state gives a different line', () => {
    // THE PROPERTY, in one assertion: four states, four answers. Under the old
    // sentence all four of these were identical.
    const lines = [
      null,
      { broker: { enabled: false } },
      { broker: { enabled: true, armed: false } },
      { broker: { enabled: true, armed: true, destinations: [] } },
      withAuto,
    ].map(b => loadEmptyFeed(b)());
    expect(new Set(lines).size).toBe(lines.length);
  });

  test('it is the empty-state shape, not a grey caption', () => {
    const out = loadEmptyFeed(withAuto)();
    expect(out).toContain('class="empty none"');
    expect(out).toMatch(/<b>No alerts today<\/b>/);
  });
});

test('the feed is repainted when the broker finally answers', () => {
  /*
   * Otherwise the first paint's "has not said whether it is armed yet" would
   * sit there until the next poll — thirty seconds of the one question the
   * reader came to ask going unanswered, while the strip directly above it
   * already knew.
   *
   * ONLY WHEN IT IS EMPTY. Rewriting a feed that has alerts in it from here
   * would throw away the rows the loader just drew.
   */
  const fn = script.slice(script.indexOf('function paintAlgoState()'),
                          script.indexOf('\n}', script.indexOf('function paintAlgoState()')));
  expect(fn).toContain("querySelector('.empty.none')");
  expect(fn).toContain('emptyFeed()');
});

/*
 * THE VISUAL SYSTEM, in the two places it is load-bearing rather than
 * decorative.
 */
describe('the page has one shape for a fact and one for a section', () => {
  const css = html.slice(html.indexOf('<style>'), html.indexOf('</style>'));
  const desk = fs.readFileSync(path.join(__dirname, '..', 'public', 'desk.css'), 'utf8');

  test('a stat is two across on a phone, with the value as the big thing', () => {
    /*
     * It was five or six cells to a row at 112px each: a 19px number over a
     * 9.5px label, in a box barely wider than the label. The value is what is
     * being read and it should be what you see.
     */
    expect(desk).toContain('flex:1 1 calc(50% - 1px)');
    const v = desk.slice(desk.indexOf('.strip-v {'), desk.indexOf('}', desk.indexOf('.strip-v {')));
    const size = Number(/font-size:(\d+)px/.exec(v)[1]);
    expect({ size, big: size >= 24 }).toEqual({ size, big: true });
  });

  test('a section heading is a kicker, and its line is at reading size', () => {
    /*
     * Both were the same 11.5px grey, with the line pushed to the right-hand
     * end of the row where it read as a status rather than as the explanation
     * of the heading it belongs to. A sentence nobody can tell from a label is
     * a sentence nobody reads.
     */
    const kick = css.slice(css.indexOf('.sec > span:first-child {'),
                           css.indexOf('}', css.indexOf('.sec > span:first-child {')));
    expect(kick).toContain('color:var(--accent)');
    expect(kick).toContain('text-transform:uppercase');
    const line = css.slice(css.indexOf('.sec > span:not(:first-child)'),
                           css.indexOf('}', css.indexOf('.sec > span:not(:first-child)')));
    expect(line).toContain('font-size:var(--f-md)');
    expect(line).toContain('color:var(--text)');
    expect(line).not.toContain('text-align:right');
  });
});
