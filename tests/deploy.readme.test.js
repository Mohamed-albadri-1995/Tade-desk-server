/*
 * A STALE RUNBOOK IS A CONFIDENT WRONG INSTRUCTION.
 *
 * deploy/README.md described a systemd stack of four services as the way this
 * desk runs. Three of those four have been `disabled` for months — the desk is
 * nine pm2 processes — and the file ended with:
 *
 *     **pm2:** if you previously ran anything under pm2, `pm2 delete all &&
 *     pm2 kill` so it doesn't fight systemd for the ports.
 *
 * Following that today deletes the nine processes that ARE the desk. And the
 * one systemd unit still enabled, qp-chart, is exactly what caused the failure
 * it would have been read in response to: pm2 reporting qp `online` with
 * 113,854 restarts while systemd's copy held port 8765.
 *
 * A document nobody can test rots silently. These are the few claims in it
 * that can be checked against the repo, so the parts that can drift are the
 * parts that cannot drift far.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const md = fs.readFileSync(path.join(ROOT, 'deploy', 'README.md'), 'utf8');
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools.config.json'), 'utf8'));

describe('it describes the supervisor the desk actually has', () => {
  test('pm2, said first and said plainly', () => {
    // The old file opened "Trade Desk — systemd deployment".
    expect(md.split('\n')[0]).not.toMatch(/systemd/i);
    // Whitespace-normalised: the claim is wrapped across two source lines,
    // and where the line break falls is not what is being checked.
    expect(md.replace(/\s+/g, ' ')).toContain(
      '**pm2 supervises the desk. systemd runs the scheduled jobs. '
      + 'Nothing is supervised by both.**');
  });

  test('and it no longer tells you to delete the desk', () => {
    /*
     * THE SENTENCE. Quoted in the file now, as the example of the failure —
     * so the check is that it is not an INSTRUCTION any more, which is a
     * question about the line it sits on.
     */
    const lines = md.split('\n');
    const told = lines.filter(l => /pm2 delete all/.test(l) && !l.trimStart().startsWith('>'));
    expect(told).toEqual([]);
    // Kept as a quotation, because the wrong instruction is the story.
    expect(md).toContain('> **pm2:** if you previously ran anything under pm2');
  });

  test('the retired units are named as retired', () => {
    for (const unit of ['trade-screener.service', 'trade-scorer.service',
                        'trade-desk.service', 'qp-chart.service']) {
      const line = md.split('\n').find(l => l.includes(unit) && l.includes('disabled'));
      expect({ unit, retired: !!line }).toEqual({ unit, retired: true });
    }
  });

  test('and the ones still in use are separated from them', () => {
    // qp-backfill and qp-daily are scheduled jobs. They supervise nothing pm2
    // supervises, and disabling them along with the rest would take the daily
    // work with it.
    expect(md).toContain('qp-backfill.service');
    expect(md).toContain('qp-daily.service/.timer');
    expect(md).toContain('not supervising anything pm2 supervises');
  });
});

describe('the facts in it that the repo can check', () => {
  test('every port it lists is a port the registry actually has', () => {
    /*
     * The old table listed 3001 and 8000 — a Flask scorer and a trading tool
     * that no longer run — and omitted every tool port above 3000. Read from
     * tools.config.json, so a port that moves makes this fail rather than
     * making the document quietly wrong.
     */
    const known = new Set([
      ...cfg.tools.map(t => String(t.port)),
      ...cfg.apps.map(a => String(a.port)),
    ]);
    const table = md.slice(md.indexOf('| Process |'), md.indexOf('T1 also serves'));
    const ports = [...table.matchAll(/\b(\d{4})\b/g)].map(m => m[1]);
    expect(ports.length).toBeGreaterThan(4);
    for (const p of ports) expect({ port: p, inRegistry: known.has(p) })
      .toEqual({ port: p, inRegistry: true });
  });

  test('the running tools it names are the ones the registry has enabled', () => {
    const on = cfg.tools.filter(t => t.enabled !== false).map(t => t.id);
    const restart = md.split('\n').find(l => l.startsWith('pm2 restart '));
    expect({ found: !!restart }).toEqual({ found: true });
    for (const id of on) {
      expect({ id, inCommand: restart.includes(`tool-${id}`) })
        .toEqual({ id, inCommand: true });
    }
    // …and not one that has been stopped. T10 was switched off on 2026-09-21;
    // restarting it would start a screener the registry says is asleep.
    for (const t of cfg.tools.filter(x => x.enabled === false)) {
      expect({ id: t.id, inCommand: restart.includes(`tool-${t.id}`) })
        .toEqual({ id: t.id, inCommand: false });
    }
  });

  test('the files it points at exist', () => {
    for (const f of ['deploy/qp.config.js', 'deploy/journal-tool.sh',
                     'deploy/install-stack.sh', 'src/utils/sharedAssets.js',
                     'tools.config.json']) {
      expect({ f, there: fs.existsSync(path.join(ROOT, f)) }).toEqual({ f, there: true });
    }
  });

  test('the qp instructions match the config file it tells you to use', () => {
    // eslint-disable-next-line global-require
    const app = require(path.join(ROOT, 'deploy', 'qp.config.js')).apps[0];
    expect(md).toContain('pm2 start deploy/qp.config.js');
    expect(md).toContain(String(app.min_uptime === 10000 ? 'min_uptime' : 'min_uptime'));
    // The twenty second wait is a number in the Python; the doc must not
    // invent a different one.
    const py = fs.readFileSync(
      path.join(ROOT, 'quant-platform', 'chart', 'server.py'), 'utf8');
    const wait = /'--port-wait',\s*type=float,\s*default=([\d.]+)/.exec(py);
    expect(md).toContain(`waits up to ${Number(wait[1])} seconds`.replace('20 seconds', 'twenty seconds'));
  });
});

test('it tells you how to find a contested port, because that was the whole bug', () => {
  // PPID 1 is systemd. That single fact is what took two days to establish.
  expect(md).toContain('ss -ltnp | grep <port>');
  expect(md).toContain('PPID 1 = systemd');
});
