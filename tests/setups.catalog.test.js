/*
 * The setups list, built from qp's strategies.
 *
 * There is nothing to register on this side any more: a strategy that names its
 * tools and has an entry window IS a setup. These pin the three judgements that
 * makes — which strategies qualify, how a long and a short become one setup,
 * and where the decision time comes from — because each of them is a silent
 * failure otherwise. A strategy that quietly does not appear looks exactly like
 * a strategy that was never built, and one that appears at the wrong minute
 * fires at the wrong minute without complaining.
 */

const os = require('os');
const path = require('path');
const fs = require('fs');

const FILE = path.join(os.tmpdir(), `setup-prefs-cat-${process.pid}.json`);
process.env.SETUP_PREFS_FILE = FILE;

jest.mock('../src/setups/qpClient', () => ({ strategies: jest.fn() }));
const qp = require('../src/setups/qpClient');
const catalog = require('../src/setups/catalog');

beforeEach(() => {
  try { fs.unlinkSync(FILE); } catch { /* absent */ }
  qp.strategies.mockReset();
});
afterAll(() => { try { fs.unlinkSync(FILE); } catch { /* absent */ } });

const T2_LONG = {
  name: 'T2 10:00 VWAP Extension (Long)', side: 'long',
  tools: ['T2'], risk: { window_start: 1000 },
};
const T2_SHORT = {
  name: 'T2 10:00 VWAP Extension (Short)', side: 'short',
  tools: ['T2'], risk: { window_start: 1000 },
};

test('a strategy with tools and an entry window becomes a setup', async () => {
  qp.strategies.mockResolvedValue([T2_LONG]);
  const list = await catalog.list();
  expect(list).toHaveLength(1);
  expect(list[0].name).toBe('T2 10:00 VWAP Extension');
  expect(list[0].tools).toEqual(['T2']);
});

/*
 * A strategy with no tools is something being worked on in qp. Listing it as
 * runnable would be a promise nothing keeps — no tool would schedule it.
 */
test('a strategy naming no tools is not a setup', async () => {
  qp.strategies.mockResolvedValue([{ ...T2_LONG, tools: [] }, { ...T2_LONG, tools: undefined }]);
  expect(await catalog.list()).toEqual([]);
});

test('a strategy with no entry window is not a setup — there is nothing to schedule', async () => {
  qp.strategies.mockResolvedValue([{ ...T2_LONG, risk: {} }, { ...T2_LONG, risk: undefined }]);
  expect(await catalog.list()).toEqual([]);
});

/*
 * The long and the short are one setup. They are the same idea pointed both
 * ways and they run at the same minute on the same list; ranking them apart
 * would take the best long AND the best short every day rather than the best
 * two signals, which is a different strategy from the one that was tested.
 */
test('a long and a short are one setup, not two', async () => {
  qp.strategies.mockResolvedValue([T2_LONG, T2_SHORT]);
  const list = await catalog.list();
  expect(list).toHaveLength(1);
  expect(list[0].sides.sort()).toEqual(['long', 'short']);
  expect(list[0].strategies).toHaveLength(2);
});

/*
 * The time is the strategy's, not the setups system's. 10:00 belongs to this
 * one strategy; a 09:35 opening-range strategy must schedule at 09:35 without
 * anyone remembering to say so anywhere.
 */
/*
 * The qp rows behind a setup, carried so its tools can be changed later.
 * Without them a setup could be assigned once and never reassigned — adding a
 * second tool, or moving it off the wrong one, would mean going back to the
 * builder, which is the dead end the picker exists to remove.
 */
test('a setup carries the ids of the strategies behind it', async () => {
  qp.strategies.mockResolvedValue([{ ...T2_LONG, id: 7 }, { ...T2_SHORT, id: 8 }]);
  const s = (await catalog.list())[0];
  expect(s.strategyIds.sort()).toEqual([7, 8]);
});

test('a strategy saved without an id does not contribute a null one', async () => {
  // A null would be posted back as a path segment and write to nothing.
  qp.strategies.mockResolvedValue([{ ...T2_LONG, id: 7 }, { ...T2_SHORT, id: undefined }]);
  expect((await catalog.list())[0].strategyIds).toEqual([7]);
});

test('the decision time is read from the strategy entry window', async () => {
  qp.strategies.mockResolvedValue([
    T2_LONG,
    { name: 'Opening range', side: 'long', tools: ['T4'], risk: { window_start: 935 } },
  ]);
  const list = await catalog.list();
  const byName = Object.fromEntries(list.map(s => [s.name, s]));
  expect(byName['T2 10:00 VWAP Extension'].decisionTime).toBe('10:00');
  expect(byName['Opening range'].decisionTime).toBe('09:35');
  expect(byName['Opening range'].universeScanAt).toBe('09:33');
});

test('two strategies sharing a name but not a minute stay separate setups', async () => {
  qp.strategies.mockResolvedValue([
    T2_LONG, { ...T2_LONG, risk: { window_start: 1030 } },
  ]);
  expect((await catalog.list()).map(s => s.decisionTime).sort()).toEqual(['10:00', '10:30']);
});

/*
 * One setup, several tools — the strategy carries them, so a setup used by
 * three tools is one object rather than three copies that drift apart.
 */
test('a setup is run by every tool the strategy names', async () => {
  qp.strategies.mockResolvedValue([{ ...T2_LONG, tools: ['T2', 'T5'] }]);
  expect((await catalog.forTool('T5')).map(s => s.name)).toEqual(['T2 10:00 VWAP Extension']);
  expect(await catalog.forTool('T7')).toEqual([]);
});

/*
 * qp restarting must not empty the alerts page or crash a scheduler tick. The
 * list is read to draw a page and to decide whether anything is due; a run that
 * actually needs the platform reports a missing one loudly on its own.
 */
test('an unreachable qp lists nothing rather than throwing', async () => {
  qp.strategies.mockRejectedValue(new Error('ECONNREFUSED'));
  await expect(catalog.list()).resolves.toEqual([]);
});

/* The parts qp cannot hold: on/off and the card-field filter, merged on top. */
test('screener-side preferences are merged onto the qp definition', async () => {
  qp.strategies.mockResolvedValue([T2_LONG]);
  const id = (await catalog.list())[0].id;

  const prefs = require('../src/setups/prefs');
  prefs.setEnabled(id, false);
  prefs.saveSettings(id, {
    topN: 3,
    universe: { rules: [{ left: 'score', operator: 'egreater', right: 70 }] },
  });

  const s = await catalog.get(id);
  expect(s.enabled).toBe(false);
  expect(s.rank.topN).toBe(3);
  expect(s.universe.rules).toHaveLength(1);
  // The definition is untouched by any of it.
  expect(s.decisionTime).toBe('10:00');
});

test('defaults stand when nothing has been set', async () => {
  qp.strategies.mockResolvedValue([T2_LONG]);
  const s = (await catalog.list())[0];
  expect(s.enabled).toBe(true);
  expect(s.rank.topN).toBe(2);
  expect(s.tf).toBe('1m');
  expect(s.feed).toBe('yahoo');
  expect(s.universe).toBeNull();
});

test('an out-of-range window is refused rather than turned into a nonsense minute', async () => {
  expect(catalog.hhmm(1000)).toBe('10:00');
  expect(catalog.hhmm(935)).toBe('09:35');
  expect(catalog.hhmm(1099)).toBeNull();
  expect(catalog.hhmm(null)).toBeNull();
  expect(catalog.hhmm('nope')).toBeNull();
});
