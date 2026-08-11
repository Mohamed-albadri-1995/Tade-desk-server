/*
 * The permanent record of what fired, and exactly when.
 *
 * data/alert-fires.json is a FEED: capped, and cleared each morning so the
 * first alert of the day does not arrive under yesterday's close. That is right
 * for a phone and useless for the question that decides whether a setup is
 * worth keeping — "what did it signal last Tuesday, and at what second".
 *
 * The time is the part that has to be exact. A setup is meant to fire within
 * seconds of a fixed minute; 10:00:07 off a 09:59 bar is a healthy morning and
 * 10:00:52 is a feed that was late, and rounding either to "10:00" throws away
 * the only evidence of the difference.
 */

const os = require('os');
const path = require('path');
const fs = require('fs');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hist-'));
process.env.ALERT_FIRES_FILE = path.join(DIR, 'alert-fires.json');
process.env.ALERT_RULES_FILE = path.join(DIR, 'alert-rules.json');
process.env.ALERT_HISTORY_DIR = path.join(DIR, 'history');

const store = require('../src/alerts/store');

const fire = (over = {}) => ({
  ruleId: 'R1', rule: 'T2 10:00 VWAP Extension', ticker: 'LIFE', toolId: 'T2',
  date: '2026-08-06', at: Date.UTC(2026, 7, 6, 14, 0, 7, 412), // 10:00:07.412 ET
  kind: 'setup', level: 'trade', detail: 'BUY 100 LIFE', ...over,
});

beforeEach(() => {
  fs.rmSync(process.env.ALERT_HISTORY_DIR, { recursive: true, force: true });
  // The feed accumulates within a day by design, so it is cleared too — a test
  // asserting on it must see only what that test published.
  fs.rmSync(process.env.ALERT_FIRES_FILE, { force: true });
});
afterEach(() => { jest.restoreAllMocks(); });
afterAll(() => { fs.rmSync(DIR, { recursive: true, force: true }); });

test('a published fire is archived', () => {
  store.publishFires([fire()], '2026-08-06');
  const rows = store.history({ date: '2026-08-06' });
  expect(rows).toHaveLength(1);
  expect(rows[0].ticker).toBe('LIFE');
});

/* The whole point. Millisecond precision is kept, and a readable ET stamp is
 * written beside it so the file can be read without a tool. */
test('the exact moment is kept, to the millisecond', () => {
  store.publishFires([fire()], '2026-08-06');
  const row = store.history({ date: '2026-08-06' })[0];
  expect(row.at).toBe(Date.UTC(2026, 7, 6, 14, 0, 7, 412));
  expect(row.atET).toMatch(/10:00:07/);
  expect(row.atET).toMatch(/2026-08-06/);
});

/* Which bar the decision came off, kept beside the wall clock. The GAP between
 * them is the diagnosis when a fill looks wrong; either alone is not. */
test('the decision bar is kept alongside the fire time', () => {
  store.publishFires([fire({ setup: { decisionAt: '09:59', signal: 'LONG' } })], '2026-08-06');
  const row = store.history({ date: '2026-08-06' })[0];
  expect(row.setup.decisionAt).toBe('09:59');
  expect(row.atET).toMatch(/10:00:07/);
});

/*
 * The failure the feed has by design and this must not: a new day must not
 * erase the old one, or the record answers nothing a week later.
 */
test('a new session does not erase the previous one', () => {
  store.publishFires([fire()], '2026-08-06');
  store.publishFires([fire({ date: '2026-08-07', ticker: 'LSCC',
    at: Date.UTC(2026, 7, 7, 14, 0, 3) })], '2026-08-07');

  expect(store.history({ date: '2026-08-06' }).map(f => f.ticker)).toEqual(['LIFE']);
  expect(store.history({ date: '2026-08-07' }).map(f => f.ticker)).toEqual(['LSCC']);
  expect(store.historyDates()).toEqual(['2026-08-07', '2026-08-06']);
});

/* Unlike the feed, nothing is dropped: the cap is what makes the feed readable
 * and what would make the record a lie. */
test('nothing is trimmed, however many fire', () => {
  const many = Array.from({ length: store.MAX_PER_TOOL + 50 },
    (_, i) => fire({ ticker: `S${i}`, at: Date.UTC(2026, 7, 6, 14, 0, 0) + i }));
  store.publishFires(many, '2026-08-06');
  expect(store.history({ date: '2026-08-06', limit: 2000 }))
    .toHaveLength(store.MAX_PER_TOOL + 50);
});

test('newest first, matching the live feed', () => {
  store.publishFires([
    fire({ ticker: 'EARLY', at: Date.UTC(2026, 7, 6, 14, 0, 1) }),
    fire({ ticker: 'LATE', at: Date.UTC(2026, 7, 6, 14, 0, 9) }),
  ], '2026-08-06');
  expect(store.history({ date: '2026-08-06' }).map(f => f.ticker)).toEqual(['LATE', 'EARLY']);
});

test('one corrupt line does not cost the session', () => {
  store.publishFires([fire()], '2026-08-06');
  fs.appendFileSync(store.historyFile('2026-08-06'), '{ not json\n');
  store.publishFires([fire({ ticker: 'BBB' })], '2026-08-06');
  expect(store.history({ date: '2026-08-06' }).map(f => f.ticker).sort())
    .toEqual(['BBB', 'LIFE']);
});

test('a month with nothing in it reads as empty, not as an error', () => {
  expect(store.history({ date: '2019-01-02' })).toEqual([]);
  expect(store.historyDates()).toEqual([]);
});

/*
 * The archive must never be able to stop an alert. Losing the record is bad;
 * losing the alert that was about to be delivered because the record could not
 * be written is worse, and the two are one call apart.
 */
test('an unwritable archive does not stop the fire being published', () => {
  const spy = jest.spyOn(fs, 'appendFileSync').mockImplementation(() => {
    throw new Error('EACCES');
  });
  const quiet = jest.spyOn(console, 'error').mockImplementation(() => {});
  expect(() => store.publishFires([fire()], '2026-08-06')).not.toThrow();
  expect(store.recentFires('2026-08-06').map(f => f.ticker)).toEqual(['LIFE']);
  spy.mockRestore(); quiet.mockRestore();
});

/* Info lines are archived too, unlike the push. "Nothing qualified" is not
 * worth waking someone for and IS worth knowing a month later: it is the
 * difference between a setup that found nothing and one that never ran. */
test('status lines are archived, not only trades', () => {
  store.publishFires([fire({ level: 'info', ticker: null,
    detail: 'Nothing qualified. 34 evaluated.' })], '2026-08-06');
  expect(store.history({ date: '2026-08-06' })[0].detail).toMatch(/Nothing qualified/);
});
