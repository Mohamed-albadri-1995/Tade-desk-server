/*
 * Recover days that were trimmed out of r1_frozen but were still part of the
 * model's training set.
 *
 * The training tables accumulate indefinitely while r1_frozen gets pruned, so
 * after clearing the training tables a rebuild can come back short: the rows
 * for those pruned days no longer have a source. They are still in the GitHub
 * backups, and this merges just those dates back in.
 *
 * Non-destructive: rows are inserted with INSERT OR IGNORE, so nothing already
 * in the database is modified. This is deliberately NOT the normal restore,
 * which replaces whole tables and would wipe every day captured since.
 *
 *   node scripts/recover_dates.js --from 2026-06-30 --dates 2026-06-29,2026-06-30
 */
const { mergeDatesFromBackup } = require('../src/backup');

function arg(name) {
  const i = process.argv.indexOf(name);
  return i > -1 ? process.argv[i + 1] : null;
}

(async () => {
  const from = arg('--from');
  const dates = (arg('--dates') || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!from || !dates.length) {
    console.error('usage: node scripts/recover_dates.js --from <backup-date> --dates <d1,d2>');
    process.exit(1);
  }
  try {
    const res = await mergeDatesFromBackup(from, dates);
    console.log(`Merged from backups/${res.backupDate}.json — dates ${res.dates.join(', ')}`);
    console.log(`  r1_frozen rows added : ${res.added.r1_frozen}`);
    console.log(`  r3a rows added       : ${res.added.r3a}`);
    console.log(`  r3b rows added       : ${res.added.r3b}`);
    console.log('\n(existing rows were left untouched)');
    console.log('Next: node scripts/rebuild_training.js --dry-run');
  } catch (e) {
    console.error('Failed:', e.message);
    process.exit(1);
  }
})();
