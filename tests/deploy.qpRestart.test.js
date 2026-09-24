/*
 * THE DEPLOY RESTARTS qp THROUGH pm2, AND NEVER STARTS systemd's COPY.
 *
 * deploy-tools.sh step [6b/6] used to run `sudo systemctl restart qp-chart` on
 * a stale qp. qp-chart is the unit whose second copy of qp caused 113,854
 * restarts on 2026-09-23; it was disabled that day and qp moved to pm2. But a
 * disabled unit is still listed by `systemctl list-unit-files`, so the next
 * stale deploy would have found it and started it again.
 *
 * Run, not grepped: deploy/qp-restart.sh is executed against stub pm2,
 * systemctl, sudo and curl on PATH, and what it CALLED is what is checked.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPT = path.join(__dirname, '..', 'deploy', 'qp-restart.sh');

function run({ first, after, inPm2 = true, enabled = false, active = false, wait = 3,
               force = '' }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qprestart-'));
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  const log = path.join(dir, 'calls.log');
  const stub = (name, body) => {
    fs.writeFileSync(path.join(bin, name), `#!/bin/bash\n${body}\n`, { mode: 0o755 });
  };
  fs.writeFileSync(path.join(dir, 'first'), first ? JSON.stringify({ build: first }) : '');
  fs.writeFileSync(path.join(dir, 'after'), after ? JSON.stringify({ build: after }) : '');
  stub('curl', `if [ ! -f "${dir}/asked" ]; then touch "${dir}/asked"; cat "${dir}/first";
                else cat "${dir}/after"; fi`);
  stub('pm2', `echo "pm2 $*" >> "${log}"
               if [ "$1" = describe ]; then exit ${inPm2 ? 0 : 1}; fi; exit 0`);
  stub('systemctl', `echo "systemctl $*" >> "${log}"
               case "$1" in is-enabled) exit ${enabled ? 0 : 1};; is-active) exit ${active ? 0 : 3};; esac
               exit 0`);
  stub('sudo', `echo "sudo $*" >> "${log}"; exit 0`);
  stub('sleep', 'exit 0');
  const r = spawnSync('bash', [SCRIPT, 'abc1234', force], {
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, QP_WAIT: String(wait) },
    encoding: 'utf8',
  });
  const calls = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : [];
  fs.rmSync(dir, { recursive: true, force: true });
  return { out: r.stdout, code: r.status, calls };
}

test('qp already on this checkout: nothing is restarted', () => {
  const r = run({ first: 'abc1234' });
  expect(r.out).toMatch(/OK — running abc1234/);
  expect(r.calls.filter(c => /restart|start /.test(c))).toEqual([]);
});

test('a stale qp is restarted by pm2, and systemd is never asked to restart it', () => {
  const r = run({ first: 'old0000', after: 'abc1234' });
  expect(r.out).toMatch(/STALE — running old0000, this checkout is abc1234/);
  expect(r.calls).toContain('pm2 restart qp --update-env');
  expect(r.calls.some(c => /systemctl (re)?start qp-chart/.test(c))).toBe(false);
  expect(r.out).toMatch(/now running abc1234/);
});

test('an enabled qp-chart is switched OFF before the pm2 restart — the 09-23 loop', () => {
  const r = run({ first: 'old0000', after: 'abc1234', enabled: true });
  const off = r.calls.indexOf('sudo systemctl disable --now qp-chart');
  const restart = r.calls.indexOf('pm2 restart qp --update-env');
  expect(off).toBeGreaterThanOrEqual(0);
  expect(restart).toBeGreaterThan(off);
  expect(r.out).toMatch(/two supervisors, one port/);
});

test('a disabled, stopped qp-chart is left alone', () => {
  const r = run({ first: 'old0000', after: 'abc1234' });
  expect(r.calls.some(c => c.startsWith('sudo'))).toBe(false);
});

test('qp missing from pm2 is started from deploy/qp.config.js and saved', () => {
  const r = run({ first: '', after: 'abc1234', inPm2: false });
  expect(r.calls.some(c => /^pm2 start .*deploy\/qp\.config\.js$/.test(c))).toBe(true);
  expect(r.calls).toContain('pm2 save');
});

test('a restart that does not take says so, points at pm2 logs, and does not fail the deploy', () => {
  const r = run({ first: 'old0000', after: 'old0000', wait: 2 });
  expect(r.out).toMatch(/STILL old0000/);
  expect(r.out).toMatch(/pm2 logs qp/);
  expect(r.out).not.toMatch(/journalctl/);
  expect(r.code).toBe(0);
});

test('a changed .env forces a restart even on the right build', () => {
  const r = run({ first: 'abc1234', after: 'abc1234', force: '1' });
  expect(r.out).toMatch(/RESTART NEEDED/);
  expect(r.calls).toContain('pm2 restart qp --update-env');
});

test('the deploy waits longer than qp waits for its port', () => {
  const sh = fs.readFileSync(SCRIPT, 'utf8');
  const py = fs.readFileSync(path.join(__dirname, '..', 'quant-platform', 'chart', 'server.py'), 'utf8');
  const deployWait = Number(/WAIT="\$\{QP_WAIT:-(\d+)\}"/.exec(sh)[1]);
  const qpWait = Number(/'--port-wait',\s*type=float,\s*default=([\d.]+)/.exec(py)[1]);
  expect(deployWait).toBeGreaterThan(qpWait);
});

test('deploy-tools.sh calls it, and no longer restarts qp-chart itself', () => {
  const sh = fs.readFileSync(path.join(__dirname, '..', 'deploy-tools.sh'), 'utf8');
  expect(sh).toMatch(/bash deploy\/qp-restart\.sh "\$WANT" "\$QP_FORCE_RESTART"/);
  expect(sh).not.toMatch(/sudo systemctl restart qp-chart/);
});

/*
 * THE OLD deploy.sh IS RETIRED, and nothing tells you to run it. It ran
 * `pm2 delete all` and deployed a branch from August under process names
 * that no longer exist.
 */
describe('deploy.sh', () => {
  test('refuses, names the real deploy, and never reaches pm2', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'olddeploy-'));
    const log = path.join(dir, 'calls.log');
    for (const n of ['pm2', 'git', 'npm', 'sudo']) {
      fs.writeFileSync(path.join(dir, n), `#!/bin/bash\necho "${n} $*" >> "${log}"\n`, { mode: 0o755 });
    }
    const r = spawnSync('bash', [path.join(__dirname, '..', 'deploy.sh')], {
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}` }, encoding: 'utf8' });
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/\.\/deploy-tools\.sh/);
    expect(fs.existsSync(log)).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('no file tells you to run it', () => {
    const root = path.join(__dirname, '..');
    for (const f of ['README.md', 'deploy/README.md', 'scripts/set-alpaca-keys.js', 'src/pipeline.js']) {
      const t = fs.readFileSync(path.join(root, f), 'utf8');
      expect({ f, says: /(bash |\.\/|full )deploy\.sh/.test(t) }).toEqual({ f, says: false });
    }
  });
});
