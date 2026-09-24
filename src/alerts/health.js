/*
 * THE HEALTH VIEW — IS EVERY PART OF THE DESK DOING ITS JOB, RIGHT NOW?
 *
 * Every failure this desk has had was diagnosed the same way: a phone, Termux,
 * `pm2 list`, `pm2 logs`, a curl to qp, and a guess. The qp restart loop ran
 * to 113,854 restarts before anyone saw the number. The 09:35 decision took
 * 27.5 of its 30 seconds on a morning the box had lost a core, and nothing
 * said "close to the limit". A manager pass that throws prints one console
 * line and tries again next minute, forever.
 *
 * So this asks each part the question that matters for it and answers in one
 * of three words:
 *
 *     ok      working
 *     warn    working, but near a limit or recently restarted — look soon
 *     bad     not working — the desk is not doing this job now
 *     null    could not be checked, and says why. NEVER shown as ok.
 *
 * Read-only. Every dependency is injected so each rule can be run in a test
 * against the exact state it describes.
 */
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const DECIDE_BUDGET_MS = 30000;          // src/setups/qpClient.js DECIDE_TIMEOUT_MS

const item = (id, label, status, detail, extra = {}) =>
  ({ id, label, status, detail, ...extra });

/** `pm2 jlist`, or null with the reason. */
function pm2List(timeoutMs = 5000) {
  return new Promise((resolve) => {
    execFile('pm2', ['jlist'], { timeout: timeoutMs, maxBuffer: 8 << 20 }, (err, out) => {
      if (err) return resolve({ error: err.code === 'ENOENT' ? 'pm2 is not on this PATH' : err.message });
      try {
        resolve({ list: JSON.parse(out) });
      } catch (e) {
        resolve({ error: `pm2 answered something that is not JSON: ${e.message}` });
      }
    });
  });
}

const ago = (ms) => {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return 'never';
  const s = Math.round(ms / 1000);
  if (s < 90) return `${s}s ago`;
  if (s < 5400) return `${Math.round(s / 60)} min ago`;
  return `${Math.round(s / 3600)} h ago`;
};

/* ── the processes ──────────────────────────────────────────────────────── */
function processes(pm2, now) {
  if (!pm2 || pm2.error) {
    return [item('pm2', 'Processes', null, `could not read pm2: ${(pm2 && pm2.error) || 'no answer'}`)];
  }
  return pm2.list.map((p) => {
    const env = p.pm2_env || {};
    const up = env.status === 'online';
    const uptime = up && env.pm_uptime ? now - env.pm_uptime : null;
    const restarts = env.restart_time || 0;
    // Recently restarted is the only restart count that means something now:
    // 492 over three months is history, one in the last five minutes is a
    // process that may be crash-looping.
    const fresh = uptime !== null && uptime < 5 * 60 * 1000;
    /*
     * MEMORY AGAINST ITS CEILING. The deploy starts every tool with
     * --max-memory-restart, and pm2 kills a process that crosses it — which
     * looks exactly like a crash loop and leaves nothing in the tool's own
     * error log. tool-T1 on 2026-09-24: 31 restarts in 16 minutes under a
     * 140 MB cap it was already at 101 MB of. Showing the two numbers side by
     * side is what tells a memory kill from a real crash.
     */
    const memMB = p.monit && p.monit.memory ? Math.round(p.monit.memory / 1048576) : null;
    const capMB = env.max_memory_restart ? Math.round(env.max_memory_restart / 1048576) : null;
    const nearCap = memMB !== null && capMB && memMB >= 0.85 * capMB;
    const status = !up ? 'bad' : ((fresh || nearCap) ? 'warn' : 'ok');
    const mem = memMB === null ? '' : ` · ${memMB}${capMB ? ` of ${capMB}` : ''} MB`;
    const detail = !up
      ? `${env.status || 'unknown'} — not running`
      : `up ${ago(uptime).replace(' ago', '')} · ${restarts} restart(s) in total${mem}`
        + (fresh ? ' · restarted in the last 5 min — crash-looping if this keeps showing' : '')
        + (nearCap ? ' · NEAR ITS MEMORY CEILING — pm2 restarts it when it crosses; '
          + 'raise TOOL_MAX_MEM_<ID> in the deploy' : '');
    return item(`pm2:${p.name}`, p.name, status, detail, {
      restarts, uptimeMs: uptime, memMB, capMB,
      cpu: p.monit ? p.monit.cpu : null,
    });
  });
}

/* ── qp, and how quickly it answers ─────────────────────────────────────── */
async function qpItem(health, clock) {
  const t0 = clock();
  let h;
  try { h = await health(); } catch (e) { h = { ok: false, error: e.message }; }
  const ms = clock() - t0;
  if (!h || !h.ok) {
    return item('qp', 'qp (strategy engine)', 'bad',
      `not answering: ${(h && h.error) || 'no answer'} — no setup can decide and no position can be managed`,
      { ms });
  }
  return item('qp', 'qp (strategy engine)', ms > 3000 ? 'warn' : 'ok',
    `answered in ${ms} ms${ms > 3000 ? ' — slow; the 09:35 decision has 30 s in total' : ''}`,
    { ms, build: h.build || null });
}

/* ── the scanning tools ─────────────────────────────────────────────────── */
async function toolItems(tools, ping) {
  const out = [];
  for (const t of tools) {
    if (t.enabled === false) continue;
    let r;
    try { r = await ping(t); } catch (e) { r = { ok: false, error: e.message }; }
    out.push(item(`tool:${t.id}`, `${t.id} ${t.name || ''}`.trim(),
      r.ok ? 'ok' : 'bad',
      r.ok ? `answering on port ${t.port}` : `not answering on port ${t.port}: ${r.error || 'no answer'}`));
  }
  return out;
}

/* ── the minute-by-minute manager ───────────────────────────────────────── */
function managerItem(b, now) {
  if (!b || !b.startedAt) {
    return item('manager', 'Position manager', null,
      'not started in this process — it starts with the alerts server');
  }
  const every = b.intervalMs || 60000;
  const late = b.lastTick ? now - b.lastTick : now - b.startedAt;
  if (late > 3 * every) {
    return item('manager', 'Position manager', 'bad',
      `no tick for ${ago(late).replace(' ago', '')} — open positions are not being managed`);
  }
  if (b.lastErrorAt && (!b.lastOk || b.lastErrorAt > b.lastOk)) {
    return item('manager', 'Position manager', 'bad',
      `the last pass FAILED ${ago(now - b.lastErrorAt)}: ${b.lastError} — exit rules and trailing stops are not being acted on`);
  }
  return item('manager', 'Position manager', b.running && b.skippedBusy ? 'warn' : 'ok',
    `last pass ${ago(b.lastOk ? now - b.lastOk : null)} · ${b.passes} pass(es) since start`
    + (b.skippedBusy ? ` · ${b.skippedBusy} minute(s) skipped because the previous pass was still running` : ''));
}

/* ── the end-of-session flatten ─────────────────────────────────────────── */
function flattenItem(b, cfg, now, today, nowET) {
  if (!cfg || !cfg.flatten) {
    return item('flatten', 'End-of-session close', 'warn',
      'SWITCHED OFF — nothing closes positions at the end of the day');
  }
  if (!b || !b.startedAt) {
    return item('flatten', 'End-of-session close', null, 'not started in this process');
  }
  const late = b.lastTick ? now - b.lastTick : now - b.startedAt;
  if (late > 3 * (b.intervalMs || 30000)) {
    return item('flatten', 'End-of-session close', 'bad',
      `the clock is not being watched (last tick ${ago(late)}) — ${cfg.flattenAt} will be missed`);
  }
  if (b.lastErrorAt && (!b.lastRanAt || b.lastErrorAt > b.lastRanAt)) {
    return item('flatten', 'End-of-session close', 'bad',
      `last attempt FAILED ${ago(now - b.lastErrorAt)}: ${b.lastError}`);
  }
  const past = nowET && cfg.flattenAt && nowET > cfg.flattenAt;
  const ranToday = b.lastRanDay === today;
  if (past && cfg.armed && !ranToday) {
    return item('flatten', 'End-of-session close', 'warn',
      `it is past ${cfg.flattenAt} and this process has not run today's close `
      + '(a restart after the minute also looks like this) — check Alpaca for open positions');
  }
  return item('flatten', 'End-of-session close', 'ok',
    ranToday ? `ran today ${ago(now - b.lastRanAt)}` : `waiting for ${cfg.flattenAt} ET`
      + (cfg.armed ? '' : ' (broker not armed — it will not close anything)'));
}

/* ── today's decisions ──────────────────────────────────────────────────── */
function decisionItems(runs) {
  const real = (runs || []).filter(r => !r.rehearsal && !r.dryRun);
  if (!real.length) {
    return [item('decide', 'Decisions today', null, 'no setup has decided yet today')];
  }
  const bySetup = new Map();
  for (const r of real) {
    const k = r.setup || r.setupId;
    if (!bySetup.has(k)) bySetup.set(k, []);
    bySetup.get(k).push(r);
  }
  return [...bySetup.entries()].map(([name, rs]) => {
    const failed = rs.filter(r => !r.ok);
    const slow = Math.max(0, ...rs.map(r => r.ms || 0));
    const pct = Math.round((100 * slow) / DECIDE_BUDGET_MS);
    const status = failed.length ? 'bad' : (pct >= 80 ? 'warn' : 'ok');
    const detail = failed.length
      ? `${failed.length} of ${rs.length} run(s) FAILED — last: ${failed[failed.length - 1].error || 'no reason given'}`
      : `${rs.length} run(s) · slowest ${(slow / 1000).toFixed(1)} s of the 30 s budget (${pct}%)`
        + (pct >= 80 ? ' — close to missing the minute' : '');
    return item(`decide:${name}`, name, status, detail, { slowestMs: slow || null });
  });
}

/* ── the whole report ───────────────────────────────────────────────────── */
async function report(deps = {}) {
  const now = (deps.now || Date.now)();
  const clock = deps.clock || Date.now;
  const { toETDate } = require('../utils/time');
  const today = toETDate(now);
  const reg = deps.tools || JSON.parse(fs.readFileSync(path.join(ROOT, 'tools.config.json'), 'utf8')).tools;
  const ping = deps.ping || (async (t) => {
    const axios = require('axios');
    try {
      await axios.get(`http://127.0.0.1:${t.port}/api/version`, { timeout: 3000 });
      return { ok: true };
    } catch (e) { return { ok: false, error: e.code || e.message }; }
  });
  const cfg = deps.brokerSettings ? deps.brokerSettings() : require('../broker/signalstack').settings();
  const nowET = deps.nowET || require('./flattener').etNow(now);

  const [pm2, qp, tools] = await Promise.all([
    deps.pm2 ? deps.pm2() : pm2List(),
    qpItem(deps.qpHealth || require('../setups/qpClient').health, clock),
    toolItems(reg, ping),
  ]);
  const groups = [
    { id: 'processes', title: 'Processes', items: processes(pm2, now) },
    { id: 'services', title: 'Services', items: [qp, ...tools] },
    { id: 'jobs', title: 'Jobs', items: [
      managerItem(deps.managerBeat ? deps.managerBeat() : require('../setups/manager').heartbeat(), now),
      flattenItem(deps.flattenBeat ? deps.flattenBeat() : require('./flattener').heartbeat(),
                  cfg, now, today, nowET),
    ] },
    { id: 'decisions', title: `Decisions today (${today})`,
      items: decisionItems(deps.runs ? deps.runs(today) : require('../setups/sessionLog').runsOn(today)) },
  ];
  const all = groups.flatMap(g => g.items);
  const worst = all.some(i => i.status === 'bad') ? 'bad'
    : all.some(i => i.status === 'warn') ? 'warn'
      : all.some(i => i.status === null) ? 'unknown' : 'ok';
  return { ok: true, at: now, status: worst, groups,
           counts: { bad: all.filter(i => i.status === 'bad').length,
                     warn: all.filter(i => i.status === 'warn').length,
                     unknown: all.filter(i => i.status === null).length } };
}

module.exports = { report, processes, managerItem, flattenItem, decisionItems, qpItem,
                   toolItems, DECIDE_BUDGET_MS };
