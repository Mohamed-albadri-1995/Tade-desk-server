/*
 * Setups added after deployment, from data/setups.json.
 *
 * The point is that adding one is a command rather than a code change: a setup
 * is a BINDING — which qp strategy decides it, whose card list is the universe,
 * when, how it is ranked, which cards are eligible — and none of that is logic.
 * The logic is the qp strategy and stays there. So there is no more risk in
 * loading a binding from a file than from a module, and a great deal less
 * friction in adding the second one.
 */

const os = require('os');
const path = require('path');
const fs = require('fs');

const FILE = path.join(os.tmpdir(), `setups-${process.pid}.json`);
process.env.SETUPS_FILE = FILE;

const setups = require('../src/setups');

function write(list) { fs.writeFileSync(FILE, JSON.stringify(list, null, 2)); }
beforeEach(() => { try { fs.unlinkSync(FILE); } catch { /* absent */ } });
afterAll(() => { try { fs.unlinkSync(FILE); } catch { /* absent */ } });

test('with no file, the built-ins stand', () => {
  expect(setups.all().map(s => s.id)).toContain('T2-VWAP-EXT');
});

test('an added setup joins the list', () => {
  write([{ id: 'T3-A', name: 'T3 A', toolId: 'T3', strategyId: 'Setup A',
           decisionTime: '10:00' }]);
  expect(setups.all().map(s => s.id).sort()).toEqual(['T2-VWAP-EXT', 'T3-A']);
  expect(setups.get('T3-A').strategyId).toBe('Setup A');
});

test('it is scheduled by the tool it names, and not by any other', () => {
  write([{ id: 'T3-A', name: 'T3 A', toolId: 'T3', strategyId: 'Setup A',
           decisionTime: '10:00' }]);
  expect(setups.forTool('T3').map(s => s.id)).toEqual(['T3-A']);
  expect(setups.forTool('T2').map(s => s.id)).toEqual(['T2-VWAP-EXT']);
});

/*
 * Replacing a shipped setup by id is how its ranking or its filter gets
 * adjusted without a code change — and how a bad edit is undone by deleting a
 * line rather than reverting a commit.
 */
test('a file entry with a built-in id replaces it rather than duplicating it', () => {
  write([{ id: 'T2-VWAP-EXT', name: 'mine', toolId: 'T2',
           strategyId: 'Something else', decisionTime: '11:00' }]);
  const all = setups.all().filter(s => s.id === 'T2-VWAP-EXT');
  expect(all).toHaveLength(1);
  expect(all[0].decisionTime).toBe('11:00');
});

/*
 * A half-written entry must not become a setup that runs. Missing the tool
 * means nothing schedules it; missing the strategy means qp is asked for
 * nothing — both would fail at 10:00 rather than at the moment they were saved.
 */
test('an entry missing what a binding needs is ignored', () => {
  write([
    { id: 'NO-TOOL', name: 'x', strategyId: 'S' },
    { id: 'NO-STRAT', name: 'x', toolId: 'T3' },
    { name: 'no id', toolId: 'T3', strategyId: 'S' },
  ]);
  expect(setups.all().map(s => s.id)).toEqual(['T2-VWAP-EXT']);
});

test('an unreadable file leaves the built-ins working', () => {
  fs.writeFileSync(FILE, '{ not json');
  expect(setups.all().map(s => s.id)).toContain('T2-VWAP-EXT');
});

test('either shape is accepted — a bare list or {setups: [...]}', () => {
  write({ setups: [{ id: 'T4-A', name: 'x', toolId: 'T4', strategyId: 'S' }] });
  expect(setups.get('T4-A')).toBeTruthy();
});

/*
 * Read per call, so a setup added while the tools are running is picked up on
 * the next decision instead of at the next restart. The decision is once a day;
 * a file read is nothing beside a network fetch per symbol.
 */
test('a setup added while running is seen without a restart', () => {
  expect(setups.get('LATE')).toBeNull();
  write([{ id: 'LATE', name: 'x', toolId: 'T5', strategyId: 'S' }]);
  expect(setups.get('LATE')).toBeTruthy();
});
