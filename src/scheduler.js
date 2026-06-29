const cron = require('node-cron');
const { runFullScan } = require('./pipeline');
const { runAutoRule } = require('./sideF/shortlist');
const { captureR1, captureR2 } = require('./warehouse/registers');
const { pushBackup } = require('./backup');
const r0 = require('./r0/registry');

// Job registry — each entry tracks last run result for the monitor tab
const jobRegistry = [];

function registerJob(name, schedule, timezone, fn) {
  const entry = {
    name,
    schedule,
    timezone: timezone || 'America/New_York',
    lastRunAt: null,
    lastStatus: null, // 'ok' | 'error'
    lastError: null,
    lastDuration: null,
  };
  jobRegistry.push(entry);

  cron.schedule(schedule, async () => {
    const t0 = Date.now();
    entry.lastRunAt = t0;
    try {
      await fn();
      entry.lastStatus = 'ok';
      entry.lastError = null;
    } catch (err) {
      entry.lastStatus = 'error';
      entry.lastError = err.message;
      console.error(`[Scheduler] ${name} failed:`, err.message);
    }
    entry.lastDuration = Date.now() - t0;
  }, { timezone: entry.timezone });

  return entry;
}

function getJobRegistry() {
  return jobRegistry.map(j => ({
    name: j.name,
    schedule: j.schedule,
    timezone: j.timezone,
    lastRunAt: j.lastRunAt,
    lastStatus: j.lastStatus,
    lastError: j.lastError,
    lastDuration: j.lastDuration,
  }));
}

function startScheduler() {
  console.log('[Scheduler] Starting...');

  registerJob('Full Scan 7–9 AM ET (30 min)', '*/30 7-8 * * 1-5', 'America/New_York', () => runFullScan());
  registerJob('Full Scan 9–10 AM ET (5 min)', '*/5 9 * * 1-5', 'America/New_York', () => runFullScan());
  registerJob('Full Scan off-hours (3 hr)', '0 10,13,16,19,22 * * 1-5', 'America/New_York', () => runFullScan());
  registerJob('Shortlist Auto-Rule 9:35 AM', '35 9 * * 1-5', 'America/New_York', () => runAutoRule());
  registerJob('R1 Capture 9:36 AM', '36 9 * * 1-5', 'America/New_York', () => captureR1());
  registerJob('R2 Snapshot 9:25–10:00 AM', '25,30,35,40,45,50,55 9 * * 1-5', 'America/New_York', () => captureR2());
  registerJob('R2 Snapshot 10:00 AM', '0 10 * * 1-5', 'America/New_York', () => captureR2());
  registerJob('Daily Backup 5:30 PM', '30 17 * * 1-5', 'America/New_York', () => pushBackup());
  registerJob('Midnight r0 Flush', '0 0 * * *', 'America/New_York', () => { r0.clearAll(); });

  console.log('[Scheduler] All jobs registered:', jobRegistry.length);
}

module.exports = { startScheduler, getJobRegistry };
