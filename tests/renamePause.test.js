/*
 * Renaming and pausing — a screener, and a whole tool.
 *
 * Two things were fixed in a file in the repo and could only be changed by
 * redeploying: what a tool is called, and whether it runs at all. A screener
 * could be renamed only by opening the whole editor, and could be switched off
 * but not PAUSED — the difference being that a pause records when and why, so
 * that coming back in a fortnight tells you whether this was a decision or
 * something forgotten.
 *
 * WHAT THESE TESTS ARE REALLY DEFENDING. Both operations look harmless and
 * both can quietly destroy history:
 *
 *   a rename that changed the KEY would orphan every card the screener has
 *   ever matched — the key is stamped on them, and last month's cards would
 *   point at a screener that no longer exists under that name
 *
 *   a pause that stopped only the scheduled scan, or only the button, would be
 *   a pause you could not trust; and one that dropped rows out of the register
 *   would be a deletion with a friendlier name
 *
 * So the assertions are about what must NOT move.
 */

process.env.DB_PATH = require('path').join(require('os').tmpdir(), `rp-test-${process.pid}.db`);

const store = require('../src/sideA/screenerStore');
const identity = require('../src/sideA/toolIdentity');
const config = require('../src/config');

const rule = [{ left: 'close', operation: 'egreater', right: 1 }];

afterAll(() => {
  try { require('fs').unlinkSync(process.env.DB_PATH); } catch { /* already gone */ }
});

describe('renaming a screener', () => {
  test('changes the name', () => {
    const s = store.create({ name: 'Morning Gappers', filters: rule });
    expect(store.rename(s.id, 'Opening Gaps').name).toBe('Opening Gaps');
  });

  test('does NOT change the key, because cards carry it', () => {
    // The key lands in `screenerKeys` on every card this screener matches. If a
    // rename rewrote it, every card from before the rename would point at a
    // screener that no longer exists under that name — history silently
    // orphaned by a typo fix.
    const s = store.create({ name: 'Volume Pop', filters: rule });
    const before = s.key;
    expect(store.rename(s.id, 'Completely Different Name').key).toBe(before);
  });

  test('a screener mirroring it follows the new name', () => {
    // The mirror link is stored BY NAME precisely so it survives a rename —
    // and that only works if something actually moves it.
    const a = store.create({ name: 'Long Side', filters: rule });
    const b = store.create({ name: 'Short Side', filters: rule, mirrorOf: 'Long Side' });
    store.rename(a.id, 'Upside');
    expect(store.get(b.id).mirrorOf).toBe('Upside');
  });

  test('refuses an empty name', () => {
    const s = store.create({ name: 'Keeps Its Name', filters: rule });
    expect(() => store.rename(s.id, '   ')).toThrow(/name is required/);
    expect(store.get(s.id).name).toBe('Keeps Its Name');
  });

  test('leaves every rule, window and limit exactly as they were', () => {
    // The reason a rename-only path exists: opening the full editor loads all
    // of these and gives every one of them a chance to be saved differently.
    const s = store.create({
      name: 'Untouched', filters: rule, limit: 17,
      runFrom: '09:30', runTo: '10:30', checkFrom: '09:35', checkTo: '10:00',
    });
    const after = store.rename(s.id, 'Renamed');
    expect(after.filters).toEqual(s.filters);
    expect(after.limit).toBe(17);
    expect([after.runFrom, after.runTo]).toEqual(['09:30', '10:30']);
    expect([after.checkFrom, after.checkTo]).toEqual(['09:35', '10:00']);
  });
});

describe('pausing a screener', () => {
  test('pausing switches it off and records WHEN', () => {
    const s = store.create({ name: 'Pause Me', filters: rule });
    expect(s.enabled).toBe(true);
    expect(s.pausedAt).toBeNull();
    const p = store.setPaused(s.id, true, 'rules being reworked');
    expect(p.enabled).toBe(false);
    expect(typeof p.pausedAt).toBe('number');
    expect(p.pausedReason).toBe('rules being reworked');
  });

  test('resuming clears the clock — it is not history', () => {
    const s = store.create({ name: 'Resume Me', filters: rule });
    store.setPaused(s.id, true, 'why');
    const r = store.setPaused(s.id, false);
    expect(r.enabled).toBe(true);
    expect(r.pausedAt).toBeNull();
    expect(r.pausedReason).toBeNull();
  });

  test('editing a paused screener does not reset "paused since"', async () => {
    // The one that matters. "Paused in March" is exactly the field you go
    // looking for when you find something odd in June, and stamping it on
    // every save would quietly answer "today" forever.
    const s = store.create({ name: 'Old Pause', filters: rule });
    store.setPaused(s.id, true, 'a while ago');
    const at = store.get(s.id).pausedAt;
    await new Promise(r => setTimeout(r, 5));
    store.update(s.id, { limit: 25 });
    expect(store.get(s.id).pausedAt).toBe(at);
    expect(store.get(s.id).limit).toBe(25);
  });

  test('a paused screener keeps its key, its rules and its mirror link', () => {
    // Pausing must be safe enough to do on a hunch and undo an hour later.
    // Nothing about the definition may move.
    const a = store.create({ name: 'Anchor', filters: rule });
    const s = store.create({
      name: 'Full Definition', filters: rule, limit: 33,
      runFrom: '10:00', runTo: '11:00', mirrorOf: 'Anchor',
    });
    const p = store.setPaused(s.id, true);
    expect(p.key).toBe(s.key);
    expect(p.filters).toEqual(s.filters);
    expect(p.limit).toBe(33);
    expect(p.mirrorOf).toBe('Anchor');
    expect([p.runFrom, p.runTo]).toEqual(['10:00', '11:00']);
    expect(store.get(s.id)).not.toBeNull();          // it still EXISTS
  });

  test('a paused screener is excluded from the enabled list, and only that', () => {
    const s = store.create({ name: 'Excluded When Paused', filters: rule });
    store.setPaused(s.id, true);
    expect(store.list({ enabledOnly: true }).map(x => x.id)).not.toContain(s.id);
    expect(store.list().map(x => x.id)).toContain(s.id);
  });
});

describe('the tool’s own name', () => {
  afterEach(() => { identity.rename(config.toolName); identity.resume(); });

  test('defaults to the name in the repo config', () => {
    expect(identity.name()).toBe(config.toolName);
    expect(identity.identity().renamed).toBe(false);
  });

  test('an override wins, and is reported as an override', () => {
    identity.rename('Morning Desk');
    expect(identity.name()).toBe('Morning Desk');
    const id = identity.identity();
    expect(id.renamed).toBe(true);
    expect(id.defaultName).toBe(config.toolName);   // the difference stays visible
  });

  test('setting it back to the config name CLEARS the override', () => {
    // Rather than storing a duplicate of it — otherwise a later change in the
    // repo would be shadowed forever by a copy of its own old value.
    identity.rename('Something Else');
    identity.rename(config.toolName);
    expect(identity.identity().renamed).toBe(false);
  });

  test('refuses empty and over-long names', () => {
    expect(() => identity.rename('  ')).toThrow(/name is required/);
    expect(() => identity.rename('x'.repeat(61))).toThrow(/too long/);
  });
});

describe('pausing the whole tool', () => {
  afterEach(() => identity.resume());

  test('records when and why', () => {
    expect(identity.isPaused()).toBe(false);
    identity.pause('reworking the screeners');
    const id = identity.identity();
    expect(id.paused).toBe(true);
    expect(typeof id.pausedAt).toBe('number');
    expect(id.pausedReason).toBe('reworking the screeners');
  });

  test('resuming clears it', () => {
    identity.pause('x');
    identity.resume();
    expect(identity.isPaused()).toBe(false);
    expect(identity.identity().pausedAt).toBeNull();
  });

  test('a paused tool refuses BOTH ways into a scan', async () => {
    // The guard lives inside runFullScan(), which is the single door the cron
    // job and the Run-scan button both arrive at. A pause that stopped only one
    // of them would be a pause nobody could trust — and testing the pipeline
    // rather than the scheduler is the point of this assertion.
    const { runFullScan, runRefreshOnly } = require('../src/pipeline');
    identity.pause('under test');
    const scan = await runFullScan();
    expect(scan.paused).toBe(true);
    expect(scan.rowsProcessed).toBe(0);
    // ...and it does not re-quote either: a register that kept moving while the
    // tool that built it was stopped would be a page that looks live and is not.
    expect((await runRefreshOnly()).skipped).toMatch(/paused/);
  });

  test('the scan status SAYS it is paused, so a quiet tool is not read as broken', () => {
    const { getScanStatus } = require('../src/pipeline');
    identity.pause('deliberately quiet');
    const st = getScanStatus();
    expect(st.paused).toBe(true);
    expect(st.pausedReason).toBe('deliberately quiet');
  });

  test('the page is told what pausing does before it is pressed', () => {
    // A destructive-looking button has to say what it actually does. This one
    // is not destructive, and that is exactly the thing worth saying.
    const note = identity.identity().pauseMeans;
    expect(note).toMatch(/stops new scans/i);
    expect(note).toMatch(/stays exactly as it is/i);
  });
});
