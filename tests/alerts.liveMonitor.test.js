/*
 * LIVE IS A MONITOR: WHAT IS HELD, WHAT IS NEXT, WHAT HAPPENED — AT A GLANCE.
 *
 * Asked for 2026-09-24: "Live should be like a live monitor screen for me,
 * the trader." Run, not grepped: the page's own functions draw these.
 */
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'alerts.html'), 'utf8');
const script = (html.match(/<script>([\s\S]*?)<\/script>/) || [])[1] || '';
const lift = (name) => {
  const from = script.indexOf(`function ${name}(`);
  if (from < 0) throw new Error(`alerts.html no longer defines ${name}()`);
  return script.slice(from, script.indexOf('\n}', from) + 2);
};

function run(body, env) {
  const els = { upnext: { innerHTML: '' }, 'next-note': { textContent: '' },
                timeline: { innerHTML: '' }, 'tl-note': { textContent: '' } };
  // eslint-disable-next-line no-new-func
  new Function('els', 'env', `
    const document = { getElementById: (id) => els[id] || null };
    const SETUPS = env.setups || [], LIVE_RUNS = env.runs || [];
    const nowMinutesET = () => env.now;
    ${lift('esc')}
    ${lift('toMinutes')}
    ${lift('slTime')}
    ${lift('paintUpNext')}
    ${lift('paintTimeline')}
    ${body}`)(els, env);
  return els;
}

const OR = { id: 'OR@09:35', name: 'OR + VWAP 09:35', decisionTime: '09:35', tools: ['T2'],
             accounts: [{ mode: 'auto' }] };
const TEST = { id: 'Test@09:30', name: 'Test', decisionTime: '09:30', windowEnd: '11:30',
               watch: true, tools: ['T11'], accounts: [{ mode: 'auto' }] };

describe('coming up', () => {
  test('before the minute: a countdown, in time order', () => {
    const e = run('paintUpNext()', { now: 9 * 60 + 10, setups: [OR, TEST] });
    const rows = e.upnext.innerHTML.split('lv-row').slice(1);
    expect(rows[0]).toMatch(/09:30–11:30[\s\S]*Test[\s\S]*in 20 min/);
    expect(rows[1]).toMatch(/09:35[\s\S]*OR \+ VWAP 09:35[\s\S]*T2 · auto[\s\S]*in 25 min/);
  });
  test('inside a watch window: watching now', () => {
    const e = run('paintUpNext()', { now: 10 * 60, setups: [TEST] });
    expect(e.upnext.innerHTML).toMatch(/lv-row now[\s\S]*watching now/);
  });
  test('after it ran: runs and picks; a failed run is marked', () => {
    const e = run('paintUpNext()', { now: 10 * 60, setups: [OR], runs: [
      { setupId: 'OR@09:35', ok: true, picks: [{}, {}] },
      { setupId: 'OR@09:35', ok: false, picks: [] }] });
    expect(e.upnext.innerHTML).toMatch(/lv-row missed[\s\S]*2 runs · 2 picks · 1 failed/);
  });
  test('past its minute with no record at all: said, not left blank', () => {
    const e = run('paintUpNext()', { now: 10 * 60, setups: [OR], runs: [] });
    expect(e.upnext.innerHTML).toMatch(/no decision recorded/);
  });
  test('a rehearsal does not count as the decision', () => {
    const e = run('paintUpNext()', { now: 10 * 60, setups: [OR], runs: [{ setupId: 'OR@09:35', ok: true, rehearsal: true }] });
    expect(e.upnext.innerHTML).toMatch(/no decision recorded/);
  });
});

describe('today', () => {
  const T = Date.parse('2026-09-24T13:35:20Z');
  const D = { ok: true, counts: { error: 1 }, lines: [
    { t: T, level: 'info', msg: 'OR decided on 09:34 in 8 s' },
    { t: T + 5000, level: 'debug', msg: 'manager: holding 1' },
    { t: T + 9000, level: 'error', msg: 'AAA: order FAILED — 422' }] };
  test('newest first, one line each, routine left out, errors marked', () => {
    const e = run('paintTimeline(env.d)', { d: D });
    const rows = e.timeline.innerHTML.split('lv-row').slice(1);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatch(/^ error[\s\S]*09:35[\s\S]*AAA: order FAILED/);
    expect(rows[1]).toMatch(/OR decided/);
    expect(e['tl-note'].textContent).toMatch(/1 error · full detail on Review/);
  });
  test('an unreadable day says so', () => {
    expect(run('paintTimeline(env.d)', { d: { ok: false, error: 'down' } }).timeline.innerHTML)
      .toMatch(/Could not read today: down/);
  });
});
