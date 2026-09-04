/*
 * A STOPPED TOOL STILL ANSWERS, AND ANSWERS WITH ITS OWN DATA.
 *
 * qp does not read the tools' databases — it reads the tools, over HTTP.
 * `chart/screener.py` builds its source list from tools.config.json and calls
 * `/api/warehouse/*` on each port. So stopping T3, T4, T5, T8 and T9 to fit a
 * 912 MB box would have taken every chart, print and backtest of their history
 * with them: not a quiet tool, an absent one.
 *
 * The archive serves those five from ONE read-only process, on their own
 * ports, with the same routes. Two properties make that safe, and both are
 * checked here rather than reasoned about:
 *
 *   1. EACH ARCHIVE READS ITS OWN DATABASE. They share a process and the
 *      warehouse reader holds a single module-level handle, so the failure
 *      mode is every tool answering with the FIRST one's data — correctly
 *      shaped, plausible, and wrong. That is the bug this file exists for.
 *
 *   2. NOTHING CAN BE WRITTEN. Not "no write route is mounted" — the handle
 *      itself is readonly, so a mistake is an exception at the moment it is
 *      made rather than an altered archive found months later.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
let DIR;
let A;
let B;

/** A database with the real schema and one distinctive R1 row. */
function seed(file, date, ticker) {
  execFileSync(process.execPath, ['-e', `
    const db = require(${JSON.stringify(path.join(ROOT, 'src', 'db'))});
    db.prepare('INSERT OR REPLACE INTO r1_frozen (date,ticker,data,captured_at) VALUES (?,?,?,?)')
      .run(${JSON.stringify(date)}, ${JSON.stringify(ticker)},
           JSON.stringify({ ticker: ${JSON.stringify(ticker)},
                            stock: { price: 1 }, screenerKeys: ['k1'] }),
           Date.now());
  `], { env: { ...process.env, DB_PATH: file }, cwd: ROOT, stdio: 'pipe' });
}

beforeAll(() => {
  DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-'));
  A = path.join(DIR, 'a.db');
  B = path.join(DIR, 'b.db');
  seed(A, '2026-08-01', 'AAA');
  seed(B, '2026-08-02', 'BBB');
});
afterAll(() => { fs.rmSync(DIR, { recursive: true, force: true }); });

const archive = () => require('../src/archive/server');

/*
 * IN A CHILD PROCESS, DELIBERATELY.
 *
 * The isolation works by dropping entries from node's `require.cache` so each
 * tool loads its own copy of the database module. Jest does not use node's
 * module registry — it has its own — so running this inside jest would test
 * jest's loader rather than the one production runs on, and could pass or fail
 * for reasons that say nothing about the archive.
 *
 * So it runs under plain node and the assertions read its output. Slower, and
 * it is the only version of this test that means anything.
 */
function inNode(script) {
  return execFileSync(process.execPath, ['-e', script],
    { cwd: ROOT, encoding: 'utf8', env: { ...process.env } });
}

describe('each archive reads its own database', () => {
  /*
   * THE ONE THAT MATTERS. Two fixtures with deliberately different content, so
   * "both answered" cannot pass by both reading the same file. The failure mode
   * is every archived tool serving the FIRST one's data — correctly shaped,
   * plausible, and wrong.
   */
  test('two archives in one process give two different answers', () => {
    const out = inNode(`
      const arch = require('./src/archive/server');
      const a = arch.readersFor(${JSON.stringify(A)});
      const b = arch.readersFor(${JSON.stringify(B)});
      process.stdout.write(JSON.stringify({
        a: a.getAvailableDates('R1'), b: b.getAvailableDates('R1'),
      }));
    `);
    const got = JSON.parse(out);
    expect(got.a).toEqual(['2026-08-01']);
    expect(got.b).toEqual(['2026-08-02']);
  });

  test('...and the rows are that tool\'s rows, not the first one loaded', () => {
    const out = inNode(`
      const arch = require('./src/archive/server');
      const a = arch.readersFor(${JSON.stringify(A)});
      const b = arch.readersFor(${JSON.stringify(B)});
      process.stdout.write(JSON.stringify({
        aRow: (a.getRegisterData('R1','2026-08-01')[0] || {}).ticker,
        bRow: (b.getRegisterData('R1','2026-08-02')[0] || {}).ticker,
        aSeesB: a.getRegisterData('R1','2026-08-02'),
      }));
    `);
    const got = JSON.parse(out);
    expect(got.aRow).toBe('AAA');
    expect(got.bRow).toBe('BBB');
    // AND NEITHER CAN SEE THE OTHER'S DATE. A shared handle would return rows
    // here rather than nothing.
    expect(got.aSeesB).toEqual([]);
  });

  test('the order they are opened in does not change what they answer', () => {
    const out = inNode(`
      const arch = require('./src/archive/server');
      const b = arch.readersFor(${JSON.stringify(B)});   // reversed on purpose
      const a = arch.readersFor(${JSON.stringify(A)});
      process.stdout.write(JSON.stringify({
        a: a.getAvailableDates('R1'), b: b.getAvailableDates('R1'),
      }));
    `);
    const got = JSON.parse(out);
    expect(got.a).toEqual(['2026-08-01']);
    expect(got.b).toEqual(['2026-08-02']);
  });
});

describe('nothing can be written', () => {
  /*
   * Enforced by the HANDLE. A route list can be added to; `readonly: true`
   * cannot be argued with.
   */
  test('the database refuses a write, a delete and a DDL', () => {
    const out = execFileSync(process.execPath, ['-e', `
      const db = require(${JSON.stringify(path.join(ROOT, 'src', 'db'))});
      const said = [];
      try { db.prepare('DELETE FROM r1_frozen').run(); said.push('DELETE ALLOWED'); }
      catch (e) { said.push('delete:' + e.code); }
      try { db.exec('CREATE TABLE evil (x)'); said.push('DDL ALLOWED'); }
      catch (e) { said.push('ddl:' + e.code); }
      said.push('read:' + db.prepare('SELECT COUNT(*) c FROM r1_frozen').get().c);
      process.stdout.write(said.join(' '));
    `], { env: { ...process.env, DB_PATH: A, DB_READONLY: '1' },
          cwd: ROOT, encoding: 'utf8' });
    expect(out).toMatch(/delete:SQLITE_READONLY/);
    expect(out).toMatch(/ddl:SQLITE_READONLY/);
    // AND READING STILL WORKS. A read-only archive that cannot read is just a
    // broken one.
    expect(out).toMatch(/read:1/);
  });

  test('a readonly handle seeds no settings and migrates no columns — a reader '
    + 'that fills in another tool\'s gaps is changing what it was asked only '
    + 'to read', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src', 'db', 'index.js'), 'utf8');
    expect(src).toMatch(/if \(!READONLY\) db\.exec\(/);
    expect(src).toMatch(/if \(READONLY\) return;/);
    expect(src).toMatch(/if \(!READONLY\) \{[\s\S]*insertSetting/);
    expect(src).toMatch(/readonly: true, fileMustExist: true/);
  });
});

describe('the HTTP surface', () => {
  let srv;
  let base;

  beforeAll(async () => {
    const arch = archive();
    const app = arch.appFor({ id: 'T3', name: 'Gappers', port: 0 },
                            arch.readersFor(A));
    await new Promise((r) => { srv = app.listen(0, r); });
    base = `http://127.0.0.1:${srv.address().port}`;
  });
  afterAll(() => { if (srv) srv.close(); });

  test('serves the registers a live tool would', async () => {
    const dates = await (await fetch(`${base}/api/warehouse/available-dates`)).json();
    expect(dates).toEqual(['2026-08-01']);
    const rows = await (await fetch(`${base}/api/warehouse/R1/2026-08-01`)).json();
    expect(rows[0].ticker).toBe('AAA');
  });

  test('lower-case register names work, because that is what qp sends', async () => {
    const rows = await (await fetch(`${base}/api/warehouse/r1/2026-08-01`)).json();
    expect(rows[0].ticker).toBe('AAA');
  });

  test('an unknown register is refused rather than answered with nothing',
    async () => {
      const res = await fetch(`${base}/api/warehouse/R99/2026-08-01`);
      expect(res.status).toBe(400);
    });

  /*
   * 405 AND A SENTENCE, not a bare 404. "No such thing here" invites a retry
   * against another path; "this is an archive and accepts no writes" is the
   * answer to the question actually being asked.
   */
  test('every write verb is refused, by name', async () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const res = await fetch(`${base}/api/warehouse/collect`, { method });
      expect(res.status).toBe(405);
      const body = await res.json();
      expect(body.archived).toBe(true);
      expect(body.error).toMatch(/read-only/);
    }
  });

  test('health says it is an archive and is NOT scanning', async () => {
    const h = await (await fetch(`${base}/health`)).json();
    expect(h.ok).toBe(true);
    expect(h.archived).toBe(true);
    // The fact that matters to anyone wondering why a register stopped growing.
    expect(h.scanning).toBe(false);
  });

  test('a page request says where the tool went, rather than a blank 404',
    async () => {
      const res = await fetch(`${base}/screeners`);
      expect(res.status).toBe(404);
      expect((await res.json()).error).toMatch(/archived/i);
    });
});

describe('what it serves comes from the registry', () => {
  test('only tools marked archive:true, with the deploy\'s own db paths', () => {
    const ids = archive().archived().map(t => t.id);
    const reg = JSON.parse(
      fs.readFileSync(path.join(ROOT, 'tools.config.json'), 'utf8'));
    expect(ids).toEqual(reg.tools.filter(t => t.archive).map(t => t.id));
    expect(ids.length).toBeGreaterThan(0);
  });

  test('the db path rule matches the deploy\'s — T1 keeps the original file, '
    + 'everything else is data/<id>.db', () => {
    const arch = archive();
    // Written in two places; written DIFFERENTLY would be silent — the archive
    // would open a file that does not exist and report an empty history for a
    // tool with years in it.
    const deploy = fs.readFileSync(path.join(ROOT, 'deploy-tools.sh'), 'utf8');
    expect(deploy).toMatch(/data\/tradedesk\.db/);
    expect(deploy).toMatch(/data\/\$\{lc\}\.db/);
    const paths = arch.archived().map(t => path.basename(t.db));
    for (const p of paths) expect(p).toMatch(/^(tradedesk|t\d+)\.db$/);
  });

  test('a tool with no database file is NOT served, because an archive that '
    + 'answers "no dates" for a missing file reads exactly like a tool that '
    + 'collected nothing', () => {
    const src = fs.readFileSync(
      path.join(ROOT, 'src', 'archive', 'server.js'), 'utf8');
    expect(src).toMatch(/existsSync\(tool\.db\)/);
    expect(src).toMatch(/NOT `\s*\+\s*'serving this one|NOT /);
  });
});
