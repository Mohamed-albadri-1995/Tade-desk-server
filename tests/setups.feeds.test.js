/*
 * THE FEED A LIVE DECISION CAN ACTUALLY USE.
 *
 * `OR + VWAP 09:35` was on polygon. The free plan is a day behind and allows
 * five requests a minute, so forty symbols could never finish inside the
 * eighteen seconds a clock setup has — both attempts timed out, every day, and
 * the desk reported "MISSED THE 09:35 WINDOW" as though qp had been slow. The
 * preference was right for backtesting a year and wrong for this morning's
 * bar, and nothing said so.
 *
 * Two things are checked here: that polygon is never used live, and that the
 * Alpaca keys qp needs are read from the desk's OWN files — so "the desk
 * thinks alpaca is available" and "qp has alpaca" are the same fact.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

let DIR;
beforeEach(() => {
  DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'feeds-'));
  process.env.SHARED_KEYS_FILE = path.join(DIR, 'keys.json');
  process.env.BROKER_FILE = path.join(DIR, 'broker.json');
  process.env.QP_ENV_FILE = path.join(DIR, '.env');
  jest.resetModules();
});
afterEach(() => {
  fs.rmSync(DIR, { recursive: true, force: true });
  delete process.env.SHARED_KEYS_FILE;
  delete process.env.BROKER_FILE;
  delete process.env.QP_ENV_FILE;
});

const feeds = () => require('../src/setups/feeds');
const write = (name, obj) => fs.writeFileSync(path.join(DIR, name), JSON.stringify(obj));

/* ── the substitution ────────────────────────────────────────────────────── */

const withKeys = () =>
  write('keys.json', { alpacaApiKey: 'PKFAKEACCOUNTAAAAAAA', alpacaApiSecret: 'fakesecretAAAA' });

describe('no Polygon-backed feed is ever the live feed', () => {
  test('with Alpaca keys on the desk, polygon becomes alpaca — and says so', () => {
    withKeys();
    const r = feeds().liveFeedFor('polygon');
    expect(r.feed).toBe('alpaca');
    expect(r.substituted).toBe(true);
    expect(r.chosen).toBe('polygon');
    expect(r.note).toMatch(/day behind/);
    expect(r.note).toMatch(/five requests a minute/);
    expect(r.note).toMatch(/Deciding on alpaca instead/);
  });

  /*
   * THE TWO THAT WERE MISSED, and they fail the same way for the same reason.
   * `hybrid` and `hybrid_yahoo` are Polygon's history with a second source
   * appended for the minutes Polygon has not published — so both call
   * polygon.load ONCE PER SYMBOL before they reach the part that is current.
   * Forty symbols at five requests a minute is the timeout that has been
   * printed as "MISSED THE 09:35 WINDOW" every morning, and a setup left on
   * either of them would have gone on printing it.
   *
   * They are the right feeds for the CHART — deep history, consolidated volume
   * on both sides of the seam. That is a different job.
   */
  test('hybrid and hybrid_yahoo are substituted too — the Polygon leg is per symbol',
    () => {
      withKeys();
      for (const f of ['hybrid', 'hybrid_yahoo']) {
        const r = feeds().liveFeedFor(f);
        expect(r.feed).toBe('alpaca');
        expect(r.substituted).toBe(true);
        expect(r.chosen).toBe(f);
        expect(r.note).toMatch(/Polygon history for every symbol/);
        expect(r.note).toMatch(/five requests a minute/);
      }
    });

  test('without keys it becomes yahoo, and says what would make it alpaca', () => {
    const r = feeds().liveFeedFor('polygon');
    expect(r.feed).toBe('yahoo');
    expect(r.note).toMatch(/add Alpaca keys/);
  });

  test('a feed that can decide live stands, with no note', () => {
    for (const f of ['yahoo', 'alpaca']) {
      const r = feeds().liveFeedFor(f);
      expect(r).toEqual({ feed: f, note: null, substituted: false, chosen: f });
    }
  });

  test('case does not matter', () => {
    withKeys();
    expect(feeds().liveFeedFor('Polygon').feed).toBe('alpaca');
    expect(feeds().liveFeedFor('Hybrid_Yahoo').feed).toBe('alpaca');
  });
});

/* ── the default nobody chose ────────────────────────────────────────────── */

/*
 * A setup with no feed preference decided on yahoo, whose intraday lag is
 * variable — 0 to 15 minutes, measured. A setup whose definition is "the 09:34
 * bar" cannot decide on a feed that has not published 09:34, so the runner's
 * stale gate skipped it, correctly and silently. That silence is the thing
 * this desk has spent a week explaining.
 */
describe('what decides when nobody has chosen', () => {
  test('with Alpaca keys it is alpaca, and the card says the default is deciding', () => {
    withKeys();
    for (const none of [null, undefined, '', '  ']) {
      const r = feeds().liveFeedFor(none);
      expect(r.feed).toBe('alpaca');
      // NOT a substitution — nothing was overridden. `chosen: null` is what
      // tells the card to say "no feed chosen" instead of naming one.
      expect(r.substituted).toBe(false);
      expect(r.chosen).toBeNull();
      expect(r.note).toMatch(/no feed chosen for this setup/);
    }
  });

  /*
   * THE COST IS ON THE CARD, NOT IN THIS FILE. Alpaca's free tier is IEX only,
   * so its volume is a few percent of the tape and every volume-weighted
   * number from it — session VWAP above all — is measured on that slice. The
   * trade is deliberate: a level slightly off can still be traded, a bar that
   * does not exist cannot. Saying so is the condition of taking it.
   */
  test('and it says what alpaca costs, rather than presenting it as free', () => {
    withKeys();
    const note = feeds().liveFeedFor(null).note;
    expect(note).toMatch(/IEX only/);
    expect(note).toMatch(/VWAP/);
    expect(note).toMatch(/backtest on alpaca/i);
  });

  test('with no keys it is still yahoo, and says what would change that', () => {
    const r = feeds().liveFeedFor(null);
    expect(r.feed).toBe('yahoo');
    expect(r.chosen).toBeNull();
    expect(r.note).toMatch(/0–15 minutes behind/);
    expect(r.note).toMatch(/Add Alpaca keys/);
  });
});

/* ── where the keys come from ────────────────────────────────────────────── */

describe('the Alpaca pair is read from the desk\'s own files', () => {
  test('keys.json first', () => {
    write('keys.json', { alpacaApiKey: ' PKFAKEACCOUNTAAAAAAA ', alpacaApiSecret: 'fakesecretAAAA' });
    write('broker.json', { destinations: [{ id: 'd', alpacaKeyId: 'PKOTHER', alpacaSecret: 'x' }] });
    const c = feeds().alpacaCreds();
    expect(c).toEqual({ key: 'PKFAKEACCOUNTAAAAAAA', secret: 'fakesecretAAAA', from: 'keys.json' });
  });

  test('then the first broker destination that carries a pair', () => {
    write('broker.json', { destinations: [
      { id: 'a', name: 'No keys' },
      { id: 'b', name: 'Paper', alpacaKeyId: 'PKFAKEACCOUNTAAAAAAA', alpacaSecret: 'fakesecretAAAA' },
    ] });
    const c = feeds().alpacaCreds();
    expect(c.key).toBe('PKFAKEACCOUNTAAAAAAA');
    expect(c.from).toBe('broker.json (Paper)');
  });

  test('half a pair is no pair', () => {
    write('keys.json', { alpacaApiKey: 'PKFAKEACCOUNTAAAAAAA' });
    expect(feeds().alpacaCreds()).toBeNull();
    expect(feeds().deskHasAlpaca()).toBe(false);
  });

  test('no files at all is no pair, not an error', () => {
    expect(feeds().alpacaCreds()).toBeNull();
  });
});

/* ── the sync into qp's .env ─────────────────────────────────────────────── */

describe('qp gets the pair from the desk on every deploy', () => {
  const sync = () => require('../scripts/sync-qp-env');

  test('lines are upserted and every other line is kept', () => {
    const before = 'POLYGON_API_KEY=abc\n# a comment\nOTHER=1\n';
    const after = sync().upsert(before, { APCA_API_KEY_ID: 'K', APCA_API_SECRET_KEY: 'S' });
    expect(after).toBe('POLYGON_API_KEY=abc\n# a comment\nOTHER=1\nAPCA_API_KEY_ID=K\nAPCA_API_SECRET_KEY=S\n');
  });

  test('an existing value is replaced in place, export prefix or not', () => {
    const before = 'export APCA_API_KEY_ID=old\nPOLYGON_API_KEY=abc\nAPCA_API_SECRET_KEY="old2"\n';
    const after = sync().upsert(before, { APCA_API_KEY_ID: 'K', APCA_API_SECRET_KEY: 'S' });
    expect(after).toBe('APCA_API_KEY_ID=K\nPOLYGON_API_KEY=abc\nAPCA_API_SECRET_KEY=S\n');
  });

  test('an empty file becomes just the two lines', () => {
    expect(sync().upsert('', { APCA_API_KEY_ID: 'K', APCA_API_SECRET_KEY: 'S' }))
      .toBe('APCA_API_KEY_ID=K\nAPCA_API_SECRET_KEY=S\n');
  });

  /*
   * THE EXIT CODE IS THE SIGNAL THE DEPLOY READS: 3 means the file changed and
   * qp must be restarted to see it; 0 means nothing to do. A sync that changed
   * the file and exited 0 would leave qp running with the old environment —
   * the exact state this script exists to end.
   */
  test('run as a script: writes the file and exits 3 when it changed', () => {
    write('keys.json', { alpacaApiKey: 'PKFAKEACCOUNTAAAAAAA', alpacaApiSecret: 'fakesecretAAAA' });
    fs.writeFileSync(path.join(DIR, '.env'), 'POLYGON_API_KEY=abc\n');
    const r = require('child_process').spawnSync(process.execPath,
      [path.join(__dirname, '..', 'scripts', 'sync-qp-env.js')],
      { env: { ...process.env }, encoding: 'utf8' });
    expect(r.status).toBe(3);
    const env = fs.readFileSync(path.join(DIR, '.env'), 'utf8');
    expect(env).toContain('POLYGON_API_KEY=abc');
    expect(env).toContain('APCA_API_KEY_ID=PKFAKEACCOUNTAAAAAAA');
    expect(env).toContain('APCA_API_SECRET_KEY=fakesecretAAAA');
    // NEVER PRINTED. The output says where the pair came from, not what it is.
    expect(r.stdout).not.toContain('fakesecretAAAA');
    expect(r.stdout).not.toContain('PKFAKEACCOUNTAAAAAAA');
    expect(r.stdout).toMatch(/from keys\.json/);
  });

  test('a second run changes nothing and exits 0', () => {
    write('keys.json', { alpacaApiKey: 'PKFAKEACCOUNTAAAAAAA', alpacaApiSecret: 'fakesecretAAAA' });
    const script = path.join(__dirname, '..', 'scripts', 'sync-qp-env.js');
    const run = () => require('child_process').spawnSync(process.execPath, [script],
      { env: { ...process.env }, encoding: 'utf8' });
    expect(run().status).toBe(3);
    const r = run();
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/already carries it/);
  });

  test('no pair on the desk: exits 0 and leaves .env alone', () => {
    fs.writeFileSync(path.join(DIR, '.env'), 'POLYGON_API_KEY=abc\n');
    const r = require('child_process').spawnSync(process.execPath,
      [path.join(__dirname, '..', 'scripts', 'sync-qp-env.js')],
      { env: { ...process.env }, encoding: 'utf8' });
    expect(r.status).toBe(0);
    expect(fs.readFileSync(path.join(DIR, '.env'), 'utf8')).toBe('POLYGON_API_KEY=abc\n');
    expect(r.stdout).toMatch(/no key pair on the desk/);
  });
});

/* ── the wiring ──────────────────────────────────────────────────────────── */

describe('it is wired in where the feed is read', () => {
  const src = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');

  test('the catalog reads the live feed through it, and carries the note', () => {
    const c = src('src', 'setups', 'catalog.js');
    expect(c).toContain('const live = feeds.liveFeedFor(p.feed)');
    expect(c).toContain('feed: live.feed,');
    expect(c).toContain('liveFeed: live.feed,');
    expect(c).toContain('feedNote: live.note,');
  });

  test('the deploy syncs qp\'s .env before restarting qp, and restarts on change', () => {
    const d = src('deploy-tools.sh');
    expect(d).toContain('node scripts/sync-qp-env.js');
    expect(d.indexOf('sync-qp-env.js')).toBeLessThan(d.indexOf('[6b/6] Chart platform'));
    expect(d).toContain('QP_FORCE_RESTART=1');
    /*
     * `|| SYNC_RC=$?`, NOT `; SYNC_RC=$?`. The script runs under `set -e`, and
     * the first deploy of this step wrote the keys, exited 3 to ask for a
     * restart, and the deploy stopped dead before [6b/6] — qp kept running
     * without them. An exit code that is a message must be read, not obeyed.
     */
    expect(d).toContain('node scripts/sync-qp-env.js || SYNC_RC=$?');
    expect(d).not.toContain('node scripts/sync-qp-env.js; SYNC_RC=$?');
    expect(d.slice(0, 200)).toContain('set -e');
    expect(d).toMatch(/\[ "\$RUNNING" = "\$WANT" \] && \[ -z "\$QP_FORCE_RESTART" \]/);
  });

  test('qp reads its own .env, whatever launched it', () => {
    const s = src('quant-platform', 'chart', 'server.py');
    expect(s).toContain('def _load_dotenv(');
    expect(s).toContain('_ENV_LOADED = _load_dotenv()');
    // existing environment wins — a launcher's deliberate value is not overwritten
    expect(s).toContain('if key and key not in os.environ:');
  });

  test('the page says which feed is chosen and which is used', () => {
    expect(src('public', 'alerts.html')).toContain('s.chosenFeed');
    expect(src('src', 'alerts', 'server.js')).toContain('feedNote: s.feedNote || null');
  });

  /*
   * `esc(null)` PRINTS THE WORD "null". With no preference chosenFeed is null
   * and there is still a note, so the unguarded template would have put
   * "(null chosen — …)" on the card where a feed name belongs.
   */
  test('the card only names a chosen feed when one was chosen', () => {
    expect(src('public', 'alerts.html'))
      .toContain('${s.chosenFeed ? `${esc(s.chosenFeed)} chosen — ` : \'\'}');
  });

  /*
   * THE SETTINGS NOTE NAMED THE WRONG FEED. It read "falling back to yahoo"
   * whatever the fallback was, and qp falls back to hybrid_yahoo whenever a
   * Polygon key exists — so the sentence contradicted the dropdown directly
   * above it. It now names the feed actually in force, and says that this
   * setting is the CHART's, not the one a live setup decides on.
   */
  test('the settings note names the feed in force, and says what it governs', () => {
    const a = src('public', 'alerts.html');
    expect(a).toContain('falling back to <b>${esc(d.defaultFeed)}</b>');
    expect(a).not.toContain("'not chosen — falling back to yahoo.");
    expect(a).toMatch(/feed for CHARTS and BACKTESTS/);
    expect(a).toMatch(/live setup decides on the feed on \n?\s*'?\s*\+?\s*'?its own card/);
  });
});
