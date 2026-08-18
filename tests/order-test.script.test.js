/*
 * The dress rehearsal, and the trap it exists to avoid.
 *
 * broker.test() sends one naked share. It proves the hook is reachable, and
 * nothing whatever about the bracket or the split — which is where every real
 * failure has been: a three-leg strategy that placed one order, a runner sent
 * with a target, a take-profit the broker refused, a short with no borrow.
 *
 * THE TRAP, and the reason this script has a size calculation at all:
 *
 *   splitLegs floors every leg to whole shares. A 10% leg of 9 shares is 0.9,
 *   which floors to 0 and is dropped. So a strategy rehearsed at "a few
 *   shares" sends TWO orders where production sends three — and it passes,
 *   because two orders did go in and both were filled.
 *
 * A rehearsal that quietly tests a different shape than the one that will run
 * is worse than no rehearsal, because it is believed. So the default size is
 * the smallest at which every leg survives, derived from the fractions, and
 * asking for less than that says so in the output.
 */

const os = require('os');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { execFile } = require('child_process');

/*
 * The child is run ASYNCHRONOUSLY, and it has to be.
 *
 * The stub qp below lives in this same process. execFileSync blocks the event
 * loop until the child exits — so the child's very first request to the stub
 * would never be accepted, and the two would wait for each other forever. It
 * presents as a test run that hangs with no output at all, which reads like a
 * broken test file rather than a deadlock.
 */
const exec = (file, args, opts) => new Promise((resolve, reject) => {
  execFile(file, args, opts, (err, stdout, stderr) => {
    if (err) { err.stdout = stdout; err.stderr = stderr; return reject(err); }
    resolve({ stdout, stderr });
  });
});

const SCRIPT = path.join(__dirname, '..', 'scripts', 'order-test.js');

// ── a stand-in for qp ──────────────────────────────────────────────────────
/*
 * Two endpoints, answering exactly as qp does. A stub rather than the real
 * thing because this has to pass on a box where qp is not running, and because
 * the arithmetic under test is the SPLIT, not qp's leg pricing.
 */
const STRATEGIES = [
  { name: 'Three Legger', side: 'long', exit_protocol: {
      shape: '1 SL / 2 TP + runner (10%)',
      legs: [{ fraction: 0.1, r_multiple: 3 }, { fraction: 0.8, r_multiple: 6 }],
      runner: { fraction: 0.1, manage: 'eod' } } },
  { name: 'Simple Short', side: 'short', exit_protocol: {
      shape: '1 SL / 1 TP',
      legs: [{ fraction: 1, r_multiple: 2 }], runner: { fraction: 0, manage: 'eod' } } },
];

let server; let PORT;
beforeAll(done => {
  server = http.createServer((req, res) => {
    if (req.url.startsWith('/api/strategies')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, strategies: STRATEGIES }));
    }
    if (req.url.startsWith('/api/strategy/exit_plan')) {
      let raw = '';
      req.on('data', d => { raw += d; });
      return req.on('end', () => {
        const b = JSON.parse(raw || '{}');
        const s = STRATEGIES.find(x => x.name === b.name);
        const risk = Math.abs(b.entry - b.stop);
        const dir = b.side === 'short' ? -1 : 1;
        const plan = {
          legs: (s.exit_protocol.legs || []).map(l => ({
            fraction: l.fraction, r_multiple: l.r_multiple,
            price: Number((b.entry + dir * risk * l.r_multiple).toFixed(2)) })),
          runner: s.exit_protocol.runner.fraction,
          stop: b.stop, stop_kind: 'fixed',
        };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, name: s.name, side: b.side, plan }));
      });
    }
    res.writeHead(404); res.end('{}');
  }).listen(0, '127.0.0.1', () => { PORT = server.address().port; done(); });
});
/*
 * A block body, not an expression. `done => server.close(...)` RETURNS the
 * server, and jest refuses a hook that both takes done and returns something —
 * which fails the whole suite while every test inside it passes.
 *
 * The callback is also swallowed rather than forwarded: close() hands it an
 * argument, and any first argument to done() reads as a failure.
 */
afterAll(done => { server.close(() => done()); });

// ── a throwaway broker ─────────────────────────────────────────────────────

let DIR;
beforeEach(() => {
  DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ordertest-'));
  fs.writeFileSync(path.join(DIR, 'broker.json'), JSON.stringify({
    armed: true, enabled: true, allowShort: true, bracket: true,
    destinations: [{
      id: 'alp', name: 'Alpaca paper', dialect: 'alpaca', enabled: true,
      // A made-up hook id — the real ones live only in data/broker.json.
      webhookUrl: 'https://app.signalstack.com/hook/FAKEhook0000000000000a',
      buyingPower: 50000, ratio: 1, mode: 'auto', setups: [],
    }],
  }));
});
afterEach(() => { fs.rmSync(DIR, { recursive: true, force: true }); });

/*
 * The wire is replaced, not the code path. NODE_OPTIONS preloads a module that
 * swaps global.fetch for anything that is not the stub qp — so placeOrder runs
 * in full, splits, validates and records, and only the POST is caught.
 */
function withFakeWire() {
  const shim = path.join(DIR, 'shim.js');
  fs.writeFileSync(shim, `
    const real = global.fetch;
    const log = ${JSON.stringify(path.join(DIR, 'wire.jsonl'))};
    global.fetch = async (url, opts) => {
      if (String(url).includes('127.0.0.1')) return real(url, opts);
      require('fs').appendFileSync(log, opts.body + '\\n');
      return { ok: true, status: 201, headers: { get: () => 'application/json' },
               text: async () => JSON.stringify({ id: 'X', status: 'filled', price: 1 }) };
    };
  `);
  return shim;
}

async function run(args, { wire = false } = {}) {
  const shim = wire ? withFakeWire() : null;
  const { stdout } = await exec(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf8',
    env: { ...process.env,
      QP_URL: `http://127.0.0.1:${PORT}`,
      BROKER_FILE: path.join(DIR, 'broker.json'),
      BROKER_LEDGER: path.join(DIR, 'orders.jsonl'),
      // APPENDED, not replaced — the box sets its own NODE_OPTIONS and
      // overwriting them changes how the child runs in ways nothing here
      // controls.
      ...(shim ? { NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --require ${shim}`.trim() } : {}) },
  });
  const wireFile = path.join(DIR, 'wire.jsonl');
  const bodies = fs.existsSync(wireFile)
    ? fs.readFileSync(wireFile, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
  return { out: stdout, bodies };
}

// ── THE SIZE TRAP ──────────────────────────────────────────────────────────

describe('the default size fills every leg', () => {
  /*
   * The worst fraction is 10%, so ten shares is the floor: 1 / 8 / 1. At nine
   * the first leg is 0.9 and disappears.
   */
  test('a 10/80/10 strategy defaults to ten shares and three orders', async () => {
    const { out } = await run(['Three Legger', '--entry', '100', '--stop', '99']);
    expect(out).toMatch(/needs\s+10 share\(s\)/);
    expect(out).toMatch(/rehearsing\s+10 share\(s\)/);
    expect(out).toMatch(/for every leg to survive the whole-share floor/);
    expect(out).toMatch(/=> 3 JSONs/);
  });

  test('asking for less says the shape is no longer the real one', async () => {
    const { out } = await run(['Three Legger', '--entry', '100', '--stop', '99', '--shares', '5']);
    expect(out).toMatch(/BELOW 10/);
    expect(out).toMatch(/rehearses a DIFFERENT shape from production/);
    expect(out).toMatch(/=> 2 JSONs/);       // ...and it really is only two
  });

  test('a single-leg strategy needs only one share', async () => {
    const { out } = await run(['Simple Short', '--entry', '100', '--stop', '101']);
    expect(out).toMatch(/needs\s+1 share\(s\)/);
    expect(out).toMatch(/=> 1 JSON\b/);
  });
});

// ── the shape that goes out ────────────────────────────────────────────────

describe('what the rehearsal puts on the wire', () => {
  test('the last leg is a runner with NO take-profit', async () => {
    const { out } = await run(['Three Legger', '--entry', '100', '--stop', '99']);
    expect(out).toMatch(/RUNNER — stop only/);
    const runnerLine = out.split('\n').find(l => l.includes('"quantity":1') && !l.includes('take_profit'));
    expect(runnerLine).toBeTruthy();
  });

  test('every share sized is a share ordered', async () => {
    const { out } = await run(['Three Legger', '--entry', '100', '--stop', '99']);
    expect(out).toMatch(/10 of 10 share\(s\) ordered\s+✓/);
  });

  /*
   * A short's stop goes ABOVE the entry and its target BELOW. Backwards, the
   * risk per share is negative, the size becomes nonsense, and the rejection
   * that comes back talks about quantity rather than about the stop.
   */
  test('a short puts its stop above the entry and sells', async () => {
    const { out } = await run(['Simple Short', '--entry', '100']);
    expect(out).toMatch(/entry 100\s+stop 101/);
    expect(out).toContain('"action":"sell"');
    expect(out).toContain('"stop_loss_price":101');
    expect(out).toContain('"take_profit_price":98');
  });

  test('a long puts its stop below the entry and buys', async () => {
    const { out } = await run(['Three Legger', '--entry', '100']);
    expect(out).toMatch(/entry 100\s+stop 99/);
    expect(out).toContain('"action":"buy"');
  });
});

// ── sending, and not sending ───────────────────────────────────────────────

describe('the send switch', () => {
  test('WITHOUT --send nothing leaves the box', async () => {
    const { out, bodies } = await run(['Three Legger', '--entry', '100', '--stop', '99'], { wire: true });
    expect(out).toMatch(/DRY RUN — nothing was sent/);
    expect(bodies).toHaveLength(0);
    expect(fs.existsSync(path.join(DIR, 'orders.jsonl'))).toBe(false);
  });

  test('WITH --send all three legs really go', async () => {
    const { out, bodies } = await run(
      ['Three Legger', '--entry', '100', '--stop', '99', '--send'], { wire: true });
    expect(bodies).toHaveLength(3);
    expect(bodies.map(b => b.quantity)).toEqual([1, 8, 1]);
    // The runner, and only the runner, has no target.
    expect(bodies.filter(b => b.take_profit_price === undefined)).toHaveLength(1);
    expect(bodies[2].take_profit_price).toBeUndefined();
    // Every leg shares the stop.
    for (const b of bodies) expect(b.stop_loss_price).toBe(99);
    expect(out).toMatch(/result\s+SENT/);
    expect(out).toMatch(/leg 3\s+1 runner \(no target\)/);
  });

  /*
   * NO setupId. A rehearsal must not spend a real setup's daily allowance, and
   * — since the repeat guard went onto the ledger — must not lock a real
   * signal out of the name for the rest of the session.
   */
  test('the ledger line carries no setupId, so it locks nothing out', async () => {
    await run(['Three Legger', '--entry', '100', '--stop', '99', '--send'], { wire: true });
    const rows = fs.readFileSync(path.join(DIR, 'orders.jsonl'), 'utf8')
      .trim().split('\n').map(JSON.parse);
    expect(rows).toHaveLength(1);
    expect(rows[0].setupId).toBeNull();
    expect(rows[0].source).toMatch(/rehearsal/);

    const broker = require('../src/broker/signalstack');
    const day = rows[0].date;
    expect(broker.sentAlready(day, 'Three Legger', 'AAPL', 'alp')).toBe(false);
  });

  test('it tells you what to go and look for at the broker', async () => {
    const { out } = await run(['Three Legger', '--entry', '100', '--stop', '99', '--send'], { wire: true });
    expect(out).toMatch(/NOW CHECK THE BROKER/);
    expect(out).toMatch(/NO take-profit — this is the runner/);
  });
});

// ── it has to refuse clearly ───────────────────────────────────────────────

describe('when it cannot run', () => {
  test('an unknown strategy lists the ones that exist', async () => {
    let out = '';
    try { await run(['Nonesuch', '--entry', '100']); } catch (e) { out = e.stdout || ''; }
    expect(out).toMatch(/no strategy called "Nonesuch"/);
    expect(out).toContain('Three Legger');
  });

  test('--list shows how many orders each strategy is', async () => {
    const { out } = await run(['--list']);
    expect(out).toMatch(/Three Legger\s+long\s+3 order\(s\)/);
    expect(out).toMatch(/Simple Short\s+short\s+1 order\(s\)/);
  });

  test('a disarmed desk sends nothing and says which gate stopped it', async () => {
    const cfg = JSON.parse(fs.readFileSync(path.join(DIR, 'broker.json'), 'utf8'));
    cfg.enabled = false;
    fs.writeFileSync(path.join(DIR, 'broker.json'), JSON.stringify(cfg));
    const { out, bodies } = await run(
      ['Three Legger', '--entry', '100', '--stop', '99', '--send'], { wire: true });
    expect(out).toMatch(/NOTHING WOULD BE SENT — off/);
    expect(bodies).toHaveLength(0);
  });

  test('the hook is never printed', async () => {
    const { out } = await run(['Three Legger', '--entry', '100', '--stop', '99']);
    expect(out).not.toContain('FAKEhook0000000000000a');
  });
});
