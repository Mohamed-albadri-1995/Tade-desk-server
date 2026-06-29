const cron = require('node-cron');
const { runFullScan } = require('./pipeline');
const { runAutoRule } = require('./sideF/shortlist');
const { captureR1, captureR2 } = require('./warehouse/registers');

function startScheduler() {
  console.log('[Scheduler] Starting...');

  // Full scan: 7:00 AM – 9:00 AM ET every 30 min
  // Cron: */30 7-8 * * 1-5 (ET = UTC-4/5, assuming UTC-4 EDT: ET 7am = UTC 11am)
  cron.schedule('0 11,11,12 * * 1-5', async () => {
    console.log('[Scheduler] 30-min scan (7–9 AM ET window)');
    try { await runFullScan(); } catch (e) { console.error(e.message); }
  }, { timezone: 'America/New_York' });

  // Full scan every 30 min: 7:00–9:00 AM ET
  cron.schedule('*/30 7-8 * * 1-5', async () => {
    console.log('[Scheduler] 30-min scan (7–9 AM ET)');
    try { await runFullScan(); } catch (e) { console.error(e.message); }
  }, { timezone: 'America/New_York' });

  // Full scan every 5 min: 9:00–10:00 AM ET
  cron.schedule('*/5 9 * * 1-5', async () => {
    console.log('[Scheduler] 5-min scan (9–10 AM ET)');
    try { await runFullScan(); } catch (e) { console.error(e.message); }
  }, { timezone: 'America/New_York' });

  // Full scan every 3 hours: 10 AM – 7 AM next day (off-hours)
  cron.schedule('0 10,13,16,19,22 * * 1-5', async () => {
    console.log('[Scheduler] 3-hour scan (10 AM–7 AM ET)');
    try { await runFullScan(); } catch (e) { console.error(e.message); }
  }, { timezone: 'America/New_York' });

  // Shortlist auto-rule at 9:35 AM ET daily (weekdays)
  cron.schedule('35 9 * * 1-5', () => {
    console.log('[Scheduler] Shortlist auto-rule at 9:35 AM ET');
    try { runAutoRule(); } catch (e) { console.error(e.message); }
  }, { timezone: 'America/New_York' });

  // R1 capture at 9:36 AM ET
  cron.schedule('36 9 * * 1-5', () => {
    console.log('[Scheduler] R1 capture at 9:36 AM ET');
    try { captureR1(); } catch (e) { console.error(e.message); }
  }, { timezone: 'America/New_York' });

  // R2 snapshots: 9:25–10:00 AM ET every 5 min
  cron.schedule('25,30,35,40,45,50,55 9 * * 1-5', () => {
    console.log('[Scheduler] R2 market snapshot capture');
    try { captureR2(); } catch (e) { console.error(e.message); }
  }, { timezone: 'America/New_York' });
  cron.schedule('0 10 * * 1-5', () => {
    try { captureR2(); } catch (e) { console.error(e.message); }
  }, { timezone: 'America/New_York' });

  console.log('[Scheduler] All jobs registered');
}

module.exports = { startScheduler };
