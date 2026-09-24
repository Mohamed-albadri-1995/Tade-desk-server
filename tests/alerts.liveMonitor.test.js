/*
 * LIVE IS A MONITOR: TRADES BY ACCOUNT, SETUPS AND THEIR DECISIONS, ERRORS.
 *
 * Asked for 2026-09-24: "a summary of the open and closed positions today —
 * setup, account, side, symbol, shares, SL, TP, the last time it was
 * monitored — clear visually, organised but not confusing; what setups are
 * being evaluated now and since the beginning of the session; errors."
 * Run, not grepped: the page's own functions draw these.
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
const block = (start) => {
  const i = script.indexOf(start);
  return script.slice(i, script.indexOf(';\n', i) + 2);
};

function run(body, env) {
  const els = {};
  for (const id of ['upnext', 'next-note', 'errors', 'err-note', 'board', 'brd-note']) {
    els[id] = { innerHTML: '', textContent: '' };
  }
  // eslint-disable-next-line no-new-func
  new Function('els', 'env', `
    const document = { getElementById: (id) => els[id] || null };
    const SETUPS = env.setups || [], LIVE_RUNS = env.runs || [];
    const nowMinutesET = () => env.now;
    ${lift('esc')}
    ${lift('toMinutes')}
    ${lift('slTime')}
    ${block('const ST_WORD')}
    ${lift('money')}
    ${lift('px')}
    ${lift('agoShort')}
    ${lift('tradeRow')}
    ${lift('bySetup')}
    ${lift('paintBoard')}
    ${lift('runLine')}
    ${lift('paintUpNext')}
    ${lift('paintErrors')}
    ${body}`)(els, env);
  return els;
}

const OR = { id: 'OR@09:35', name: 'OR + VWAP 09:35', decisionTime: '09:35', tools: ['T2'],
             accounts: [{ mode: 'auto' }] };
const TEST = { id: 'Test@09:30', name: 'Test', decisionTime: '09:30', windowEnd: '11:30',
               watch: true, tools: ['T11'], accounts: [{ mode: 'auto' }] };
const AT = (hm) => Date.parse(`2026-09-24T${hm}:10-04:00`);

describe('trades today, by account', () => {
  const BOARD = { ok: true, notes: [], accounts: [{
    id: 'a', name: 'OR+VWAP 935', mode: 'auto', open: 1, closed: 1, openPnl: 155.4, closedPnl: -42,
    trades: [
      { status: 'open', symbol: 'NVTS', side: 'long', setup: 'OR + VWAP 09:35', shares: 420,
        entry: 11.84, sl: 11.60, stopNow: 11.62, stopMoved: true, tp: 12.28, now: 12.21,
        legsBanked: 1, checkedAt: Date.now() - 20000, pnl: 155.4, pnlPct: 3.13, entryTime: '09:35:04' },
      { status: 'closed', symbol: 'SOUN', side: 'short', setup: 'OR + VWAP 09:35', shares: 300,
        entry: 5.10, sl: 5.25, tp: 4.80, exit: 5.24, exitTime: '10:12:40', pnl: -42, pnlPct: -2.75,
        closeReason: "the backtest's stop was hit" },
      { status: 'not sent', symbol: 'RGTI', side: 'short', setup: 'OR + VWAP 09:35', plannedEntry: 14.2,
        sl: 14.6, tp: 13.4, notSent: 'no shares to borrow', notSentLevel: 'warn' }] }] };

  /*
   * A LADDER, NOT A ROW OF EQUALS. Reported: "you are putting account and
   * setup at the same level — Alpaca 100k and the 935 setup; build an
   * organised ladder". The account on the box is literally called
   * "OR+VWAP 935", so the levels have to be NAMED, not only indented.
   */
  test('ACCOUNT → SETUP → trades, each level labelled', () => {
    const h = run('paintBoard(env.b)', { b: BOARD }).board.innerHTML;
    const acct = h.indexOf('<span class="lvl">Account</span><b>OR+VWAP 935</b>');
    const setup = h.indexOf('<span class="lvl">Setup</span><b>OR + VWAP 09:35</b>');
    const trade = h.indexOf('NVTS');
    expect(acct).toBeGreaterThanOrEqual(0);
    expect(setup).toBeGreaterThan(acct);
    expect(trade).toBeGreaterThan(setup);
    // The setup is said once, as the level — not again on every trade row.
    expect(h.split('OR + VWAP 09:35').length - 1).toBe(1);
    expect(h).toMatch(/3 trades<\/span>/);
  });
  test('two setups on one account are two groups, each with its own P&L', () => {
    const b = JSON.parse(JSON.stringify(BOARD));
    b.accounts[0].trades.push({ status: 'closed', symbol: 'U', side: 'long', setup: 'Test',
      shares: 10, entry: 10, exit: 11, pnl: 10 });
    const h = run('paintBoard(env.b)', { b }).board.innerHTML;
    expect(h.split('class="su-grp"').length - 1).toBe(2);
    expect(h).toMatch(/<b>Test<\/b>[\s\S]*1 trade<\/span>[\s\S]*\+\$10\.00/);
  });
  test('the account heads its trades, with its mode and both P&Ls', () => {
    const e = run('paintBoard(env.b)', { b: BOARD });
    expect(e.board.innerHTML).toMatch(/<b>OR\+VWAP 935<\/b><span class="bchip live">FULL AUTO/);
    expect(e.board.innerHTML).toMatch(/closed <span class="neg">−\$42\.00<\/span>[\s\S]*open <span class="pos">\+\$155/);
    expect(e['brd-note'].innerHTML).toMatch(/1 open · 1 closed/);
  });
  test('an open trade: status, symbol, side, setup, P&L; shares, entry, SL now, TP, now; monitored', () => {
    const e = run('paintBoard(env.b)', { b: BOARD });
    const nv = e.board.innerHTML.split('class="tr ')[1];
    expect(nv).toMatch(/st open">OPEN[\s\S]*NVTS[\s\S]*LONG[\s\S]*\+\$155 · \+3\.13%/);
    expect(nv).toMatch(/shares<\/span><b>420[\s\S]*entry<\/span><b>11\.84[\s\S]*SL<\/span><b>11\.62 <i class="mv">↑[\s\S]*TP<\/span><b>12\.28 <i class="mv">✓[\s\S]*now<\/span><b>12\.21/);
    expect(nv).toMatch(/in 09:35 · <span class="ok">✓ target half taken<\/span>[\s\S]*monitored 20s ago/);
  });
  test('a closed trade says when and why, with its exit price', () => {
    const so = run('paintBoard(env.b)', { b: BOARD }).board.innerHTML.split('class="tr ')[2];
    expect(so).toMatch(/CLOSED[\s\S]*SOUN[\s\S]*SHORT[\s\S]*exit<\/span><b>5\.24/);
    expect(so).toMatch(/closed 10:12 — the backtest&#39;s stop was hit|closed 10:12 — the backtest's stop was hit/);
  });
  test('an order that never went out is on the board too, with the reason', () => {
    const rg = run('paintBoard(env.b)', { b: BOARD }).board.innerHTML.split('class="tr ')[3];
    expect(rg).toMatch(/NOT SENT[\s\S]*RGTI[\s\S]*not sent — no shares to borrow/);
  });
  test('an open trade the manager has not looked at says so, in red', () => {
    const b = JSON.parse(JSON.stringify(BOARD));
    b.accounts[0].trades = [{ ...b.accounts[0].trades[0], checkedAt: null }];
    expect(run('paintBoard(env.b)', { b }).board.innerHTML).toMatch(/class="bad">not monitored yet/);
  });
  test('no trades is said, not an empty box', () => {
    expect(run('paintBoard(env.b)', { b: { ok: true, accounts: [] } }).board.innerHTML)
      .toMatch(/No trades today yet/);
  });
});

describe('setups: evaluated now, and since the open', () => {
  test('before the minute: a countdown, in time order', () => {
    const e = run('paintUpNext()', { now: 9 * 60 + 10, setups: [OR, TEST] });
    const rows = e.upnext.innerHTML.split('class="su-live"').slice(1);
    expect(rows[0]).toMatch(/09:30–11:30[\s\S]*Test[\s\S]*in 20 min/);
    expect(rows[1]).toMatch(/09:35[\s\S]*OR \+ VWAP 09:35[\s\S]*T2 · auto[\s\S]*in 25 min/);
  });
  test('inside the window: watching now, and each decision so far with its picks', () => {
    const e = run('paintUpNext()', { now: 10 * 60, setups: [TEST], runs: [
      { setupId: 'Test@09:30', ok: true, at: AT('09:59'), ms: 2100,
        funnel: { cards: 31, signalled: 1 }, picks: [{ ticker: 'RKLB' }] },
      { setupId: 'Test@09:30', ok: false, at: AT('09:58'), error: 'timeout' }] });
    expect(e.upnext.innerHTML).toMatch(/lv-row now[\s\S]*watching now · 2 runs · 1 pick · 1 failed/);
    expect(e.upnext.innerHTML).toMatch(/09:59[\s\S]*31 cards → 1 signals → <span class="p">RKLB[\s\S]*2\.1s/);
    expect(e.upnext.innerHTML).toMatch(/su-run bad"><span>09:58<\/span><span>FAILED — timeout/);
  });
  test('the latest three show; the rest fold', () => {
    const runs = Array.from({ length: 7 }, (_, i) => ({ setupId: 'Test@09:30', ok: true,
      at: AT(`10:0${i}`), funnel: {}, picks: [] }));
    expect(run('paintUpNext()', { now: 10 * 60 + 10, setups: [TEST], runs }).upnext.innerHTML)
      .toMatch(/<summary>4 earlier<\/summary>/);
  });
  test('past its minute with no record at all: said, not left blank', () => {
    expect(run('paintUpNext()', { now: 10 * 60, setups: [OR], runs: [] }).upnext.innerHTML)
      .toMatch(/no decision recorded/);
  });
  test('a rehearsal does not count as the decision', () => {
    expect(run('paintUpNext()', { now: 10 * 60, setups: [OR],
      runs: [{ setupId: 'OR@09:35', ok: true, rehearsal: true }] }).upnext.innerHTML)
      .toMatch(/no decision recorded/);
  });
});

describe('errors today', () => {
  const T = Date.parse('2026-09-24T13:35:20Z');
  test('newest first, with their source; nothing but errors', () => {
    const e = run('paintErrors(env.d)', { d: { ok: true, lines: [
      { t: T, level: 'error', src: 'qp', msg: 'Traceback boom' },
      { t: T + 1000, level: 'warn', src: 'desk', msg: 'a warning' },
      { t: T + 9000, level: 'error', src: 'desk', msg: 'AAA: order FAILED — 422' }] } });
    const rows = e.errors.innerHTML.split('lv-row').slice(1);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatch(/AAA: order FAILED[\s\S]*desk/);
    expect(e['err-note'].textContent).toMatch(/2 · full log on Review/);
  });
  test('none is said plainly', () => {
    expect(run('paintErrors(env.d)', { d: { ok: true, lines: [] } }).errors.innerHTML).toMatch(/No errors today/);
  });
});
