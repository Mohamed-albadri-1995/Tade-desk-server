/*
 * How often the page looks, and when.
 *
 * The page polls fast around a decision because an alert is worth acting on
 * inside the minute it arrives. That worked while every setup was a clock: two
 * minutes either side of a known time, look every three seconds.
 *
 * A watch setup has no known time. `PML breakout` is live from 09:40 to 10:10
 * and fires on whichever bar the level breaks — so the old rule polled fast at
 * 09:40, went to sixty seconds at 09:43, and was still on sixty seconds when
 * the thing it was waiting for happened at 09:57. Fast around the opening
 * minute of a window is the same as not fast at all.
 *
 * These run the page's OWN functions rather than restating the rule: the four
 * poll-cadence functions are lifted out of the inline script and evaluated with
 * the clock stubbed, so a change to the page changes the test's answer.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const html = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'alerts.html'), 'utf8');
const script = (html.match(/<script>([\s\S]*?)<\/script>/) || [])[1] || '';

/** Lift one top-level `function NAME(...) { ... }` out of the page, by brace depth. */
function lift(name) {
  const at = script.indexOf(`function ${name}(`);
  if (at < 0) throw new Error(`${name} is not on the page`);
  let depth = 0;
  for (let i = script.indexOf('{', at); i < script.length; i++) {
    if (script[i] === '{') depth++;
    else if (script[i] === '}' && --depth === 0) return script.slice(at, i + 1);
  }
  throw new Error(`${name} is unbalanced`);
}

/*
 * The page in a jar: its real functions, a clock we control, and enough stubs
 * that schedulePoll can run without a DOM. `nowMinutesET` is redefined AFTER
 * the page's copy so the stub wins — everything else is the page's own code.
 */
function pageAt(hhmm, decisions) {
  const ctx = {
    DECISIONS: decisions,
    NOW: hhmm,
    loadFires() {},
    clearTimeout() {},
    delay: null,
    setTimeout(fn, ms) { ctx.delay = ms; return 1; },
  };
  vm.createContext(ctx);
  vm.runInContext([
    'let pollTimer = null;',
    lift('toMinutes'),
    lift('decisionWindowOpen'),
    lift('minutesToNextDecision'),
    lift('schedulePoll'),
    // The clock, replaced. Intl in a vm would just be the real time.
    'function nowMinutesET() { const [h,m] = NOW.split(":").map(Number); return h*60+m; }',
  ].join('\n'), ctx);
  vm.runInContext('schedulePoll()', ctx);
  return ctx;
}

const CLOCK = [{ from: '10:00', to: '10:00' }];
const WATCH = [{ from: '09:40', to: '10:10' }];

describe('a clock setup keeps the cadence it always had', () => {
  test('fast on the minute, and either side of it', () => {
    expect(pageAt('10:00', CLOCK).delay).toBe(3000);
    expect(pageAt('09:59', CLOCK).delay).toBe(3000);
    expect(pageAt('10:02', CLOCK).delay).toBe(3000);
  });
  test('middling in the run-up', () => {
    expect(pageAt('09:52', CLOCK).delay).toBe(15000);
  });
  test('slow the rest of the day', () => {
    expect(pageAt('13:30', CLOCK).delay).toBe(60000);
  });
});

describe('a watch setup polls fast for the whole window', () => {
  test('at the open', () => {
    expect(pageAt('09:40', WATCH).delay).toBe(3000);
  });
  /* The bug this exists for: the middle of the window used to be 60000. */
  test('in the middle, where the old rule had gone slow', () => {
    expect(pageAt('09:57', WATCH).delay).toBe(3000);
    expect(pageAt('10:05', WATCH).delay).toBe(3000);
  });
  test('at the close, and a moment after it', () => {
    expect(pageAt('10:10', WATCH).delay).toBe(3000);
    expect(pageAt('10:12', WATCH).delay).toBe(3000);
  });
  test('and not before it opens or long after it shuts', () => {
    expect(pageAt('09:20', WATCH).delay).toBe(60000);
    expect(pageAt('11:00', WATCH).delay).toBe(60000);
  });
});

describe('inside a window there is nothing to count down to', () => {
  test('the wait is zero, not a negative number of minutes', () => {
    const ctx = pageAt('09:57', WATCH);
    expect(vm.runInContext('minutesToNextDecision()', ctx)).toBe(0);
  });
  test('and the window is reported open', () => {
    expect(vm.runInContext('decisionWindowOpen()', pageAt('09:57', WATCH))).toBe(true);
    expect(vm.runInContext('decisionWindowOpen()', pageAt('09:57', CLOCK))).toBe(false);
  });
});

describe('the page builds windows, not bare times', () => {
  test('a setup without windowEnd becomes a window one minute wide', () => {
    expect(script).toMatch(/to: s\.windowEnd \|\| s\.decisionTime/);
  });
  test('and the setup card shows the whole window when there is one', () => {
    expect(script).toMatch(/s\.watch[\s\S]{0,120}windowEnd/);
  });
});
