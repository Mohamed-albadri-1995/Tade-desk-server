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

/*
 * Which setups may place real orders.
 *
 * Two switches guard an order: the broker being armed — permission for the box
 * — and this one, permission for a strategy. One switch would have meant that
 * arming to trade something backtested for months also armed the scalp assigned
 * to a tool five minutes ago to see what it does.
 */
describe('permission to place orders', () => {
  test('a setup does not trade until it is told to', async () => {
    qp.strategies.mockResolvedValue([T2_LONG]);
    expect((await catalog.list())[0].autoTrade).toBe(false);
  });

  test('it is granted per setup, and only by saying so', async () => {
    qp.strategies.mockResolvedValue([
      T2_LONG,
      { name: 'Fashionably Late Scalp', side: 'long', tools: ['T2'], risk: { window_start: 1000 } },
    ]);
    const prefs = require('../src/setups/prefs');
    const list = await catalog.list();
    const t2 = list.find(s => s.name.startsWith('T2'));
    prefs.saveSettings(t2.id, { autoTrade: true });

    const after = await catalog.list();
    expect(after.find(s => s.name.startsWith('T2')).autoTrade).toBe(true);
    // The other one is untouched — that is the whole point of it being per setup.
    expect(after.find(s => s.name.startsWith('Fashionably')).autoTrade).toBe(false);
  });

  /* Only an actual boolean true. A truthy string arriving from a form must not
   * be what turns a setup into one that spends money. */
  test('anything short of true is false', async () => {
    qp.strategies.mockResolvedValue([T2_LONG]);
    const prefs = require('../src/setups/prefs');
    const id = (await catalog.list())[0].id;
    for (const v of ['true', 1, 'yes', {}]) {
      prefs.saveSettings(id, { autoTrade: v });
      expect((await catalog.list())[0].autoTrade).toBe(false);
    }
    prefs.saveSettings(id, { autoTrade: true });
    expect((await catalog.list())[0].autoTrade).toBe(true);
    prefs.saveSettings(id, { autoTrade: false });
    expect((await catalog.list())[0].autoTrade).toBe(false);
  });
});

/*
 * Whether a strategy can produce a clean alert and a clean order.
 *
 * The flow is: build and test in qp, then use it here — "as long as it has a
 * clear entry and clear exits". That has to be CHECKED rather than assumed,
 * because the failure is silent: a strategy with no stop cannot be ranked or
 * sized, so its signals are dropped without a word and the setup looks exactly
 * like one that simply never triggers.
 */
describe('readiness', () => {
  const withRisk = risk => ({ name: 'S', side: 'long', tools: ['T2'],
    entry: { rules: [{ left: 'a' }] }, risk: { window_start: 1000, ...risk } });

  test('a strategy with an entry, a stop and a target is ready', () => {
    const r = catalog.readiness([withRisk({
      sl: { type: 'pct', value: 1, freeze: true },
      targets: [{ fraction: 1, r_multiple: 2 }],
    })]);
    expect(r.ok).toBe(true);
    expect(r.blocking).toEqual([]);
    expect(r.warnings).toEqual([]);
  });

  /* The silent one. Without a stop there is no ranking metric and no size. */
  test('no stop is blocking, and says why it would look like nothing happening', () => {
    const r = catalog.readiness([withRisk({})]);
    expect(r.ok).toBe(false);
    expect(r.blocking.join()).toMatch(/no stop/);
    expect(r.blocking.join()).toMatch(/without a word/);
  });

  test('no entry rules is blocking', () => {
    const r = catalog.readiness([{ name: 'S', risk: { sl: { type: 'pct', freeze: true } } }]);
    expect(r.blocking.join()).toMatch(/no entry rules/);
  });

  /* Warnings are things that WILL trade but not as tested. */
  test('an indicator-following stop warns rather than blocks', () => {
    const r = catalog.readiness([withRisk({ sl: { type: 'prim' },
      targets: [{ fraction: 1, r_multiple: 2 }] })]);
    expect(r.ok).toBe(true);
    expect(r.warnings.join()).toMatch(/will not trail/);
  });

  test('a frozen indicator stop is fine — it is a fixed level', () => {
    const r = catalog.readiness([withRisk({ sl: { type: 'prim', freeze: true },
      targets: [{ fraction: 1, r_multiple: 2 }] })]);
    expect(r.warnings).toEqual([]);
  });

  /* The 09:35 opening-range strategy: half at 2R, half riding the stop. */
  test('a runner is called out, because it relies on the end-of-session close', () => {
    const r = catalog.readiness([withRisk({ sl: { type: 'prim', freeze: true },
      targets: [{ fraction: 0.5, r_multiple: 2 }] })]);
    expect(r.ok).toBe(true);
    expect(r.warnings.join()).toMatch(/50% of the position has no target/);
  });

  test('a target that follows an indicator is called out', () => {
    const r = catalog.readiness([withRisk({ sl: { type: 'pct', freeze: true },
      targets: [{ fraction: 1, tp: { type: 'prim' } }] })]);
    expect(r.warnings.join()).toMatch(/cannot rest at the broker/);
  });

  test('no targets at all is stated, not silently replaced', () => {
    const r = catalog.readiness([withRisk({ sl: { type: 'pct', freeze: true } })]);
    expect(r.warnings.join()).toMatch(/screener uses 2R/);
  });

  /* A long and a short are one setup; a fault in either is a fault in it. */
  test('the side is named when only one half is at fault', () => {
    const r = catalog.readiness([
      { ...withRisk({ sl: { type: 'pct', freeze: true }, targets: [{ fraction: 1, r_multiple: 2 }] }), side: 'long' },
      { ...withRisk({ targets: [{ fraction: 1, r_multiple: 2 }] }), side: 'short' },
    ]);
    expect(r.ok).toBe(false);
    expect(r.blocking.join()).toMatch(/^short: no stop/);
  });

  test('it reaches the setup list', async () => {
    qp.strategies.mockResolvedValue([{ ...T2_LONG, entry: { rules: [{ left: 'a' }] } }]);
    const s = (await catalog.list())[0];
    expect(s.readiness.ok).toBe(false);          // the fixture has no stop
    expect(s.readiness.blocking.join()).toMatch(/no stop/);
  });
});

/*
 * Setup-level risk, which is a different question from account-level risk.
 * The account says what a trade may lose; this says what THIS strategy may,
 * which is a smaller number while a strategy is young.
 */
describe('setup-level risk', () => {
  test('absent means the account decides', async () => {
    qp.strategies.mockResolvedValue([T2_LONG]);
    expect((await catalog.list())[0].riskPerTrade).toBeNull();
  });

  test('set, it is carried on the setup', async () => {
    qp.strategies.mockResolvedValue([T2_LONG]);
    const id = (await catalog.list())[0].id;
    require('../src/setups/prefs').saveSettings(id, { riskPerTrade: 10, maxPositionPct: 30 });
    const s = await catalog.get(id);
    expect(s.riskPerTrade).toBe(10);
    expect(s.maxPositionPct).toBe(30);
  });
});
