/*
 * Adding a column to the schema does not add it to a database that already
 * exists — CREATE TABLE IF NOT EXISTS silently does nothing. The tools deployed
 * earliest are the ones that miss out, which is backwards: they hold the most
 * history and are the most expensive to rebuild.
 *
 * This is not hypothetical. Run windows were added to the screeners table after
 * T2 and T3 were already running, and both crash-looped on every start for
 * thousands of restarts with "no such column: run_from".
 */

const path = require('path');
const os = require('os');
const fs = require('fs');
const Database = require('better-sqlite3');

const DB = path.join(os.tmpdir(), `mig-test-${process.pid}.db`);

afterAll(() => { try { fs.unlinkSync(DB); } catch { /* gone */ } });

test('a screeners table predating run windows is migrated, not crashed on', () => {
  // Exactly the shape T2's table had on the box.
  const legacy = new Database(DB);
  legacy.exec(`CREATE TABLE screeners (
    id INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1, filters TEXT NOT NULL, sort TEXT,
    limit_n INTEGER NOT NULL DEFAULT 50, updated_at INTEGER NOT NULL)`);
  legacy.prepare(`INSERT INTO screeners (key,name,enabled,filters,sort,limit_n,updated_at)
    VALUES (?,?,?,?,?,?,?)`).run('legacy', 'Legacy', 1, '[]', '{}', 50, Date.now());
  legacy.close();

  process.env.DB_PATH = DB;
  jest.isolateModules(() => { require('../src/db'); });

  const after = new Database(DB);
  const cols = after.prepare('PRAGMA table_info(screeners)').all().map(c => c.name);
  expect(cols).toContain('run_from');
  expect(cols).toContain('run_to');

  // the existing row survives, with the new columns empty rather than invented
  const row = after.prepare('SELECT * FROM screeners WHERE key = ?').get('legacy');
  expect(row.name).toBe('Legacy');
  expect(row.run_from).toBeNull();
  after.close();
});
