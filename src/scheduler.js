const cron = require('node-cron');
const path = require('path');
const axios = require('axios');
const db = require('./db');
const { runFullScan } = require('./pipeline');
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

function startScheduler() {
  console.log('[Scheduler] Starting...');

  registerJob('Full Scan 7–9 AM ET', '*/30 7-8 * * 1-5', 'America/New_York', () => runFullScan());
  registerJob('Full Scan 9–10 AM ET', '*/5 9 * * 1-5', 'America/New_York', () => runFullScan());
  registerJob('Full Scan Off-Hours', '0 10,13,16 * * 1-5', 'America/New_York', () => runFullScan());
  registerJob('Shortlist Auto-Rule 9:35 AM', '35 9 * * 1-5', 'America/New_York', () => runAutoRule());
  registerJob('R1 Capture 9:36 AM', '36 9 * * 1-5', 'America/New_York', () => captureR1());
  registerJob('R2 Snapshot 9:26–9:56 AM', '26,31,36,41,46,51,56 9 * * 1-5', 'America/New_York', () => captureR2());
  registerJob('R2 Snapshot 10:01 AM', '1 10 * * 1-5', 'America/New_York', () => captureR2());
  registerJob('R3 EOD Capture 4:05 PM', '5 16 * * 1-5', 'America/New_York', () => captureR3());
  registerJob('Scorer Auto-Train 4:20 PM', '20 16 * * 1-5', 'America/New_York', () => autoTrainScorer());
  registerJob('Daily Backup 5:30 PM', '30 17 * * 1-5', 'America/New_York', () => pushBackup());
  registerJob('Midnight r0 Flush', '0 0 * * *', 'America/New_York', () => { r0.clearAll(); });

  console.log('[Scheduler] All jobs registered:', jobRegistry.length);
}

module.exports = { startScheduler, getJobRegistry, toggleJob, rescheduleJob, resetJobSchedule };
