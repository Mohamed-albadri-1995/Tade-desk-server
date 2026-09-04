/*
 * WHICH SCREENERS A TOOL COMES UP WITH — AND WHAT HAPPENS WHEN NOBODY SAID.
 *
 * T10 and T11 were added to tools.config.json and not to BY_TOOL, and the
 * seeder's fallback read:
 *
 *     const defs = BY_TOOL[config.toolId] || T1;
 *
 * So two brand-new growth-stock tools came up running T1's swing-trade
 * screeners — Trend, Pre-Mkt, Big Move — and spent two days collecting T1's
 * answers under their own names. Nothing threw. Nothing warned. On the landing
 * page they were online, green, and finding stocks.
 *
 * That is this repo's recurring failure in its purest form: an absence
 * answered with something plausible. The registry knew the tools existed; the
 * seeder did not; the gap was filled with a copy.
 *
 * Three things are checked here, and the first is the one that stops it
 * happening to tool twelve:
 *
 *   1. every tool in the registry has a screener set
 *   2. the two split tools carry T8's screeners, under their ORIGINAL keys
 *   3. a tool with no set seeds NOTHING, and says so
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const Database = require('better-sqlite3');

const ROOT = path.join(__dirname, '..');
const { PRESETS } = require('../src/sideA/seedScreeners');
const REGISTRY = require('../tools.config.json').tools;

/** Boot the seeder as a real process for one tool, against a throwaway DB. */
function seedAs(toolId, dbFile) {
  const r = execFileSync(process.execPath, ['-e', `
    const { seedScreeners } = require(${JSON.stringify(path.join(ROOT, 'src', 'sideA', 'seedScreeners'))});
    console.log(JSON.stringify(seedScreeners()));
  `], {
    env: { ...process.env, TOOL_ID: toolId, DB_PATH: dbFile },
    cwd: ROOT, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
  });
  return r;
}

const keysIn = dbFile => new Database(dbFile, { readonly: true })
  .prepare('SELECT key FROM screeners ORDER BY key').all().map(r => r.key);

let TMP;
beforeEach(() => { TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'seedset-')); });
afterEach(() => { fs.rmSync(TMP, { recursive: true, force: true }); });

// ── 1 · the gap that caused it ─────────────────────────────────────────────

describe('every tool in the registry has a screener set', () => {
  /*
   * THE TEST THAT WOULD HAVE CAUGHT IT. Adding a tool to tools.config.json is
   * one line, and the tool starts and serves a page whether or not anyone
   * remembered this file — which is exactly why the omission was invisible.
   */
  test('no tool is missing from BY_TOOL', () => {
    const missing = REGISTRY.map(t => t.id).filter(id => !PRESETS[id]);
    expect(missing).toEqual([]);
  });

  test('...and every set is a non-empty list of definitions', () => {
    for (const t of REGISTRY) {
      expect(Array.isArray(PRESETS[t.id])).toBe(true);
      expect(PRESETS[t.id].length).toBeGreaterThan(0);
    }
  });
});

// ── 2 · the two halves of T8 ───────────────────────────────────────────────

describe('the split tools carry T8\'s screeners, not T1\'s', () => {
  test('T10 ships the breakout and nothing else', () => {
    expect(PRESETS.T10.map(d => d.key)).toEqual(['canslim']);
  });

  test('T11 ships the pullback and nothing else', () => {
    expect(PRESETS.T11.map(d => d.key)).toEqual(['canslim-pullback']);
  });

  test('each is the SAME OBJECT T8 shipped — not a copy that can drift', () => {
    expect(PRESETS.T10[0]).toBe(PRESETS.T8.find(d => d.key === 'canslim'));
    expect(PRESETS.T11[0]).toBe(PRESETS.T8.find(d => d.key === 'canslim-pullback'));
  });

  /*
   * THE KEY AND THE NAME MUST NOT CHANGE.
   *
   * Every R1 row carried over from T8 is tagged with the screener's DISPLAY
   * NAME — see src/sideA/merge.js, and scripts/split-tool-history.js, which
   * matches on both. Renaming the screener to match its new tool would start a
   * second series that no longer joins up with the history the split exists to
   * preserve: the tool would show months of "CANSLIM" days and then, from the
   * rename onwards, days under another name, with nothing saying they are the
   * same screener.
   *
   * The TOOL is what got renamed. That lives in tools.config.json.
   */
  test('the screener keeps the key and name its history is tagged with', () => {
    expect(PRESETS.T10[0].name).toBe('CANSLIM');
    expect(PRESETS.T11[0].name).toBe('CANSLIM Pullback');
    const { SPLITS } = require('../scripts/split-tool-history');
    for (const s of SPLITS) {
      const def = PRESETS[s.tool][0];
      expect(def.key).toBe(s.screener);
      expect(def.name).toBe(s.label);
    }
  });

  test('and the tool itself is named for what it looks for', () => {
    const by = Object.fromEntries(REGISTRY.map(t => [t.id, t.name]));
    expect(by.T10).toBe('Growth Stock Breakout');
    expect(by.T11).toBe('Growth Stock Pullback');
  });

  test('neither carries a T1 screener', () => {
    const t1 = PRESETS.T1.map(d => d.key);
    for (const id of ['T10', 'T11']) {
      for (const def of PRESETS[id]) expect(t1).not.toContain(def.key);
    }
  });

  test('the universe screener is NOT carried — it is superseded', () => {
    for (const id of ['T10', 'T11']) {
      expect(PRESETS[id].map(d => d.key)).not.toContain('canslim-universe');
    }
  });
});

// ── 3 · seeding for real ───────────────────────────────────────────────────

describe('a fresh box seeds each tool its own screeners', () => {
  test('T10 comes up with the breakout', () => {
    const db = path.join(TMP, 't10.db');
    seedAs('T10', db);
    expect(keysIn(db)).toEqual(['canslim']);
  });

  test('T11 comes up with the pullback', () => {
    const db = path.join(TMP, 't11.db');
    seedAs('T11', db);
    expect(keysIn(db)).toEqual(['canslim-pullback']);
  });

  /*
   * THE FALLBACK IS GONE, and this is the whole point of the change.
   *
   * An empty tool is visibly empty: no screeners on its page, no cards,
   * nothing that could be mistaken for a result. A copy of T1 is a tool that
   * looks like it works. Between a gap you can see and a wrong answer you
   * cannot, the gap wins — so an unknown tool seeds nothing and SAYS SO.
   */
  test('a tool with no screener set seeds NOTHING, loudly', () => {
    const db = path.join(TMP, 't99.db');
    const out = seedAs('T99', db);
    expect(out).toMatch(/"seeded":0/);
    expect(keysIn(db)).toEqual([]);
  });

  test('...and the warning names the tool and what to do', () => {
    const db = path.join(TMP, 't99b.db');
    const r = require('child_process').spawnSync(process.execPath, ['-e', `
      require(${JSON.stringify(path.join(ROOT, 'src', 'sideA', 'seedScreeners'))}).seedScreeners();
    `], { env: { ...process.env, TOOL_ID: 'T99', DB_PATH: db }, cwd: ROOT, encoding: 'utf8' });
    const said = `${r.stdout || ''}${r.stderr || ''}`;
    expect(said).toMatch(/T99/);
    expect(said).toMatch(/seeded NOTHING rather than a copy of T1/);
  });
});

// ── 4 · the boxes already seeded wrong ─────────────────────────────────────

/*
 * T10 and T11 are RUNNING with T1's screeners right now. Seeding cannot reach
 * them — seedScreeners() returns the moment the table has a row — so the fix
 * has to be a migration, and it has to be safe to run on a tool that is
 * already correct.
 */
describe('a tool already seeded as a copy of T1 is repaired', () => {
  /** Put T1's three screeners in a T10 database, the way the bug did. */
  function seedWrong(dbFile) {
    execFileSync(process.execPath, ['-e', `
      const store = require(${JSON.stringify(path.join(ROOT, 'src', 'sideA', 'screenerStore'))});
      const { PRESETS } = require(${JSON.stringify(path.join(ROOT, 'src', 'sideA', 'seedScreeners'))});
      for (const d of PRESETS.T1) store.create(d);
    `], { env: { ...process.env, TOOL_ID: 'T10', DB_PATH: dbFile }, cwd: ROOT, stdio: 'pipe' });
  }

  function repair(dbFile, toolId = 'T10') {
    return execFileSync(process.execPath, ['-e', `
      const s = require(${JSON.stringify(path.join(ROOT, 'src', 'sideA', 'seedScreeners'))});
      console.log(JSON.stringify(s.fixMisseededSplitTools()));
    `], { env: { ...process.env, TOOL_ID: toolId, DB_PATH: dbFile }, cwd: ROOT, encoding: 'utf8' });
  }

  const rows = dbFile => new Database(dbFile, { readonly: true })
    .prepare('SELECT key, name, enabled FROM screeners ORDER BY key').all();

  test('the right screener is added', () => {
    const db = path.join(TMP, 'wrong.db');
    seedWrong(db);
    repair(db);
    expect(rows(db).find(r => r.key === 'canslim')).toBeTruthy();
  });

  /*
   * NOT DELETED. Those three collected a couple of days of cards, and every one
   * is frozen in the registers under its key. A register day whose definition
   * has vanished is a list of names with nothing to say what produced them.
   */
  test('T1\'s copies are switched off and RENAMED, never deleted', () => {
    const db = path.join(TMP, 'wrong2.db');
    seedWrong(db);
    repair(db);
    const t1 = rows(db).filter(r => ['trend', 'premarket', 'bigmoves'].includes(r.key));
    expect(t1).toHaveLength(3);
    for (const r of t1) {
      expect(r.enabled).toBeFalsy();
      expect(r.name).toMatch(/seeded by mistake/);
    }
  });

  test('running it twice changes nothing the second time', () => {
    const db = path.join(TMP, 'twice.db');
    seedWrong(db);
    repair(db);
    const before = rows(db);
    expect(JSON.parse(repair(db)).changed).toBe(0);
    expect(rows(db)).toEqual(before);
  });

  /*
   * A tool that is already correct must be left alone. The guard is "this tool
   * has NONE of its own screeners", not "this tool has a T1 screener" — someone
   * may have deliberately added one.
   */
  test('a correctly seeded tool is untouched', () => {
    const db = path.join(TMP, 'right.db');
    seedAs('T10', db);
    const before = rows(db);
    expect(JSON.parse(repair(db)).changed).toBe(0);
    expect(rows(db)).toEqual(before);
  });

  test('it only ever touches a tool the registry says was split', () => {
    const db = path.join(TMP, 't1.db');
    seedWrong(db);
    // T1 itself is not a split tool, so the same three screeners stay live.
    expect(JSON.parse(repair(db, 'T1')).changed).toBe(0);
    for (const r of rows(db)) expect(r.enabled).toBeTruthy();
  });
});
