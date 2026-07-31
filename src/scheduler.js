const cron = require('node-cron');
const path = require('path');
const axios = require('axios');
const db = require('./db');
const { runFullScan, runRefreshOnly } = require('./pipeline');
const { runAutoRule } = require('./sideF/shortlist');
const { captureR1, captureR2 } = require('./warehouse/registers');
const { captureR3 } = require('./sideH/capture');
const { pushBackup } = require('./backup');
const training = require('./training/trainingData');
const r0 = require('./r0/registry');
const { toETDate } = require('./utils/time');

const SCORER_URL = require('./config').scorerUrl;

async function autoTrainScorer() {
  const today = toETDate(Date.now());
  console.log('[Scheduler] Auto-train: starting for', today);
  try {
    // Pull today's R4A/R4B rows into the persistent training tables so the
    // training run always sees the freshest captured data alongside history.
    // (Side H already does this after EOD capture; this is a belt-and-braces
    // sync in case auto-train runs before/without a successful capture.)
    try { training.syncFromWarehouse(today); } catch (e) { /* non-fatal */ }

    const r4aPath = training.writeTrainingCSV('R4A');
    const r4bPath = training.writeTrainingCSV('R4B');
    const r4aCount = training.getRowCount('R4A');
    const r4bCount = training.getRowCount('R4B');

    if (!r4aPath || !r4bPath) {
      console.warn(
        '[Scheduler] Auto-train skipped: not enough accumulated rows — R4A:',
        r4aCount, 'R4B:', r4bCount
      );
      return;
    }
    console.log('[Scheduler] Auto-train: training on R4A=' + r4aCount + ' R4B=' + r4bCount + ' rows');
    const resp = await axios.post(`${SCORER_URL}/train`, { r4a: r4aPath, r4b: r4bPath }, { timeout: 180000 });
    if (resp.data?.ok) {
      console.log('[Scheduler] Auto-train complete for', today);
    } else {
      console.warn('[Scheduler] Auto-train failed:', resp.data?.error);
    }
  } catch (err) {
    console.warn('[Scheduler] Auto-train error (scorer may be offline):', err.message);
  }
}

const jobRegistry = [];

function slugify(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function makeHandler(entry) {
  return async () => {
    if (!entry.enabled) return;
    const t0 = Date.now();
    entry.lastRunAt = t0;
    try {
      await entry.fn();
      entry.lastStatus = 'ok';
      entry.lastError = null;
    } catch (err) {
      entry.lastStatus = 'error';
      entry.lastError = err.message;
      console.error(`[Scheduler] ${entry.name} failed:`, err.message);
    }
    entry.lastDuration = Date.now() - t0;
  };
}

function registerJob(name, defaultSchedule, timezone, fn) {
  const jobId = slugify(name);
  const tz = timezone || 'America/New_York';

  // Load persisted config from DB (user may have changed schedule or disabled it)
  const stored = db.prepare('SELECT schedule, enabled FROM scheduler_jobs WHERE job_id = ?').get(jobId);
  const schedule = stored ? stored.schedule : defaultSchedule;
  const enabled = stored ? stored.enabled === 1 : true;

  // Persist defaults so they show in DB (INSERT OR IGNORE keeps existing user edits)
  db.prepare('INSERT OR IGNORE INTO scheduler_jobs (job_id, schedule, enabled) VALUES (?, ?, 1)').run(jobId, defaultSchedule);

  const entry = {
    jobId,
    name,
    defaultSchedule,
    schedule,
    timezone: tz,
    enabled,
    fn,
    lastRunAt: null,
    lastStatus: null,
    lastError: null,
    lastDuration: null,
    cronTask: null,
  };
  jobRegistry.push(entry);

  if (enabled) {
    entry.cronTask = cron.schedule(schedule, makeHandler(entry), { timezone: tz });
  }

  return entry;
}

function toggleJob(jobId) {
  const entry = jobRegistry.find(j => j.jobId === jobId);
  if (!entry) return null;

  entry.enabled = !entry.enabled;
  db.prepare('INSERT OR REPLACE INTO scheduler_jobs (job_id, schedule, enabled) VALUES (?, ?, ?)').run(jobId, entry.schedule, entry.enabled ? 1 : 0);

  if (entry.enabled) {
    entry.cronTask = cron.schedule(entry.schedule, makeHandler(entry), { timezone: entry.timezone });
    console.log(`[Scheduler] Job enabled: ${entry.name}`);
  } else {
    if (entry.cronTask) {
      entry.cronTask.stop();
      entry.cronTask = null;
    }
    console.log(`[Scheduler] Job disabled: ${entry.name}`);
  }

  return entry;
}

function rescheduleJob(jobId, newSchedule) {
  if (!cron.validate(newSchedule)) {
    return { ok: false, error: 'Invalid cron expression' };
  }
  const entry = jobRegistry.find(j => j.jobId === jobId);
  if (!entry) return { ok: false, error: 'Job not found' };

  entry.schedule = newSchedule;
  db.prepare('INSERT OR REPLACE INTO scheduler_jobs (job_id, schedule, enabled) VALUES (?, ?, ?)').run(jobId, newSchedule, entry.enabled ? 1 : 0);

  if (entry.cronTask) {
    entry.cronTask.stop();
    entry.cronTask = null;
  }
  if (entry.enabled) {
    entry.cronTask = cron.schedule(newSchedule, makeHandler(entry), { timezone: entry.timezone });
  }

  console.log(`[Scheduler] Job rescheduled: ${entry.name} → ${newSchedule}`);
  return { ok: true };
}

function resetJobSchedule(jobId) {
  const entry = jobRegistry.find(j => j.jobId === jobId);
  if (!entry) return { ok: false, error: 'Job not found' };
  return rescheduleJob(jobId, entry.defaultSchedule);
}

function getJobRegistry() {
  return jobRegistry.map(j => ({
    jobId: j.jobId,
    name: j.name,
    defaultSchedule: j.defaultSchedule,
    schedule: j.schedule,
    timezone: j.timezone,
    enabled: j.enabled,
    lastRunAt: j.lastRunAt,
    lastStatus: j.lastStatus,
    lastError: j.lastError,
    lastDuration: j.lastDuration,
  }));
}

const pad = n => String(n).padStart(2, '0');

function startScheduler() {
  console.log('[Scheduler] Starting...');

  // ── discovery ──
  // A screener only runs inside its own window, so these say how OFTEN the tool
  // looks, not what it looks for; a scan that lands when every screener is
  // asleep finds nothing new and costs one quote call. That is what lets the
  // cadence be the same for every tool while the schedule differs per tool.
  //
  // The 09:00–10:00 five-minute cadence is load-bearing and should not be
  // thinned: r1 freezes at 09:36, and only what is in r0 by then ever reaches
  // the model. Everything discovered later is a live-trading candidate that no
  // amount of scanning will put into training.
  registerJob('Discovery — Pre-Market (04:00–09:00)', '*/30 4-8 * * 1-5', 'America/New_York', () => runFullScan());
  registerJob('Discovery — Open (09:00–10:00)', '*/5 9 * * 1-5', 'America/New_York', () => runFullScan());
  registerJob('Discovery — Session (10:00–16:00)', '*/15 10-15 * * 1-5', 'America/New_York', () => runFullScan());
  registerJob('Discovery — Close (16:00)', '0 16 * * 1-5', 'America/New_York', () => runFullScan());

  // ── refresh ──
  // Quotes only, for every card already on screen. Independent of the windows
  // on purpose: a screener going to sleep must stop finding new candidates
  // without freezing the ones it already found. Before this, a card discovered
  // at 09:40 kept its 09:40 prices until the next scan — which, after 10:00,
  // could be three hours later.
  registerJob('Refresh — Live Card Data (04:00–16:00)', '*/5 4-16 * * 1-5', 'America/New_York', () => runRefreshOnly());
  // ── capture ──
  // r1 is the only snapshot the model ever learns from, so it has to land while
  // this tool's screeners are actually finding things. A tool whose first
  // screener wakes at 10:00 froze an empty register every day at 09:36.
  const cap = require('./config').captureAt;
  const [r1H, r1M] = cap.r1.split(':').map(Number);
  const ruleMin = r1M === 0 ? 59 : r1M - 1;          // one minute before r1
  const ruleHour = r1M === 0 ? r1H - 1 : r1H;
  registerJob(`Shortlist Auto-Rule ${pad(ruleHour)}:${pad(ruleMin)}`,
    `${ruleMin} ${ruleHour} * * 1-5`, 'America/New_York', () => runAutoRule());
  registerJob(`R1 Capture ${cap.r1}`,
    `${r1M} ${r1H} * * 1-5`, 'America/New_York', () => captureR1());
  registerJob('R2 Snapshot 9:26–9:56 AM', '26,31,36,41,46,51,56 9 * * 1-5', 'America/New_York', () => captureR2());
  registerJob('R2 Snapshot 10:01 AM', '1 10 * * 1-5', 'America/New_York', () => captureR2());
  registerJob('R3 EOD Capture 4:05 PM', '5 16 * * 1-5', 'America/New_York', () => captureR3());
  registerJob('Scorer Auto-Train 4:20 PM', '20 16 * * 1-5', 'America/New_York', () => autoTrainScorer());
  registerJob('Daily Backup 5:30 PM', '30 17 * * 1-5', 'America/New_York', () => pushBackup());
  registerJob('Midnight r0 Flush', '0 0 * * *', 'America/New_York', () => { r0.clearAll(); });

  // Job identity comes from the name, so renaming a job leaves its old row
  // behind holding a schedule nothing reads any more. Harmless until someone
  // opens the table to work out why a change had no effect.
  try {
    const live = new Set(jobRegistry.map(j => j.jobId));
    const orphans = db.prepare('SELECT job_id FROM scheduler_jobs').all()
      .map(r => r.job_id).filter(id => !live.has(id));
    if (orphans.length) {
      const del = db.prepare('DELETE FROM scheduler_jobs WHERE job_id = ?');
      for (const id of orphans) del.run(id);
      console.log(`[Scheduler] Pruned ${orphans.length} job(s) no longer registered:`, orphans.join(', '));
    }
  } catch (e) { console.warn('[Scheduler] Could not prune old jobs:', e.message); }

  console.log('[Scheduler] All jobs registered:', jobRegistry.length);
}

module.exports = { startScheduler, getJobRegistry, toggleJob, rescheduleJob, resetJobSchedule };
