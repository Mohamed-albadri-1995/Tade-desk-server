/*
 * THE BUTTON ON A CARD ACTS ON THAT CARD'S SETUP.
 *
 * The setups tab draws its cards sorted — ready first, then by decision time —
 * and every card button passes its position: editSetup(i), saveSetup(i),
 * setSetupTool(i). Those read SETUPS[i], and SETUPS was left in the order the
 * API sent. So wherever the sort moved a setup, "edit filter" opened another
 * setup's settings and Save wrote them onto it.
 *
 * Run, not grepped: the real loadSetups() draws a list the sort reorders, and
 * each card's own index must find the card's own setup.
 */
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'alerts.html'), 'utf8');
const script = (html.match(/<script>([\s\S]*?)<\/script>/) || [])[1] || '';

function lift(name) {
  const from = script.indexOf(`function ${name}(`);
  if (from < 0) throw new Error(`alerts.html no longer defines ${name}()`);
  const start = script.lastIndexOf('\n', from) + 1;         // keep `async`
  return script.slice(start, script.indexOf('\n}', from) + 2);
}

function page(apiSetups) {
  const out = { innerHTML: '' };
  const src = `
    let SETUPS = [], SETUP_FIELDS = [], SETUP_OPS = [], DECISIONS = [], RISK = null;
    const document = { getElementById: (id) => (id === 'setups' ? out : null) };
    const fetch = async () => ({ json: async () => ({ ok: true, setups: apiSetups }) });
    const ensureTools = async () => {};
    const paintNextDecision = () => {}, paintAlgoState = () => {},
          deskFoldWhy = () => {}, loadParity = () => {};
    const accountChips = () => '', toolChoices = () => [], setupWarnings = () => '',
          feedShort = () => '';
    ${lift('esc')}
    ${lift('cautionFor')}
    ${lift('loadSetups')}
    return { loadSetups, setups: () => SETUPS };`;
  // eslint-disable-next-line no-new-func
  return { out, ...new Function('out', 'apiSetups', src)(out, apiSetups) };
}

test('each card\'s edit button finds its own setup, after the sort', async () => {
  // In API order: a dev setup at 09:30 first, the ready one at 10:00 second.
  // The sort puts ready first, so the two swap.
  const api = [
    { id: 'dev@09:30', name: 'Dev thing', stage: 'development', decisionTime: '09:30' },
    { id: 'or@10:00', name: 'OR ready', stage: 'ready', decisionTime: '10:00' },
  ];
  const p = page(api);
  await p.loadSetups();
  const cards = p.out.innerHTML.split('class="setup-def').slice(1);
  expect(cards).toHaveLength(2);
  for (const card of cards) {
    const name = /<span class="t">([^<]+)<\/span>/.exec(card)[1];
    const i = Number(/editSetup\((\d+)\)/.exec(card)[1]);
    expect({ card: name, edits: p.setups()[i].name }).toEqual({ card: name, edits: name });
  }
});

/*
 * THE LIVE-VS-BACKTEST BADGE. "Could not check" must be grey and say so —
 * a check that did not run is never painted as a match.
 */
describe('paintParity', () => {
  function paint(d) {
    const els = { 'su-par-0': { className: '', textContent: '' },
                  'par-body-0': { innerHTML: '' } };
    const src = `
      const document = { getElementById: (id) => els[id] || null };
      ${lift('esc')}
      ${script.slice(script.indexOf('const PAR_WORD'), script.indexOf(';', script.indexOf('const PAR_WORD')) + 1)}
      ${lift('paintParity')}
      paintParity(0, d);`;
    // eslint-disable-next-line no-new-func
    new Function('els', 'd', src)(els, d);
    return { pill: els['su-par-0'], body: els['par-body-0'].innerHTML };
  }

  test('a failed check is grey "not checked", with the reason', () => {
    const r = paint({ ok: false, verdict: 'unknown', error: 'qp did not answer' });
    expect(r.pill.className).toBe('su-par unknown');
    expect(r.pill.textContent).toMatch(/not checked/);
    expect(r.body).toMatch(/qp did not answer/);
  });

  test('the run can be chosen: most trades by default, a pinned one selected', () => {
    const base = { ok: true, verdict: 'match', setup: 'OR@09:35', rules: [], settings: [],
      backtest: { id: 332, name: 'bt', trades: 171, created_at: 1 },
      runs: [{ id: 363, start: '2026-09-15', end: '2026-09-15', trades: 3 },
             { id: 332, start: '2026-07-30', end: '2026-08-20', trades: 171 }] };
    let r = paint({ ...base, pickedBy: 'most trades' });
    expect(r.body).toMatch(/<option value="" selected>the run with the most trades/);
    expect(r.body).toMatch(/#332 · 2026-07-30 → 2026-08-20 · 171 trades/);
    expect(r.body).toMatch(/setParityRun\(0, 'OR@09:35', this.value\)/);
    r = paint({ ...base, pickedBy: 'pinned' });
    expect(r.body).toMatch(/<option value="332" selected>/);
    expect(r.body).not.toMatch(/<option value="" selected>/);
  });

  test('a changed rule is listed with both values', () => {
    const r = paint({ ok: true, verdict: 'differ',
      backtest: { id: 7, name: 'bt', trades: 80, win_rate: 51, avg_return_pct: 0.2,
                  start: '2026-01-01', end: '2026-06-01', created_at: 1 },
      rules: [{ name: 'OR (Long)', frozen: true,
                changed: [{ path: 'risk.sl.value', then: '0.6', now: '1.0' }] }],
      settings: [{ what: 'decision bar', live: '09:34', backtest: '09:35', status: 'differ' }] });
    expect(r.pill.className).toBe('su-par differ');
    expect(r.body).toMatch(/risk\.sl\.value: 0\.6 → 1\.0/);
    expect(r.body).toMatch(/<tr class="differ"/);
    expect(r.body).toMatch(/80 trades · 51% win/);
  });
});
