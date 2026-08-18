/*
 * The end-of-session read-out, and the one thing it must never do.
 *
 * scripts/today.js exists because four facts about a session lived in four
 * places — the alerts page, an inbox, a screenshot of the broker's order list,
 * and the strategy builder — and the fault that cost money was visible in none
 * of them on its own. A strategy that should send three orders and sent one is
 * healthy-looking in the alert feed AND in the ledger. Only the two together
 * say otherwise.
 *
 * The output is written to be PASTED — into a chat window, into a message.
 * That is the point of it and it is also the risk, because a hook id is the
 * ability to place orders in a real account with nothing in front of it. So
 * the first test here is the redaction, and it uses a string shaped exactly
 * like the real thing.
 */

const os = require('os');
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'today.js');
const DAY = '2026-08-17';

let DIR;
beforeEach(() => { DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'today-')); });
afterEach(() => { fs.rmSync(DIR, { recursive: true, force: true }); });

/** Run it against a data dir, with qp deliberately unreachable. */
function run(args = []) {
  return execFileSync(process.execPath, [SCRIPT, DAY, ...args], {
    encoding: 'utf8',
    env: { ...process.env, DATA_DIR: DIR, BROKER_LEDGER: path.join(DIR, 'broker-orders.jsonl'),
           BROKER_FILE: path.join(DIR, 'broker.json'),
           // A port nothing is on: the script must still produce its report.
           QP_URL: 'http://127.0.0.1:9' },
  });
}

const ledger = rows => fs.writeFileSync(path.join(DIR, 'broker-orders.jsonl'),
  rows.map(r => JSON.stringify({ date: DAY, at: Date.parse('2026-08-17T14:00:00Z'), ...r })).join('\n'));

const fires = list => fs.writeFileSync(path.join(DIR, 'alert-fires.json'),
  JSON.stringify({ tools: { T2: { date: DAY, fires: list.map((f, i) => ({
    toolId: 'T2', date: DAY, at: 1786970000000 + i * 1000, kind: 'setup', ...f })) } } }));

// ── the one that must never fail ───────────────────────────────────────────

describe('nothing that can place an order is ever printed', () => {
  test('a hook id in an alert line is redacted', () => {
    // Shaped like the real one — 22 characters after /hook/ — and made up.
    fires([{ ruleId: 'S', ticker: 'AAA', level: 'trade',
             detail: 'BUY AAA — sent to https://app.signalstack.com/hook/FAKEhook0000000000000a' }]);
    const out = run();
    expect(out).not.toContain('FAKEhook0000000000000a');
    expect(out).toContain('signalstack.com/hook/[REDACTED]');
  });

  test('a callback token is redacted', () => {
    fires([{ ruleId: 'S', ticker: 'AAA', level: 'error',
             detail: 'callback https://example.duckdns.org/api/broker/callback/AbC_deF123-xyzQRS' }]);
    const out = run();
    expect(out).not.toContain('AbC_deF123-xyzQRS');
    expect(out).toContain('/api/broker/callback/[REDACTED]');
  });

  test('a broker key and a long hex secret are redacted', () => {
    fires([{ ruleId: 'S', ticker: 'AAA', level: 'error',
             detail: 'key PKFAKE0000000000000000 and d7fa6f9f01ffb8fff48fd7ga6g9r01qqb8rit490'.replace(/[g-z]/g, '0') }]);
    const out = run();
    expect(out).not.toMatch(/PK[A-Z0-9]{16,}/);
    expect(out).not.toMatch(/\b[a-f0-9]{32,}\b/);
  });

  /*
   * The masking in publicSettings() is the real defence for the settings file;
   * this only proves the script reads it through that door rather than round
   * the side.
   */
  test('the destinations section never prints a hook', () => {
    fs.writeFileSync(path.join(DIR, 'broker.json'), JSON.stringify({
      armed: true, enabled: true,
      destinations: [{ id: 'alp', name: 'Alpaca', dialect: 'alpaca', ratio: 1,
        webhookUrl: 'https://app.signalstack.com/hook/FAKEhook0000000000000a' }],
    }));
    const out = run();
    expect(out).not.toContain('FAKEhook0000000000000a');
    expect(out).toContain('Alpaca');
  });
});

// ── it has to survive the box it runs on ───────────────────────────────────

describe('a session with nothing in it', () => {
  test('says so, on every section, rather than crashing', () => {
    const out = run();
    expect(out).toContain('THE DESK');
    expect(out).toContain('WHAT FIRED');
    expect(out).toContain('WHAT WENT TO THE BROKER');
    expect(out).toMatch(/nothing at all today/);
    expect(out).toMatch(/no ledger at/);
  });

  test('qp being down does not stop the rest of the report', () => {
    ledger([{ symbol: 'AAA', action: 'buy', asked: 10, quantity: 10, sent: true,
              status: 'filled', setupId: 'X', destination: 'alp' }]);
    const out = run();
    expect(out).toMatch(/qp not reachable/);
    expect(out).toContain('AAA');            // ...and the ledger still printed
  });
});

// ── what fired ─────────────────────────────────────────────────────────────

describe('the alert feed', () => {
  /*
   * Forty-six copies of one error is ONE fault. Printed once with a count and
   * the first and last time, because printing it forty-six times is how the
   * other three faults on the page get missed.
   */
  test('a repeated error is collapsed to one line with a count', () => {
    fires(Array.from({ length: 46 }, () => ({
      ruleId: 'Test@09:30', ticker: null, level: 'error',
      detail: "Did not run: Cannot read properties of null (reading 'toFixed')",
    })));
    const out = run();
    expect(out).toMatch(/46×/);
    expect(out.match(/Did not run/g)).toHaveLength(1);
  });

  /*
   * The window is the whole point of collapsing them: 46 copies say there is a
   * fault, "10:46 to 11:31" says how long it ran and what else to look at in
   * that stretch. It is read off `at`, because atET is only stamped when a fire
   * reaches HISTORY and a live fire has not.
   */
  test('the collapsed line carries the first and last time', () => {
    const base = Date.parse('2026-08-17T14:46:00Z');           // 10:46 New York
    fs.writeFileSync(path.join(DIR, 'alert-fires.json'), JSON.stringify({
      tools: { T8: { date: DAY, fires: Array.from({ length: 46 }, (_, i) => ({
        ruleId: 'Test@09:30', ticker: null, toolId: 'T8', date: DAY,
        at: base + i * 60000, kind: 'setup', level: 'error',
        detail: 'Did not run: boom' })) } },
    }));
    const out = run();
    expect(out).toMatch(/first 10:46:00\s+last 11:31:00/);
  });

  /*
   * One unparseable timestamp must not become the "first" or the "last" and
   * quietly move the window the reader is being shown.
   */
  test('an undated error is counted, not sorted in among the times', () => {
    const base = Date.parse('2026-08-17T14:46:00Z');
    fs.writeFileSync(path.join(DIR, 'alert-fires.json'), JSON.stringify({
      tools: { T8: { date: DAY, fires: [
        { ruleId: 'R', toolId: 'T8', date: DAY, at: base, level: 'error', detail: 'boom' },
        { ruleId: 'R', toolId: 'T8', date: DAY, at: base + 60000, level: 'error', detail: 'boom' },
        { ruleId: 'R', toolId: 'T8', date: DAY, at: NaN, level: 'error', detail: 'boom' },
      ] } },
    }));
    const out = run();
    expect(out).toMatch(/3×/);
    expect(out).toMatch(/first 10:46:00\s+last 10:47:00/);
    expect(out).toMatch(/\+1 with no timestamp/);
  });

  /*
   * THE EXPENSIVE ONE. A watch setup alerting twice on one name means the
   * once-a-day latch did not hold, and every repeat is another order at
   * another per-order fee. It gets its own warning, not a line in a list.
   */
  test('the same name alerting twice is called out', () => {
    fires([
      { ruleId: 'Test@09:30', ticker: 'VIK', level: 'trade', detail: 'SHORT 48 VIK' },
      { ruleId: 'Test@09:30', ticker: 'VIK', level: 'trade', detail: 'SHORT 6 VIK' },
      { ruleId: 'Test@09:30', ticker: 'VIK', level: 'trade', detail: 'SHORT 6 VIK' },
    ]);
    const out = run();
    expect(out).toMatch(/THE SAME NAME ALERTED MORE THAN ONCE/);
    expect(out).toMatch(/3×\s+Test@09:30\s+VIK/);
  });

  test('one alert per name is not called out', () => {
    fires([
      { ruleId: 'Test@09:30', ticker: 'VIK', level: 'trade', detail: 'SHORT 48 VIK' },
      { ruleId: 'Test@09:30', ticker: 'CLBT', level: 'trade', detail: 'SHORT 10 CLBT' },
    ]);
    expect(run()).not.toMatch(/MORE THAN ONCE/);
  });
});

// ── what went out ──────────────────────────────────────────────────────────

describe('the ledger', () => {
  test('a refusal shows its reason, and the reasons are totalled', () => {
    ledger([
      { symbol: 'AKAN', action: 'sell', asked: 125, quantity: 0, sent: false,
        setupId: 'X', destination: 'alp', error: '422: asset AKAN cannot be sold short' },
      { symbol: 'VIK', action: 'sell', asked: 6, quantity: 0, sent: false,
        setupId: 'X', destination: 'alp', skipped: 'VIK was already traded by this setup today' },
    ]);
    const out = run();
    expect(out).toMatch(/2 attempt\(s\): 0 sent, 2 not/);
    expect(out).toContain('cannot be sold short');
    expect(out).toContain('already traded by this setup today');
    expect(out).toMatch(/WHY THE REST DID NOT GO/);
  });

  test('a scale-out shows every leg, and which one failed', () => {
    ledger([{ symbol: 'VIK', action: 'sell', asked: 48, quantity: 43, sent: true,
      status: 'filled', setupId: 'X', destination: 'alp', scaleOut: 3,
      legs: [{ quantity: 5, target: 8.5, sent: true },
             { quantity: 38, target: 7, sent: true },
             { quantity: 5, target: null, sent: false }] }]);
    const out = run();
    expect(out).toMatch(/legs\[5@8\.5 38@7 5→runner FAILED\]/);
  });

  /*
   * A close carries no quantity — it flattens whatever is there. Printing
   * "sent 0" for one reads as a failure, which is the opposite of the truth,
   * and this is the line you check when you are worried about going overnight.
   */
  test('an end-of-session close does not read as a failed order', () => {
    ledger([{ symbol: 'VIK', kind: 'flatten', action: 'close', sent: true,
              status: 'filled', source: 'end of session' }]);
    const out = run();
    expect(out).toContain('whole position');
    expect(out).not.toMatch(/VIK\s+close\s+asked/);
  });
});

// ── the section that finds what nobody reported ────────────────────────────

describe('reconciling the two', () => {
  const twoLegSignal = () => {
    fires([{ ruleId: 'S', ticker: 'CLBT', level: 'trade', detail: 'SHORT 416 CLBT' }]);
  };

  test('a signal that sent nothing at all', () => {
    twoLegSignal();
    ledger([]);
    fs.writeFileSync(path.join(DIR, 'broker-orders.jsonl'), '');
    const out = run();
    expect(out).toMatch(/signalled but NOTHING was sent/);
  });

  test('an order with no signal behind it', () => {
    ledger([{ symbol: 'ZZZ', action: 'buy', asked: 5, quantity: 5, sent: true,
              setupId: 'S', destination: 'alp' }]);
    const out = run();
    expect(out).toMatch(/order\(s\) with NO alert behind them/);
  });

  /*
   * TWO ACCOUNTS ON ONE SIGNAL IS CORRECT, and the first version of this
   * section did not know it — it compared the day's whole wire count against
   * "legs × alerts" and so accused every healthy two-account signal of sending
   * too many. Crying wolf on the one section meant to be worth reading is
   * worse than not having it.
   */
  test('a signal taken in two accounts is not a fault', () => {
    fires([{ ruleId: 'S', ticker: 'CBRS', level: 'trade', detail: 'BUY 39 CBRS' }]);
    ledger([
      { symbol: 'CBRS', action: 'buy', asked: 19, quantity: 19, sent: true,
        setupId: 'S', destination: 'alpaca50k', scaleOut: 2 },
      { symbol: 'CBRS', action: 'buy', asked: 19, quantity: 19, sent: true,
        setupId: 'S', destination: 'ttp5k', scaleOut: 2 },
    ]);
    const out = run();
    expect(out).toMatch(/entries 2 in 2 account\(s\)/);
    expect(out).not.toMatch(/ENTERED MORE THAN ONCE/);
    expect(out).not.toMatch(/too many/);
  });

  /*
   * THE EXPENSIVE ONE, and the shape it really had: the same name entered six
   * times in EACH of two accounts, with no alert behind any of them because
   * the alert is written after the order and kept throwing.
   */
  test('the same name entered repeatedly in one account is called out', () => {
    ledger(Array.from({ length: 6 }, () => ([
      { symbol: 'VIK', action: 'buy', asked: 84, quantity: 84, sent: true,
        setupId: 'Test@09:30', destination: 'alpaca50k', scaleOut: 3 },
      { symbol: 'VIK', action: 'buy', asked: 8, quantity: 8, sent: true,
        setupId: 'Test@09:30', destination: 'ttp5k', scaleOut: 2 },
    ])).flat());
    const out = run();
    expect(out).toMatch(/ENTERED MORE THAN ONCE/);
    expect(out).toMatch(/6× in alpaca50k/);
    expect(out).toMatch(/6× in ttp5k/);
  });

  /*
   * A flatten is not an order with no signal behind it — it is the exit. If it
   * were counted, every properly closed position would raise a false alarm on
   * the one section that is supposed to be worth reading.
   */
  test('the end-of-session close is not mistaken for a stray order', () => {
    fires([{ ruleId: 'S', ticker: 'VIK', level: 'trade', detail: 'SHORT 48 VIK' }]);
    ledger([
      { symbol: 'VIK', action: 'sell', asked: 48, quantity: 48, sent: true,
        setupId: 'S', destination: 'alp' },
      { symbol: 'VIK', kind: 'flatten', action: 'close', sent: true, source: 'end of session' },
    ]);
    const out = run();
    expect(out).not.toMatch(/no alert behind it/);
    expect(out).toMatch(/all 1 line up/);
  });

  test('a refused order does not count as one that went', () => {
    fires([{ ruleId: 'S', ticker: 'VIK', level: 'trade', detail: 'SHORT 48 VIK' }]);
    ledger([{ symbol: 'VIK', action: 'sell', asked: 48, quantity: 0, sent: false,
              setupId: 'S', destination: 'alp', error: 'refused' }]);
    expect(run()).toMatch(/signalled but NOTHING was sent/);
  });
});
