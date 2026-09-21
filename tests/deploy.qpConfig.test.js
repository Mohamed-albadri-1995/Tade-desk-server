/*
 * A FLAG THAT DOES NOT EXIST STARTS NOTHING.
 *
 * `pm2 start ... --min-uptime 10000 --max-restarts 10` was pasted onto a live
 * box. pm2 answered:
 *
 *     error: unknown option `--min-uptime'
 *
 * and started nothing at all — so the command intended to stop qp restarting
 * 14,502 times left it not running instead. `min_uptime` and `max_restarts`
 * are ECOSYSTEM FILE fields. There is no command line for them.
 *
 * THE GUARD RAILS ARE THE POINT. pm2 reported qp `online` with five figures in
 * the restart column and an uptime of one second, for weeks, because port 8765
 * was held by an older copy of the same server and pm2's definition of
 * "online" is "I started it". A process that is broken should look broken.
 *
 *   min_uptime     a start that dies inside ten seconds did not succeed
 *   max_restarts   after ten of those, pm2 marks it `errored` and stops
 *
 * The file is REQUIRED here, not read as text: it is JavaScript, its cwd is
 * computed, and a file that throws on load is a deploy command that fails in
 * exactly the way the one it replaces did.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const CFG = path.join(ROOT, 'deploy', 'qp.config.js');

let app;
beforeAll(() => {
  // eslint-disable-next-line global-require, import/no-dynamic-require
  const mod = require(CFG);
  expect(Array.isArray(mod.apps)).toBe(true);
  expect(mod.apps).toHaveLength(1);
  [app] = mod.apps;
});

describe('it starts the same qp that was already working', () => {
  test('the interpreter is the script and the module is the argument', () => {
    // pm2 would otherwise hand a .py file to node.
    expect(app.script).toBe('/usr/bin/python3');
    expect(app.args.join(' ')).toBe('-m chart.server --host 0.0.0.0 --port 8765');
    expect(app.interpreter).toBe('none');
  });

  test('from quant-platform, because -m chart.server resolves nowhere else', () => {
    expect(path.resolve(app.cwd)).toBe(path.join(ROOT, 'quant-platform'));
    // DERIVED, not typed. A path written out by hand is a path that is right
    // on one box.
    expect(fs.readFileSync(CFG, 'utf8')).toContain("path.join(__dirname, '..', 'quant-platform')");
    // And it is really there.
    expect(fs.existsSync(path.join(app.cwd, 'chart', 'server.py'))).toBe(true);
  });

  test('the port matches the registry every other program navigates by', () => {
    const reg = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools.config.json'), 'utf8'));
    const qp = reg.apps.find(a => a.id === 'QP');
    expect(app.args).toContain(String(qp.port));
  });

  test('one process, in fork mode', () => {
    // Cluster mode would run two, and two servers cannot hold one port —
    // which is the exact failure this file exists because of.
    expect({ mode: app.exec_mode, n: app.instances }).toEqual({ mode: 'fork', n: 1 });
  });
});

describe('the guard rails, which is why it is a file', () => {
  test('a start that dies inside ten seconds is not a start', () => {
    expect(app.min_uptime).toBe(10000);
  });

  test('and after ten of those pm2 gives up instead of looping', () => {
    /*
     * THE NUMBER THAT MATTERED: 14,502. With this, pm2 stops at ten and the
     * process list says `errored` — which is a word somebody reads as a
     * problem, unlike `online`.
     */
    expect(app.max_restarts).toBe(10);
    expect(app.autorestart).toBe(true);
  });

  test('the memory ceiling is kept', () => {
    // qp sits at 35–90 MB; 500 MB is a leak, not a busy morning.
    expect(app.max_memory_restart).toBe('500M');
  });

  test('the log is timestamped — a crash at 09:34 has to be locatable', () => {
    expect(app.time).toBe(true);
  });

  test('these cannot be passed on a command line, and the file says so', () => {
    /*
     * The whole reason this file exists, written down where the next person
     * reaches for the shorter-looking option. pm2 does not warn and does not
     * fall back — it refuses the command and starts nothing.
     */
    const src = fs.readFileSync(CFG, 'utf8');
    expect(src).toContain("unknown option '--min-uptime'");
    expect(src).toContain('STARTS NOTHING');
  });
});

test('the server it starts refuses to lie about having started', () => {
  // The other half of the same fix: chart/server.py prints its banner only
  // once it owns the port, and exits non-zero with a reason when it does not.
  // pm2 can count a non-zero exit; it cannot count a banner.
  const py = fs.readFileSync(path.join(ROOT, 'quant-platform', 'chart', 'server.py'), 'utf8');
  const main = py.slice(py.indexOf('def main():'));
  expect(main.indexOf('probe.bind(')).toBeLessThan(main.indexOf("print(f'qp charting platform"));
  expect(main).toContain('raise SystemExit(3)');
});

test('min_uptime outlasts the port wait, or a restart can never succeed', () => {
  /*
   * THE TWO NUMBERS HAVE TO AGREE. chart/server.py waits for the port to come
   * free — a restart hands over, and the copy being replaced takes a moment to
   * let go. If pm2 counted anything shorter than that wait as a failed start,
   * a start that spent its time waiting and then succeeded would be marked
   * unstable for having been patient.
   *
   * Read from the Python rather than written here twice: two numbers that have
   * to agree, kept in two files, agree until somebody changes one.
   */
  const py = fs.readFileSync(path.join(ROOT, 'quant-platform', 'chart', 'server.py'), 'utf8');
  const wait = /'--port-wait',\s*type=float,\s*default=([\d.]+)/.exec(py);
  expect({ found: !!wait }).toEqual({ found: true });
  expect({ waitSeconds: Number(wait[1]) }).toEqual({ waitSeconds: 20 });
  // pm2 counts in milliseconds.
  expect(app.min_uptime).toBeLessThanOrEqual(Number(wait[1]) * 1000);
  // …and ten tries a second apart still outlast a twenty second handover only
  // if pm2 is not killing them first, which max_restarts alone would.
  expect(app.max_restarts).toBeGreaterThanOrEqual(10);
});

test('the port it waits for is the port it serves', () => {
  const py = fs.readFileSync(path.join(ROOT, 'quant-platform', 'chart', 'server.py'), 'utf8');
  const main = py.slice(py.indexOf('def main():'));
  // One variable, used by the probe, the message and uvicorn — not a literal
  // repeated three times that can drift into three ports.
  expect(main).toContain('probe.bind((args.host, args.port))');
  expect(main).toContain('uvicorn.run(app, host=args.host, port=args.port');
});
