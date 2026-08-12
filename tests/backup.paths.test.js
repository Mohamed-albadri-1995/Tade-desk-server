/*
 * Where a tool's backup goes, and where its token comes from.
 *
 * Both of these were one bug wearing two hats. The token was read from THIS
 * tool's settings row only, so backing up meant pasting the same string into
 * nine screens on a phone — and in practice one tool backed up and eight did
 * not, silently, because a tool with no token throws inside a cron job nobody
 * watches.
 *
 * The moment that is fixed, a second problem appears that could not happen
 * before: every tool exports the same table names, and they all wrote to
 * `backups/<date>.json`. Nine tools sharing one token would have overwritten
 * each other every evening, leaving whichever finished last, with nothing to
 * show for it. Sharing the token is precisely what would have created that.
 *
 * So the two must ship together, and both are pinned here.
 */

const os = require('os');
const path = require('path');
const fs = require('fs');

const KEYS = path.join(os.tmpdir(), `keys-backup-${process.pid}.json`);
process.env.SHARED_KEYS_FILE = KEYS;

function load(toolId) {
  jest.resetModules();
  process.env.TOOL_ID = toolId;
  return require('../src/backup');
}

afterEach(() => { try { fs.unlinkSync(KEYS); } catch { /* absent */ } });
afterAll(() => { delete process.env.TOOL_ID; delete process.env.GITHUB_BACKUP_TOKEN; });

describe('backup folder per tool', () => {
  test('T1 keeps the flat path it has always used', () => {
    // Its existing history lives there. Moving it would strand every file
    // already pushed, and restore would quietly find nothing.
    expect(load('T1').backupDir()).toBe('backups');
  });

  test('every other tool gets its own folder', () => {
    expect(load('T2').backupDir()).toBe('backups/T2');
    expect(load('T9').backupDir()).toBe('backups/T9');
  });

  test('no two tools share a folder', () => {
    const dirs = ['T1', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'T8', 'T9']
      .map(id => load(id).backupDir());
    expect(new Set(dirs).size).toBe(dirs.length);
  });
});

describe('one token, nine tools', () => {
  test('the shared keys file is enough — no per-tool setting needed', () => {
    fs.writeFileSync(KEYS, JSON.stringify({ githubBackupToken: 'shared-tok' }));
    expect(load('T7').getGithubToken()).toBe('shared-tok');
  });

  test('the environment still works when there is no file', () => {
    process.env.GITHUB_BACKUP_TOKEN = 'env-tok';
    expect(load('T4').getGithubToken()).toBe('env-tok');
    delete process.env.GITHUB_BACKUP_TOKEN;
  });

  test('no token anywhere reads as absent, not as a broken string', () => {
    expect(load('T5').getGithubToken()).toBe('');
  });
});
