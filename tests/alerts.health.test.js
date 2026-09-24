/*
 * THE HEALTH VIEW SAYS WHAT IS BROKEN, AND NEVER CALLS AN UNCHECKED PART OK.
 *
 * Each rule is run against the exact state that went wrong on this desk:
 * a crash-looping qp, a manager pass that throws every minute, a 09:35
 * decision that used 27.5 of its 30 seconds, a flatten that was switched off.
 */
const H = require('../src/alerts/health');

const NOW = Date.parse('2026-09-24T14:00:00Z');              // 10:00 ET
const MIN = 60 * 1000;

describe('processes', () => {
  const p = (name, status, uptimeMin, restarts) => ({
    name, pm2_env: { status, pm_uptime: NOW - uptimeMin * MIN, restart_time: restarts },
    monit: { memory: 100 * 1048576, cpu: 3 } });

  test('a stopped process is bad', () => {
    const [r] = H.processes({ list: [p('qp', 'stopped', 0, 0)] }, NOW);
    expect(r.status).toBe('bad');
  });
  test('a restart in the last five minutes is a warning — crash loop', () => {
    const [r] = H.processes({ list: [p('qp', 'online', 1, 113854)] }, NOW);
    expect(r.status).toBe('warn');
    expect(r.detail).toMatch(/113854 restart/);
  });
  test('restarts long ago are history, not a fault', () => {
    expect(H.processes({ list: [p('tool-T1', 'online', 600, 492)] }, NOW)[0].status).toBe('ok');
  });
  test('pm2 unreadable is unknown with the reason, never ok', () => {
    const [r] = H.processes({ error: 'pm2 is not on this PATH' }, NOW);
    expect(r.status).toBeNull();
    expect(r.detail).toMatch(/PATH/);
  });
});

describe('the manager', () => {
  const beat = (o) => ({ startedAt: NOW - 60 * MIN, intervalMs: MIN, lastTick: NOW - 30000,
                         lastOk: NOW - 30000, passes: 10, skippedBusy: 0, ...o });
  test('ticking and passing is ok', () => {
    expect(H.managerItem(beat(), NOW).status).toBe('ok');
  });
  test('a last pass that threw is bad, with the error', () => {
    const r = H.managerItem(beat({ lastOk: NOW - 10 * MIN, lastErrorAt: NOW - 20000,
                                   lastError: 'ECONNREFUSED' }), NOW);
    expect(r.status).toBe('bad');
    expect(r.detail).toMatch(/ECONNREFUSED/);
  });
  test('no tick for minutes is bad — nothing is being managed', () => {
    expect(H.managerItem(beat({ lastTick: NOW - 10 * MIN }), NOW).status).toBe('bad');
  });
  test('not started is unknown, not ok', () => {
    expect(H.managerItem({ startedAt: null }, NOW).status).toBeNull();
  });
});

describe('the flatten', () => {
  const beat = { startedAt: NOW - 60 * MIN, intervalMs: 30000, lastTick: NOW - 10000 };
  const cfg = { flatten: true, armed: true, flattenAt: '15:50' };
  test('switched off is a warning, said in capitals', () => {
    const r = H.flattenItem(beat, { ...cfg, flatten: false }, NOW, '2026-09-24', '10:00');
    expect(r.status).toBe('warn');
    expect(r.detail).toMatch(/SWITCHED OFF/);
  });
  test('before the minute, it is waiting', () => {
    const r = H.flattenItem(beat, cfg, NOW, '2026-09-24', '10:00');
    expect(r).toMatchObject({ status: 'ok' });
    expect(r.detail).toMatch(/waiting for 15:50/);
  });
  test('past the minute with no run today is a warning', () => {
    expect(H.flattenItem(beat, cfg, NOW, '2026-09-24', '16:05').status).toBe('warn');
  });
  test('past the minute and run today is ok', () => {
    const b = { ...beat, lastRanAt: NOW - MIN, lastRanDay: '2026-09-24' };
    expect(H.flattenItem(b, cfg, NOW, '2026-09-24', '16:05').status).toBe('ok');
  });
});

describe('today\'s decisions', () => {
  test('27.5 s of a 30 s budget is a warning — the 09-22 morning', () => {
    const [r] = H.decisionItems([{ setup: 'OR + VWAP 09:35', ok: true, ms: 27569 }]);
    expect(r.status).toBe('warn');
    expect(r.detail).toMatch(/27\.6 s of the 30 s budget \(92%\)/);
  });
  test('a failed run is bad, with its error', () => {
    const [r] = H.decisionItems([{ setup: 'X', ok: false, error: 'timeout of 30000ms exceeded' }]);
    expect(r.status).toBe('bad');
    expect(r.detail).toMatch(/timeout/);
  });
  test('rehearsals do not count as the day\'s decisions', () => {
    const [r] = H.decisionItems([{ setup: 'X', ok: false, rehearsal: true }]);
    expect(r.status).toBeNull();
  });
});

describe('the whole report', () => {
  const deps = (o = {}) => ({
    now: () => NOW, clock: (() => { let t = 0; return () => (t += 50); })(),
    tools: [{ id: 'T11', name: 'Setups', port: 3100 }, { id: 'T10', enabled: false, port: 3090 }],
    ping: async () => ({ ok: true }),
    pm2: async () => ({ list: [] }),
    qpHealth: async () => ({ ok: true }),
    brokerSettings: () => ({ flatten: true, armed: true, flattenAt: '15:50' }),
    nowET: '10:00',
    managerBeat: () => ({ startedAt: NOW - MIN, intervalMs: MIN, lastTick: NOW, lastOk: NOW, passes: 1 }),
    flattenBeat: () => ({ startedAt: NOW - MIN, intervalMs: 30000, lastTick: NOW }),
    runs: () => [{ setup: 'OR', ok: true, ms: 9000 }],
    ...o,
  });
  test('all working reads ok, and a stopped tool is not pinged', async () => {
    const r = await H.report(deps());
    expect(r.status).toBe('ok');
    const ids = r.groups.flatMap(g => g.items.map(i => i.id));
    expect(ids).toContain('tool:T11');
    expect(ids).not.toContain('tool:T10');
  });
  test('qp down makes the whole desk bad', async () => {
    const r = await H.report(deps({ qpHealth: async () => ({ ok: false, error: 'ECONNREFUSED' }) }));
    expect(r.status).toBe('bad');
    expect(r.counts.bad).toBe(1);
  });
  test('one unchecked part is "unknown", never "ok"', async () => {
    const r = await H.report(deps({ runs: () => [] }));
    expect(r.status).toBe('unknown');
  });
});

/* ── the page paints it, and grey is never green ─────────────────────────── */
describe('paintHealth on the Algo page', () => {
  const fs = require('fs');
  const path = require('path');
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'alerts.html'), 'utf8');
  const script = (html.match(/<script>([\s\S]*?)<\/script>/) || [])[1] || '';
  const lift = (name) => {
    const from = script.indexOf(`function ${name}(`);
    return script.slice(from, script.indexOf('\n}', from) + 2);
  };
  const block = (start) => {
    const i = script.indexOf(start);
    return script.slice(i, script.indexOf('};', i) + 2);
  };
  function paint(d) {
    const els = { health: { innerHTML: '' }, 'hl-sum': { className: '', textContent: '' },
                  'hl-at': { textContent: '' } };
    // eslint-disable-next-line no-new-func
    new Function('els', 'd', `
      const document = { getElementById: (id) => els[id] || null };
      ${lift('esc')}
      ${block('const HL_WORD')}
      ${lift('paintHealth')}
      paintHealth(d);`)(els, d);
    return els;
  }
  test('a bad part is red and counted', () => {
    const e = paint({ ok: true, status: 'bad', at: NOW, counts: { bad: 1, warn: 0, unknown: 0 },
      groups: [{ title: 'Services', items: [{ id: 'qp', label: 'qp', status: 'bad', detail: 'not answering' }] }] });
    expect(e['hl-sum'].className).toBe('hl-sum bad');
    expect(e['hl-sum'].textContent).toMatch(/1 not working/);
    expect(e.health.innerHTML).toMatch(/class="hl-i bad"/);
  });
  test('an unchecked part is grey "unknown", not ok', () => {
    const e = paint({ ok: true, status: 'unknown', counts: { unknown: 1 },
      groups: [{ title: 'Jobs', items: [{ id: 'm', label: 'Manager', status: null, detail: 'not started' }] }] });
    expect(e.health.innerHTML).toMatch(/class="hl-i unknown"/);
    expect(e['hl-sum'].className).not.toMatch(/ok/);
  });
});
