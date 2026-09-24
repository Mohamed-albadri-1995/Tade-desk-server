/*
 * THE SYSTEM LOG: ONE STREAM, IN ORDER, WITH THE RIGHT LEVEL ON EACH LINE.
 *
 * Fed with lines copied from the box on 2026-09-24 — qp's port wait, T1's
 * memory kills, the backup's stack trace — because those are the lines this
 * has to make readable.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const S = require('../src/alerts/syslog');

const QP_ERR = `2026-09-24T13:23:38: INFO:     Shutting down
2026-09-24T13:24:01: qp DID NOT START: port 8765 is still in use on 0.0.0.0 after waiting 20s.
2026-09-24T13:24:09: 5 backtest(s) were left running by the previous qp — marked interrupted
2026-09-24T13:24:09: INFO:     127.0.0.1:54942 - "GET /api/health HTTP/1.1" 200 OK
`;
const T1_ERR = `2026-09-23T21:30:02: [Scheduler] Daily Backup 5:30 PM failed: Error: GitHub push failed (401): {"message":"Bad credentials"}
2026-09-23T21:30:02:     at pushFile (/home/ec2-user/Tade-desk-server/src/backup/index.js:104:11)
2026-09-23T21:30:02:     at async pushBackup (/home/ec2-user/Tade-desk-server/src/backup/index.js:199:3)
2026-09-23T21:35:01: [Scheduler] settings backup failed: push failed
`;
const PM2 = `2026-09-24T09:47:54: PM2 log: [PM2][WORKER] Process 346 restarted because it exceeds --max-memory-restart value (current_memory=178716672 max_memory_limit=146800640 [octets])
2026-09-24T09:48:00: PM2 log: Some unrelated daemon chatter
`;

describe('reading a process log', () => {
  test('levels: a failed start is an error, routine access is debug, the rest info', () => {
    const ls = S.parseLog(QP_ERR, 'qp');
    expect(ls.map(l => l.level)).toEqual(['info', 'error', 'info', 'debug']);
    expect(ls.every(l => l.src === 'qp')).toBe(true);
  });
  test('a stack trace joins the line it belongs to, and makes it an error', () => {
    const ls = S.parseLog(T1_ERR, 'tool-T1');
    expect(ls).toHaveLength(2);
    expect(ls[0].level).toBe('error');
    expect(ls[0].detail).toMatch(/at pushFile[\s\S]*at async pushBackup/);
  });
  test('the time is the stamp pm2 wrote, in the box\'s local time', () => {
    const [l] = S.parseLog(QP_ERR, 'qp');
    expect(new Date(l.t).getHours()).toBe(13);
    expect(new Date(l.t).getMinutes()).toBe(23);
  });
});

describe('the pm2 log directory', () => {
  let dir;
  beforeAll(() => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pm2home-'));
    dir = path.join(home, 'logs');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'qp-error-345.log'), QP_ERR);
    fs.writeFileSync(path.join(dir, 'tool-T1-error.log'), T1_ERR);
    fs.writeFileSync(path.join(home, 'pm2.log'), PM2);
  });
  test('every process file is read under its process name, id suffix or not', () => {
    const { lines } = S.processLines(dir);
    expect(new Set(lines.map(l => l.src))).toEqual(new Set(['qp', 'tool-T1', 'pm2']));
  });
  test('from pm2\'s own log only restarts and kills are kept — the memory kill is there', () => {
    const pm2 = S.processLines(dir).lines.filter(l => l.src === 'pm2');
    expect(pm2).toHaveLength(1);
    expect(pm2[0].msg).toMatch(/exceeds --max-memory-restart/);
    expect(pm2[0].level).toBe('error');
  });
  test('no pm2 directory is a note, not a crash', () => {
    expect(S.processLines('/nonexistent/logs').error).toMatch(/no pm2 logs/);
  });
});

describe('the desk\'s own records', () => {
  const AT = Date.parse('2026-09-24T13:35:30Z');
  test('a failed decision is one error line, with the reason', () => {
    const [l] = S.runLines({ at: AT, setup: 'OR + VWAP 09:35', bar: '09:34', ok: false,
                             error: 'timeout of 30000ms exceeded', ms: 30000 });
    expect(l.level).toBe('error');
    expect(l.msg).toMatch(/OR \+ VWAP 09:35 decision on 09:34 FAILED in 30 s: timeout/);
  });
  test('a decision states its funnel, each pick, and what each order did', () => {
    const ls = S.runLines({ at: AT, setup: 'OR', bar: '09:34', ok: true, ms: 9100,
      funnel: { cards: 47, evaluated: 45, signalled: 6, picked: 2 },
      picks: [{ ticker: 'AAA', side: 'long', entry: 10, stop: 9.8, target: 10.4, shares: 250,
                orders: [{ to: 'Alpaca100ktest', sent: true, qty: 250, status: 'accepted' }] },
              { ticker: 'BBB', side: 'short', entry: 20, stop: 20.3, target: 19.4,
                orders: [{ to: 'Alpaca100ktest', sent: false, skipped: 'no borrow' }] }] });
    expect(ls[0].msg).toMatch(/47 cards → 45 evaluated → 6 signals → 2 picked/);
    expect(ls.find(l => /AAA: order SENT/.test(l.msg)).level).toBe('info');
    expect(ls.find(l => /BBB: order .* NOT sent — no borrow/.test(l.msg)).level).toBe('warn');
  });
  test('a rehearsal is debug — it is not the strategy trading', () => {
    expect(S.runLines({ at: AT, setup: 'OR', ok: true, rehearsal: true })[0].level).toBe('debug');
  });
  test('a manager close that was not sent is an error', () => {
    const [l] = S.passLines({ at: AT, acted: [{ symbol: 'U', why: 'the exit rule fired', sent: false }] });
    expect(l.level).toBe('error');
    expect(l.msg).toMatch(/CLOSE U — the exit rule fired · NOT SENT/);
  });
  test('a pass that only held is debug', () => {
    const [l] = S.passLines({ at: AT, positions: [{ symbol: 'U', stop: 10.1, stopMoved: true }] });
    expect(l.level).toBe('debug');
    expect(l.msg).toMatch(/holding 1 — U stop 10.1 \(moved\)/);
  });
  test('ledger: an entry sent, a close refused, a broker reply', () => {
    expect(S.ledgerLine({ at: AT, symbol: 'AAA', signal: 'buy', quantity: 250, price: 10,
                          stop: 9.8, target: 10.4, broker: 'Alpaca100ktest', sent: true }).msg)
      .toMatch(/ORDER AAA: BUY 250 sh @ 10 stop 9.8 target 10.4 to Alpaca100ktest — sent/);
    const c = S.ledgerLine({ at: AT, kind: 'flatten', symbol: 'U', source: 'end of session',
                             broker: 'OR+VWAP 935', sent: false, error: '422: insufficient qty' });
    expect([c.level, c.msg]).toEqual(['error', 'U: CLOSE to OR+VWAP 935 (end of session) — 422: insufficient qty']);
    expect(S.ledgerLine({ at: AT, kind: 'callback', symbol: 'U', status: 'rejected' }).level).toBe('warn');
  });
});

describe('the whole stream', () => {
  const day = '2026-09-24';
  const at = (hhmmss) => Date.parse(`${day}T${hhmmss}-04:00`);      // ET, EDT
  const deps = {
    sessionLog: {
      runsOn: () => [{ at: at('09:35:20'), setup: 'OR', bar: '09:34', ok: true, ms: 8000,
                       funnel: { cards: 10, evaluated: 10, signalled: 1, picked: 0 } }],
      passesOn: () => [{ at: at('09:40:00'), positions: [{ symbol: 'U' }] }],
    },
    ledger: () => [{ at: at('09:35:25'), symbol: 'AAA', signal: 'buy', quantity: 5, price: 10,
                     stop: 9, sent: false, skipped: 'not armed' }],
    processLines: () => ({ lines: [
      { t: at('09:36:00'), src: 'qp', level: 'error', msg: 'Traceback boom' },
      { t: at('09:36:01'), src: 'qp', level: 'debug', msg: 'GET 200' },
      { t: Date.parse('2026-09-23T15:00:00-04:00'), src: 'qp', level: 'error', msg: 'yesterday' },
    ], error: null }),
  };
  test('in time order, today only, routine hidden by default', () => {
    const r = S.collect({ date: day }, deps);
    expect(r.lines.map(l => l.msg.slice(0, 12))).toEqual(
      ['OR decided o', 'ORDER AAA: B', 'Traceback bo']);
    expect(r.counts).toEqual({ error: 1, warn: 1, info: 1, debug: 2 });
    expect(r.sources).toEqual(['desk', 'qp']);
  });
  test('filters: level, source, search', () => {
    expect(S.collect({ date: day, level: 'debug' }, deps).lines).toHaveLength(5);
    expect(S.collect({ date: day, level: 'error' }, deps).lines.map(l => l.msg)).toEqual(['Traceback boom']);
    expect(S.collect({ date: day, src: 'desk' }, deps).lines.every(l => l.src === 'desk')).toBe(true);
    expect(S.collect({ date: day, q: 'not armed' }, deps).lines).toHaveLength(1);
  });
  test('a source that cannot be read is a note, and the rest still come back', () => {
    const r = S.collect({ date: day }, { ...deps, ledger: () => { throw new Error('disk'); } });
    expect(r.ok).toBe(true);
    expect(r.notes[0]).toMatch(/broker ledger could not be read: disk/);
    expect(r.lines.length).toBeGreaterThan(0);
  });
});

/* ── the viewer on the Review tab, run ─────────────────────────────────── */
describe('the log viewer', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'alerts.html'), 'utf8');
  const script = (html.match(/<script>([\s\S]*?)<\/script>/) || [])[1] || '';
  const lift = (name) => {
    const from = script.indexOf(`function ${name}(`);
    return script.slice(from, script.indexOf('\n}', from) + 2);
  };
  const block = (start) => {
    const i = script.indexOf(start);
    return script.slice(i, script.indexOf(';\n', i) + 2);
  };
  function page(d, level = 'info') {
    const els = {
      syslog: { innerHTML: '', scrollHeight: 100, scrollTop: 0, clientHeight: 50, dataset: {} },
      'sl-sum': { innerHTML: '', textContent: '' },
      'sl-src': { value: '', innerHTML: '' },
      'sl-level': { value: level },
    };
    // eslint-disable-next-line no-new-func
    return new Function('els', 'd', `
      const document = { getElementById: (id) => els[id] || null };
      let SYSLOG = null;
      ${lift('esc')}
      ${block('const SL_LVL')}
      ${block('const SL_COLORS')}
      ${lift('slColor')}
      ${lift('slTime')}
      ${lift('paintSyslog')}
      ${lift('syslogText')}
      paintSyslog(d);
      return { els, text: syslogText(d) };`)(els, d);
  }
  const T = Date.parse('2026-09-24T13:24:01Z');       // 09:24:01 ET
  const D = { ok: true, date: '2026-09-24', sources: ['desk', 'qp'],
    counts: { error: 1, warn: 0, info: 1, debug: 0 },
    lines: [{ t: T, src: 'qp', level: 'error', msg: 'qp DID NOT START: port 8765 in use',
              detail: '    at probe (server.py:3200)' },
            { t: T + 8000, src: 'desk', level: 'info', msg: 'OR decided on 09:34 in 8 s' }] };

  test('each line: ET time, source, level, message; an error row is marked', () => {
    const { els } = page(D);
    expect(els.syslog.innerHTML).toMatch(/class="sl-r error has-d"/);
    expect(els.syslog.innerHTML).toMatch(/09:24:01/);
    expect(els.syslog.innerHTML).toMatch(/>ERR</);
    expect(els['sl-sum'].innerHTML).toMatch(/1 errors/);
    expect(els['sl-src'].innerHTML).toMatch(/<option value="qp">qp/);
  });
  test('a stack trace is folded under its line, opened by a tap', () => {
    const { els } = page(D);
    expect(els.syslog.innerHTML).toMatch(/onclick="this.classList.toggle\('open'\)"/);
    expect(els.syslog.innerHTML).toMatch(/<pre class="sl-d">    at probe/);
  });
  test('Copy for Claude is plain text: a header, one line per event, the trace indented', () => {
    const { text } = page(D);
    const lines = text.split('\n');
    expect(lines[0]).toMatch(/^Trade desk log 2026-09-24 \(ET\) · level info · 2 lines/);
    expect(lines[1]).toBe('09:24:01  qp        ERR  qp DID NOT START: port 8765 in use');
    expect(lines[2]).toBe('          at probe (server.py:3200)');
    expect(lines[3]).toMatch(/^09:24:09  desk      INF  OR decided/);
  });
  test('a failed read says so rather than showing an empty log', () => {
    const { els } = page({ ok: false, error: 'ECONNREFUSED' });
    expect(els.syslog.innerHTML).toMatch(/could not be read: ECONNREFUSED/);
  });
});

/*
 * A REAL BOX'S LOGS. Reported 2026-09-24 as an empty Review tab: "Failed to
 * fetch". Thirty pm2 log files of routine qp traffic made the reader build
 * every line before filtering — 21 s and over a gigabyte — and gathering
 * them with push(...all) overflowed the call stack outright.
 */
describe('a box with large logs', () => {
  let home;
  const DAY = require('../src/utils/time').toETDate(Date.now());
  beforeAll(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'pm2big-'));
    fs.mkdirSync(path.join(home, 'logs'));
    const [y, m, d] = DAY.split('-');
    let text = '';
    for (let i = 0; i < 40000; i += 1) {
      const hh = String(10 + (i % 6)).padStart(2, '0');
      const mm = String(i % 60).padStart(2, '0');
      text += `${y}-${m}-${d}T${hh}:${mm}:00: INFO:     127.0.0.1:1 - "GET /api/strategies HTTP/1.1" 200 OK\n`;
    }
    for (let k = 0; k < 12; k += 1) fs.writeFileSync(path.join(home, 'logs', `tool-T${k}-out.log`), text);
    fs.writeFileSync(path.join(home, 'logs', 'qp-error-1.log'),
      `${y}-${m}-${d}T12:00:00: qp DID NOT START: port in use\n`);
  });
  const deps = () => ({ sessionLog: { runsOn: () => [], passesOn: () => [] }, ledger: () => [],
    processLines: (dir, keep, since, per) => S.processLines(path.join(home, 'logs'), keep, since, per) });

  test('"everything" answers, bounded, quickly, without overflowing', () => {
    const t = Date.now();
    const r = S.collect({ date: DAY, level: 'debug', limit: 1500 }, deps());
    expect(r.ok).toBe(true);
    expect(r.lines.length).toBeLessThanOrEqual(1500);
    expect(Date.now() - t).toBeLessThan(5000);
  });
  test('errors only finds the one error among the routine lines', () => {
    const r = S.collect({ date: DAY, level: 'error' }, deps());
    expect(r.lines.map(l => l.msg)).toEqual(['qp DID NOT START: port in use']);
  });
});

/* ── read off the box's own log, 2026-09-24 ─────────────────────────────── */
describe('what the first real log showed', () => {
  test('a 401 is an error, whatever surrounds it — the manager was blind', () => {
    expect(S.levelOf('[Manager] could not verify positions with Alpaca: Alpaca /v2/positions 401: {"message": "unauthorized."}'))
      .toBe('error');
  });
  test('"could not" is at least a warning', () => {
    expect(S.levelOf('[Flatten] could not reach the broker')).toBe('warn');
  });
  test('a stamp with nothing after it takes its message from the next line', () => {
    const ls = S.parseLog('2026-09-24T10:12:25: \n  { symbol: "DINO", note: "timed out" }\n2026-09-24T10:12:26: \n', 'alerts');
    expect(ls).toHaveLength(1);
    expect(ls[0].msg).toBe('{ symbol: "DINO", note: "timed out" }');
    expect(ls[0].level).toBe('warn');
  });
});

describe('the log as a file', () => {
  test('toText: a header with the counts, then one line each', () => {
    const txt = S.toText({ date: '2026-09-24', counts: { error: 1, warn: 0, info: 1 }, notes: [],
      lines: [{ t: Date.parse('2026-09-24T14:12:25Z'), src: 'alerts', level: 'error',
                msg: 'could not verify positions: 401', detail: 'at x' }] }, { level: 'warn' });
    const L = txt.split('\n');
    expect(L[0]).toBe('Trade desk system log · 2026-09-24 (times ET) · level warn');
    expect(L[1]).toMatch(/^1 errors · 0 warnings · 1 events · 1 lines$/);
    expect(L[3]).toBe('10:12:25  alerts    ERR  could not verify positions: 401');
    expect(L[4]).toBe('      at x');
  });
  test('GET /api/logs.txt downloads, named for the day and level', async () => {
    const request = require('supertest');
    process.env.PM2_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'pm2dl-'));
    const app = require('../src/alerts/server');
    const r = await request(app).get('/api/logs.txt?date=2026-09-24&level=warn');
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toMatch(/text\/plain/);
    expect(r.headers['content-disposition']).toBe('attachment; filename="trade-desk-log-2026-09-24-warn.txt"');
    expect(r.text).toMatch(/^Trade desk system log · 2026-09-24/);
  });
});

describe('the second pass over the real log', () => {
  test('routine scan reports that mention "stale" are not warnings', () => {
    expect(S.levelOf('[Pipeline] Scan complete: 45 live, 3 stale')).toBe('info');
    expect(S.levelOf('[SideG] Refreshed 12/12 stale tickers (0 skipped — no tvSymbol)')).toBe('info');
    expect(S.levelOf('Test: dropped as STALE (bar too old): MPC@09:46')).toBe('warn');
  });
  test('one message repeated all day is ONE line, with its count and last time', () => {
    const at = (m) => Date.parse(`2026-09-24T${m}:00-04:00`);
    const msg = '[Manager] could not verify positions with Alpaca: 401';
    const r = S.collect({ date: '2026-09-24', level: 'warn' }, {
      sessionLog: { runsOn: () => [], passesOn: () => [] }, ledger: () => [],
      processLines: () => ({ error: null, lines: [
        { t: at('09:00'), src: 'alerts', level: 'error', msg },
        { t: at('09:35'), src: 'desk', level: 'error', msg: 'MAZE: order FAILED' },
        { t: at('09:01'), src: 'alerts', level: 'error', msg },
        { t: at('10:17'), src: 'alerts', level: 'error', msg }] }) });
    expect(r.lines.map(l => [l.msg, l.repeat || 1])).toEqual([[msg, 3], ['MAZE: order FAILED', 1]]);
    expect(r.lines[0].lastT).toBe(at('10:17'));
    expect(S.toText(r)).toMatch(/401 {3}\[×3, last 10:17:00\]/);
  });
  test('group=0 shows every line', () => {
    const at = (m) => Date.parse(`2026-09-24T${m}:00-04:00`);
    const r = S.collect({ date: '2026-09-24', level: 'warn', group: '0' }, {
      sessionLog: { runsOn: () => [], passesOn: () => [] }, ledger: () => [],
      processLines: () => ({ error: null, lines: [
        { t: at('09:00'), src: 'a', level: 'error', msg: 'x' }, { t: at('09:01'), src: 'a', level: 'error', msg: 'x' }] }) });
    expect(r.lines).toHaveLength(2);
  });
});
