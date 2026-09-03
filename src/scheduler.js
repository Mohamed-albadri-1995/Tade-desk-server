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
      /*
       * THE STACK, NOT JUST THE MESSAGE.
       *
       * This logged `err.message` alone, and on 2026-09-03 that produced
       * hundreds of lines of:
       *
       *     [Scheduler] Discovery — Open (09:00–10:00) failed:
       *       Cannot convert undefined or null to object
       *
       * A TypeError's message names no file, no line and no function. Every
       * discovery window on that tool had been failing — which is why its card
       * list barely moved and its setups had nothing new to decide on — and
       * the log could not say where. An error that repeats every five minutes
       * for weeks and cannot be located is worse than one that crashes: the
       * crash at least points somewhere.
       */
      console.error(`[Scheduler] ${entry.name} failed:`, err.stack || err.message);
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
  /*
   * The SETTINGS, once a day, from T1 only.
   *
   * pushBackup exports this tool's database. None of the settings clicked in on
   * the alerts page live in a database — they are JSON files in data/, which no
   * export has ever covered. They survive a deploy (data/ is gitignored, so
   * `git reset --hard` cannot touch them) and they survive nothing else: one
   * dead instance and the risk figures, the rank metric, the top-N and every
   * alert rule are gone with nothing to say what they were.
   *
   * T1 only, because the files are shared — nine tools pushing the same bundle
   * to the same path would be eight wasted commits and a race on the branch
   * head.
   *
   * Credentials are never in the bundle: see scripts/config-backup.sh, which
   * names the three files it sends and refuses the push outright if a scan
   * finds anything that looks like a key or a webhook.
   */
  if ((require('./config').toolId || 'T1') === 'T1') {
    registerJob('Settings Backup 5:35 PM', '35 17 * * 1-5', 'America/New_York',
      () => new Promise((resolve) => {
        const { execFile } = require('child_process');
        const script = require('path').join(__dirname, '..', 'scripts', 'config-backup.sh');
        execFile('bash', [script], { timeout: 120000 }, (err, out, errOut) => {
          // Logged, never thrown: a settings backup that fails must not take
          // the scheduler down with it, and the daily DB backup already ran.
          if (err) console.warn('[Scheduler] settings backup failed:', (errOut || err.message || '').trim());
          else console.log('[Scheduler] settings backup:', String(out).trim().split('\n').pop());
          resolve();
        });
      }));
  }
  registerJob('Midnight r0 Flush', '0 0 * * *', 'America/New_York', () => { r0.clearAll(); });

  /*
   * ── setups ──
   *
   * ONE job, every minute, rather than two jobs per setup registered at boot.
   *
   * A setup's definition lives in qp: its tools, and its decision time, which
   * is the entry window of the strategy itself. Registering cron jobs at
   * startup would freeze that — a strategy built in qp at eleven o'clock would
   * not run until the tools were restarted, one deleted there would keep
   * firing, and a decision time edited there would be ignored. The whole point
   * of reading the catalog live is lost the moment the schedule is a snapshot.
   *
   * So the tick asks. Every minute of the session it reads which setups this
   * tool owns and whether any is due now. That is a file read and one call to
   * a service on the same box, once a minute, against a decision worth being
   * right about.
   *
   * The universe scan two minutes earlier exists because the ordinary discovery
   * cadence can leave the card list five minutes old at the one moment it is
   * read — and a name that appeared in those five minutes is exactly the kind a
   * setup is looking for.
   */
  registerJob('Setup Tick (every minute, 04:00–16:00)',
    '* 4-16 * * 1-5', 'America/New_York', async () => {
      const now = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false,
      }).format(new Date());
      const catalog = require('./setups/catalog');
      const { runDue } = require('./setups/runner');
      let due = [];
      try {
        due = await catalog.forTool(require('./config').toolId);
      } catch (err) {
        console.warn('[Setups] could not read the catalog:', err.message);
        return;
      }
      /*
       * FRESHEN THE CARD LIST — AND NEVER LET THAT STOP THE DECISION.
       *
       * This was `await runFullScan()` with nothing around it, and a scan that
       * throws took the whole tick with it. The setups below never ran, and the
       * only trace was one line naming the JOB rather than the strategies:
       *
       *     [Scheduler] Setup Tick (every minute, 04:00–16:00) failed:
       *       Cannot convert undefined or null to object
       *
       * Which is backwards in the only way that matters. The scan is a
       * CONVENIENCE — it makes the card list a few minutes fresher — and the
       * decision is the point. Trading a list that is five minutes old is a
       * small cost; not deciding at all is the entire session. A setup whose
       * pre-decision scan failed still has yesterday's cards, still evaluates
       * them, and still places an order.
       *
       * So the scan is allowed to fail and say so, and the tick carries on.
       */
      if (due.some(s => s.universeScanAt === now && s.enabled !== false)) {
        console.log(`[Setups] ${now} — pre-decision scan`);
        try {
          await runFullScan();
        } catch (err) {
          console.warn('[Setups] the pre-decision scan failed — deciding on the '
            + 'card list as it stands:', err.stack || err.message);
        }
      }
      /*
       * A SETUP RUNS ONE MINUTE AFTER THE BAR IT DECIDES ON.
       *
       * The bar labelled 09:35 is not finished until 09:36:00. This tick used
       * to fire when the clock READ 09:35, so the work happened partway through
       * that minute — the first live session decided at 09:35:24, on a bar
       * that was 40% formed. Every number in it was provisional: the close was
       * the last print so far, the session VWAP was short a third of its
       * minute, and the entry condition was tested against both.
       *
       * A backtest always evaluates a COMPLETED bar, so the two were not
       * evaluating the same thing: a signal that qualified at 09:35:24 need
       * not have qualified at 09:35:59, and 09:35:59 is the version that was
       * measured, ranked and believed.
       *
       * `decidedOn` is therefore always the bar that has just CLOSED. WHICH
       * setups that bar belongs to is a separate question, answered below by
       * decidesOnBar — and for the 09:35 setup the answer is now the 09:34
       * bar, because its entry is the 09:35 OPEN. So it fires when the clock
       * reads 09:35 and the order lands inside the 09:35 minute, which is the
       * entry every backtest of it measured. It used to fire at 09:36 on the
       * 09:35 bar: a whole bar later than the strategy it was reproducing.
       *
       * If the feed has not published that bar yet, qp falls back to the last
       * one that exists and the alert records which — that is what the lag
       * column is for, and it is now the only way this can go wrong.
       */
      const decidedOn = catalog.minutesBefore(now, 1);
      /*
       * A CLOCK setup fires on ONE bar. A WATCH setup fires on any bar in its
       * window.
       *
       * qp has always carried both ends of the entry window and has always
       * evaluated a watch setup that way — `PML breakout` is 09:40 → 10:10 and
       * its entry may become true on any bar between. This side read only the
       * start, turned it into a single decision minute, and ran the setup once
       * at 09:41. Thirty minutes of the strategy did not happen, and nothing
       * said so: a setup that runs once and finds nothing publishes "nothing
       * qualified", which is indistinguishable from having looked all along.
       *
       * So the filter is now "is the bar we just closed inside this setup's
       * window", and a clock setup is the case where the window is one minute
       * wide. `runDue` still receives the bar, so nothing downstream changes.
       */
      /*
       * MATCHED ON THE BAR THE SETUP DECIDES FROM, not on its entry window.
       *
       * They are the same minute only under fill='close'. Every other model
       * enters at the NEXT bar's open, so a setup whose entry window is 09:35
       * decides on the completed 09:34 bar — which is what its backtest did.
       * Filtering on the entry window here asked the setup about a bar it does
       * not trade from, and after this tick moved it would never fire at all.
       */
      const firing = due.filter(s => s.enabled !== false
        && catalog.withinWindow(decidedOn,
                                s.decidesOnBar || s.decisionTime,
                                s.decidesUntilBar || s.windowEnd));
      if (firing.length) {
        const watching = firing.filter(s => s.watch).length;
        console.log(`[Setups] ${now} — ${firing.length} setup(s) on the `
          + `${decidedOn} bar${watching ? ` (${watching} watching a window)` : ''}`);
        /*
         * NAMED, AND ON THIS SIDE OF THE BOUNDARY. `runDue` already catches per
         * setup, but everything before that — reading the catalog again,
         * matching the window — could still throw and be reported as "Setup
         * Tick failed", which names the job and not one of the strategies that
         * did not run. When the desk takes nothing all day, the difference
         * between those two lines is the difference between knowing where to
         * look and not.
         */
        try {
          await runDue(decidedOn);
        } catch (err) {
          console.error(`[Setups] the ${decidedOn} bar was not decided for `
            + `${firing.map(s => s.id).join(', ')}:`, err.stack || err.message);
        }
      }
    });

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
