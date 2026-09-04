/*
 * SPLITTING ONE TOOL'S HISTORY BETWEEN TWO NEW ONES.
 *
 * T8 ran three screeners against a single database, so "which of these
 * actually produces results" could not be answered — every register mixed
 * them. The two that remain are separate tools now, and this carries each
 * screener's own history across so they start with their past.
 *
 *     canslim           →  T10  Growth Stock Breakout
 *     canslim-pullback  →  T11  Growth Stock Pullback
 *     canslim-universe  →  dropped, superseded by chart/canslim.py
 *
 * This is the only thing in the change that MOVES DATA, so the properties
 * below are checked rather than reasoned about. The one that decides whether
 * the split is honest is the shared card: a name both screeners matched
 * belongs to BOTH tools, and giving it to one would understate whichever lost.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const Database = require('better-sqlite3');

const ROOT = path.join(__dirname, '..');
let DIR;

/** A T8-shaped database: two real screeners, one label-only, five R1 rows. */
function buildSource(file) {
  execFileSync(process.execPath, ['-e', `
    const db = require(${JSON.stringify(path.join(ROOT, 'src', 'db'))});
    const ins = db.prepare('INSERT OR REPLACE INTO r1_frozen (date,ticker,data,captured_at) VALUES (?,?,?,?)');
    const r3  = db.prepare('INSERT OR REPLACE INTO r3a (date,ticker,entry_price_a,captured_at) VALUES (?,?,?,?)');
    const mk = (t, keys) => JSON.stringify({ ticker: t, stock: { price: 10 }, screenerKeys: keys });
    // DISPLAY NAMES, because that is what merge.js writes into screenerKeys
    // despite the field's name — the fault the first dry run caught.
    ins.run('2026-08-01','AAA',mk('AAA',['CANSLIM']),1);
    ins.run('2026-08-02','BBB',mk('BBB',['CANSLIM']),1);
    ins.run('2026-08-01','CCC',mk('CCC',['CANSLIM Pullback']),1);
    ins.run('2026-08-03','DDD',mk('DDD',['CANSLIM','CANSLIM Pullback']),1);
    ins.run('2026-08-04','EEE',mk('EEE',['CANSLIM Universe']),1);
    // ...and one row written with the KEY, since older rows may carry either.
    ins.run('2026-08-05','FFF',mk('FFF',['canslim']),1);
    r3.run('2026-08-01','AAA',10.5,1);
    r3.run('2026-08-03','DDD',20.5,1);
    const s = db.prepare('INSERT OR REPLACE INTO screeners (key,name,enabled,filters,limit_n,label_only,updated_at) VALUES (?,?,?,?,?,?,?)');
    s.run('canslim','CANSLIM',1,'[]',50,0,1);
    s.run('canslim-pullback','CANSLIM Pullback',1,'[]',50,0,1);
    s.run('canslim-universe','CANSLIM Universe',1,'[]',50,1,1);
  `], { env: { ...process.env, DB_PATH: file }, cwd: ROOT, stdio: 'pipe' });
}

/*
 * Run the real script inside a throwaway tree that mirrors the repo layout.
 *
 * BOTH STREAMS. The warnings — a key that matches nothing, a missing screener
 * definition, a refused second run — go to stderr, and the first version of
 * this helper returned stdout only. It was blind to precisely the output it
 * existed to check, and the test passed by looking at the wrong half.
 */
function run(args = []) {
  const r = spawnSync(process.execPath,
    [path.join(DIR, 'scripts', 'split-tool-history.js'), ...args],
    { cwd: DIR, encoding: 'utf8' });
  return `${r.stdout || ''}${r.stderr || ''}`;
}

function open(file) {
  return new Database(path.join(DIR, 'data', file), { readonly: true });
}
const tickers = (f) => open(f).prepare('SELECT ticker FROM r1_frozen ORDER BY ticker')
  .all().map(r => r.ticker);

beforeEach(() => {
  DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'split-'));
  fs.mkdirSync(path.join(DIR, 'data'), { recursive: true });
  fs.mkdirSync(path.join(DIR, 'scripts'), { recursive: true });
  fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(DIR, 'node_modules'));
  fs.cpSync(path.join(ROOT, 'src'), path.join(DIR, 'src'), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'scripts', 'split-tool-history.js'),
                  path.join(DIR, 'scripts', 'split-tool-history.js'));
  buildSource(path.join(DIR, 'data', 't8.db'));
});
afterEach(() => { fs.rmSync(DIR, { recursive: true, force: true }); });

describe('each tool gets its own screener\'s rows', () => {
  test('the breakout tool gets the breakout rows', () => {
    run();
    expect(tickers('t10.db')).toEqual(['AAA', 'BBB', 'DDD', 'FFF']);
  });

  test('the pullback tool gets the pullback rows', () => {
    run();
    expect(tickers('t11.db')).toEqual(['CCC', 'DDD']);
  });

  /*
   * THE ONE THAT DECIDES WHETHER THE SPLIT IS HONEST. DDD was matched by both
   * screeners. It is one card that two screens found, and awarding it to a
   * single tool would understate whichever lost — which is exactly the
   * question the split exists to answer.
   */
  test('a card both screeners matched belongs to BOTH tools', () => {
    run();
    expect(tickers('t10.db')).toContain('DDD');
    expect(tickers('t11.db')).toContain('DDD');
  });

  test('the dropped screener\'s rows go nowhere', () => {
    run();
    // EEE was matched only by canslim-universe, which is superseded.
    expect(tickers('t10.db')).not.toContain('EEE');
    expect(tickers('t11.db')).not.toContain('EEE');
  });

  test('outcome rows follow the R1 rows they belong to', () => {
    run();
    // AAA and DDD have r3a rows; T10 owns both, T11 owns only DDD's.
    expect(open('t10.db').prepare('SELECT ticker FROM r3a ORDER BY ticker')
      .all().map(r => r.ticker)).toEqual(['AAA', 'DDD']);
    expect(open('t11.db').prepare('SELECT ticker FROM r3a').all()
      .map(r => r.ticker)).toEqual(['DDD']);
  });

  /*
   * WITHOUT ITS SCREENER THE NEW TOOL HAS A PAST AND NO FUTURE — a history it
   * cannot add to, which looks finished rather than broken.
   */
  test('the screener definition comes across, and only its own', () => {
    run();
    expect(open('t10.db').prepare('SELECT key FROM screeners').all()
      .map(s => s.key)).toEqual(['canslim']);
    expect(open('t11.db').prepare('SELECT key FROM screeners').all()
      .map(s => s.key)).toEqual(['canslim-pullback']);
  });
});

describe('it cannot damage what it reads', () => {
  test('the source is untouched', () => {
    const before = open('t8.db').prepare('SELECT COUNT(*) c FROM r1_frozen').get().c;
    run();
    const after = open('t8.db').prepare('SELECT COUNT(*) c FROM r1_frozen').get().c;
    expect(after).toBe(before);
    expect(after).toBe(6);
    expect(open('t8.db').prepare('SELECT COUNT(*) c FROM screeners').get().c).toBe(3);
  });

  test('--dry-run writes nothing at all', () => {
    const out = run(['--dry-run']);
    expect(out).toMatch(/DRY RUN/);
    expect(out).toMatch(/4 R1 rows over 4 dates/);
    expect(fs.existsSync(path.join(DIR, 'data', 't10.db'))).toBe(false);
    expect(fs.existsSync(path.join(DIR, 'data', 't11.db'))).toBe(false);
  });

  /*
   * RUNNING TWICE WOULD DOUBLE EVERY REGISTER, and a doubled register is not
   * obviously wrong from the outside — it is the same names, twice, which
   * reads as a busier screener.
   */
  test('a second run is REFUSED rather than doubling the history', () => {
    run();
    const out = run();
    expect(out).toMatch(/REFUSED/);
    expect(tickers('t10.db')).toEqual(['AAA', 'BBB', 'DDD', 'FFF']);   // not six
  });

  test('--force replaces rather than appends', () => {
    run();
    run(['--force']);
    expect(tickers('t10.db')).toEqual(['AAA', 'BBB', 'DDD', 'FFF']);
    expect(tickers('t11.db')).toEqual(['CCC', 'DDD']);
  });
});

describe('it says what it is about to do', () => {
  test('the dry run reports counts per tool, per table', () => {
    const out = run(['--dry-run']);
    expect(out).toMatch(/T10 ← canslim \/ CANSLIM/);
    expect(out).toMatch(/T11 ← canslim-pullback \/ CANSLIM Pullback/);
    expect(out).toMatch(/2 r3a/);
  });

  test('the dropped screener is NAMED, so it reads as a decision rather than '
    + 'an oversight', () => {
    expect(run(['--dry-run'])).toMatch(/Dropped, not carried anywhere: canslim-universe/);
  });

  test('--only splits one tool', () => {
    run(['--only', 'T10']);
    expect(fs.existsSync(path.join(DIR, 'data', 't10.db'))).toBe(true);
    expect(fs.existsSync(path.join(DIR, 'data', 't11.db'))).toBe(false);
  });

  /*
   * A KEY THAT MATCHES NOTHING IS THE MOST LIKELY MISTAKE — the mapping holds
   * database KEYS, not display names, and the two are free to differ. Silence
   * there would produce an empty tool that looks like a screener which never
   * found anything.
   */
  test('a screener key that matches no row WARNS rather than passing quietly',
    () => {
      const f = path.join(DIR, 'scripts', 'split-tool-history.js');
      fs.writeFileSync(f, fs.readFileSync(f, 'utf8')
        .replace("screener: 'canslim', label: 'CANSLIM',",
                 "screener: 'not-a-key', label: 'Also Not A Name',"));
      const out = run(['--dry-run']);
      expect(out).toMatch(/no R1 row carries 'not-a-key' or 'Also Not A Name'/);
      // AND IT SHOWS WHAT IS ACTUALLY THERE, so the mismatch answers itself
      // rather than costing another trip to the box. This is how the
      // key-versus-name confusion was found in the first place.
      expect(out).toMatch(/The source actually holds these labels:/);
      expect(out).toMatch(/'CANSLIM'/);
      expect(out).toMatch(/no screener row with key 'not-a-key'/);
    });
});

describe('the mapping is one place', () => {
  test('it maps database KEYS, and says so — the rows record keys, not names',
    () => {
      const src = fs.readFileSync(
        path.join(ROOT, 'scripts', 'split-tool-history.js'), 'utf8');
      expect(src).toMatch(/which is what the frozen R1 rows actually/);
      expect(src).toMatch(/despite that field's name/);
      const { SPLITS, DROPPED } = require('../scripts/split-tool-history');
      expect(SPLITS.map(s => s.screener)).toEqual(['canslim', 'canslim-pullback']);
      expect(SPLITS.map(s => s.tool)).toEqual(['T10', 'T11']);
      expect(DROPPED).toEqual(['canslim-universe']);
    });

  test('every target tool is a real entry in the registry', () => {
    const { SPLITS } = require('../scripts/split-tool-history');
    const ids = require('../tools.config.json').tools.map(t => t.id);
    for (const s of SPLITS) expect(ids).toContain(s.tool);
  });

  test('the source tool is archived, so the split can be checked against it '
    + 'rather than taken on trust', () => {
    const { SPLITS } = require('../scripts/split-tool-history');
    const reg = require('../tools.config.json').tools;
    for (const s of SPLITS) {
      const from = path.basename(s.from, '.db').toUpperCase();   // t8.db -> T8
      const tool = reg.find(t => t.id === from);
      expect(tool).toBeTruthy();
      expect(tool.archive).toBe(true);
    }
  });
});
