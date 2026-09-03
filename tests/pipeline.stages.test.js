/*
 * EVERY STAGE OF THE SCAN ACTUALLY RUNS.
 *
 * Three of them did not, for as long as anyone can tell. The wrappers used to
 * return a function that ran the stage, so every call site had to end `})()`:
 *
 *     await stageWrapSoft(report, 'shortInterest', async () => {…});   // never ran
 *     await stageWrapSoft(report, 'canslimRow',    async () => {…});   // never ran
 *     await stageWrapSoft(report, 'industryMap',   async () => {…});   // never ran
 *     await stageWrapSoft(report, 'canslim',       async () => {…})(); // ran
 *
 * `await` on a function object resolves to the function. No error, no warning,
 * no entry in `report.stages`. Short interest was always empty, the CANSLIM
 * reading never reached the row the registers are built from, and the industry
 * labels qp needs to rank groups were never recorded — and every one of those
 * looks exactly like a data source that has nothing to give.
 *
 * That is the whole family this file guards: a stage that is not run is
 * indistinguishable, from the outside, from a stage that ran and found
 * nothing. So the test is not "does the code look right" — it runs the scan
 * with every dependency stubbed and asks which stages left a mark.
 */

const STAGES = ['sideA', 'sideB', 'shortInterest', 'canslimRow', 'industryMap',
                'canslim', 'alerts', 'sideD', 'sideE', 'sideG', 'sideC',
                'sideF'];

const ran = [];
const mark = (k, v) => { ran.push(k); return v; };

jest.mock('../src/db', () => ({
  prepare: () => ({ run: () => {}, get: () => undefined, all: () => [] }),
}));
jest.mock('../src/sideA/tvScanner', () => ({
  runAllScanners: jest.fn(async () => ({ candidates: {}, labels: {} })),
}));
jest.mock('../src/sideA/merge', () => ({
  mergeScannersIntoR0: jest.fn(() => [{ ticker: 'AAA' }]),
}));
jest.mock('../src/sideB/calculations', () => ({
  applyDerivedFields: jest.fn(rows => rows),
}));
jest.mock('../src/sideC/news', () => ({
  fetchNewsForTicker: jest.fn(async () => ({ news: [], catalyst: null })),
}));
jest.mock('../src/sideC/technical', () => ({ combineCatalyst: jest.fn(() => null) }));
jest.mock('../src/sideD/engine', () => ({
  buildMarketSnapshot: jest.fn(async () => ({})),
  enrichR0WithContext: jest.fn(rows => rows),
}));
jest.mock('../src/r0/registry', () => ({
  getAll: jest.fn(() => []),
  getRow: jest.fn(() => null),
  clearAll: jest.fn(),
  markAllStale: jest.fn(),
  upsertRows: jest.fn(),
  updateNews: jest.fn(),
  serialize: jest.fn(() => ({})),
}));
jest.mock('../src/sideF/shortlist', () => ({ syncShortlistToR0: jest.fn() }));
jest.mock('../src/sideG/staleFetch', () => ({
  refreshStaleInR0: jest.fn(async () => ({ refreshed: 0 })),
  refreshAllInR0: jest.fn(async () => ({ refreshed: 0 })),
}));
jest.mock('../src/sideE/score', () => ({
  scoreAllRows: jest.fn(async rows => rows.map(r => ({ ...r, _score: 1 }))),
  checkScorer: jest.fn(async () => true),
}));

// The lazily-required ones. Each records that its stage reached it.
jest.mock('../src/sideA/toolIdentity', () => ({
  isPaused: () => false, pauseState: () => null,
}));
jest.mock('../src/sideC/shortInterest', () => ({
  fill: jest.fn(() => mark('shortInterest', { filled: 0 })),
}), { virtual: true });
jest.mock('../src/sideA/canslimRow', () => ({
  attach: jest.fn(() => mark('canslimRow', { attached: 0 })),
}), { virtual: true });
jest.mock('../src/sideA/industryMap', () => ({
  record: jest.fn(() => mark('industryMap', 0)),
}), { virtual: true });
jest.mock('../src/sideA/canslim', () => ({
  tagRows: jest.fn(() => mark('canslim', { tagged: 0, memberCount: 0 })),
  currentMembers: jest.fn(() => new Set()),
  recordMembers: jest.fn(() => ({ total: 0, expired: 0 })),
}), { virtual: true });
jest.mock('../src/sideA/screenerStore', () => ({ list: jest.fn(() => []) }),
  { virtual: true });
jest.mock('../src/sideA/preR0', () => ({
  apply: jest.fn(async (c) => ({ candidates: c, report: null })),
}), { virtual: true });
jest.mock('../src/alerts/engine', () => ({ evaluate: jest.fn(() => []) }),
  { virtual: true });
jest.mock('../src/alerts/store', () => ({
  listRules: jest.fn(() => []), publishFires: jest.fn(),
}), { virtual: true });
jest.mock('../src/sideF/globalShortlist', () => ({
  tagRows: jest.fn(() => ({ tagged: 0, memberCount: 0 })),
}), { virtual: true });

const { runFullScan, getScanStatus } = require('../src/pipeline');

beforeEach(() => { ran.length = 0; });

describe('the wrappers run the stage', () => {
  /*
   * THE PROPERTY THAT MAKES THE WHOLE CLASS IMPOSSIBLE. A wrapper that returns
   * a function can be awaited and do nothing; one that returns a promise
   * cannot. A `()` left at a call site now throws "is not a function" on the
   * next scan, which is loud.
   */
  test('stageWrap returns a promise, not a function to be called later', () => {
    const pipe = require('../src/pipeline');
    // Not exported — read through the scan itself, below. What IS checkable
    // here is that no call site is left currying.
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '..', 'src', 'pipeline.js'), 'utf8');
    expect(src).not.toMatch(/stageWrap(Soft)?\([\s\S]*?\n {4}\}\)\(\);/);
    expect(pipe.runFullScan).toBeInstanceOf(Function);
  });
});

describe('a full scan touches every stage', () => {
  test('all twelve leave a mark in the report — none is silently skipped',
    async () => {
      await runFullScan();
      const stages = getScanStatus().lastReport.stages;
      for (const key of STAGES) {
        // A MISSING KEY IS THE BUG. An entry with ok:false means the stage ran
        // and failed, which is a different and visible thing.
        expect(Object.keys(stages)).toContain(key);
      }
    });

  test('the three that never ran are among them, and reach their module',
    async () => {
      await runFullScan();
      expect(ran).toEqual(expect.arrayContaining(
        ['shortInterest', 'canslimRow', 'industryMap']));
    });

  test('...and the scan still reports ok', async () => {
    await runFullScan();
    expect(getScanStatus().lastReport.ok).toBe(true);
  });

  /*
   * A SOFT STAGE THAT THROWS IS RECORDED AND THE SCAN CONTINUES — which is
   * what "non-fatal" has to mean, and the reason turning three of them on is
   * safe: a stage that has never run on live data cannot take the scan down.
   */
  test('a soft stage that throws is marked failed and does not stop the scan',
    async () => {
      require('../src/sideA/industryMap').record.mockImplementationOnce(() => {
        throw new TypeError('Cannot convert undefined or null to object');
      });
      await runFullScan();
      const stages = getScanStatus().lastReport.stages;
      expect(stages.industryMap.ok).toBe(false);
      expect(stages.industryMap.error).toMatch(/Cannot convert undefined/);
      expect(getScanStatus().lastReport.ok).toBe(true);
      // and the stages after it still ran
      expect(Object.keys(stages)).toContain('sideF');
    });

  /*
   * THE STACK, NOT JUST THE MESSAGE. "Cannot convert undefined or null to
   * object" names no file and no line. That exact message was logged by every
   * discovery window on one tool, repeatedly, and could not be located.
   */
  test('a failed stage logs where it failed, not only what it said',
    async () => {
      const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
      require('../src/sideA/industryMap').record.mockImplementationOnce(() => {
        throw new TypeError('Cannot convert undefined or null to object');
      });
      await runFullScan();
      const logged = spy.mock.calls.map(c => String(c[1] || '')).join('\n');
      expect(logged).toMatch(/TypeError: Cannot convert undefined/);
      expect(logged).toMatch(/\bat\b.*pipeline\.stages\.test|\bat\b/);
      spy.mockRestore();
    });

  /*
   * THE FATAL PATH NEEDS THE STACK MOST, and it was the last one without it.
   * A soft stage that fails costs a field; a throw out of sideA or sideB ends
   * the scan before r0 is touched, so no new card reaches the list for the
   * rest of the window — which is how a desk ends a session with the same
   * seven names it opened with.
   */
  test('a FATAL stage failure logs the stack and names the stage', async () => {
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    require('../src/sideB/calculations').applyDerivedFields
      .mockImplementationOnce(() => {
        throw new TypeError('Cannot convert undefined or null to object');
      });
    await expect(runFullScan()).rejects.toThrow(/Cannot convert undefined/);
    const lines = spy.mock.calls.map(c => c.map(String).join(' ')).join('\n');
    expect(lines).toMatch(/Scan error in sideB/);
    expect(lines).toMatch(/TypeError: Cannot convert undefined/);
    expect(lines).toMatch(/\n\s+at /);              // an actual stack
    spy.mockRestore();
  });

  test('...and a fatal failure leaves r0 untouched, so the cards already on '
    + 'screen survive it', async () => {
    const r0 = require('../src/r0/registry');
    r0.upsertRows.mockClear();
    r0.markAllStale.mockClear();
    require('../src/sideB/calculations').applyDerivedFields
      .mockImplementationOnce(() => { throw new Error('boom'); });
    await expect(runFullScan()).rejects.toThrow(/boom/);
    expect(r0.markAllStale).not.toHaveBeenCalled();
    expect(r0.upsertRows).not.toHaveBeenCalled();
  });

  test('the scan releases its running flag even when it throws — one crash '
    + 'must not block every scan after it', async () => {
    require('../src/sideB/calculations').applyDerivedFields
      .mockImplementationOnce(() => { throw new Error('boom'); });
    await expect(runFullScan()).rejects.toThrow(/boom/);
    expect(getScanStatus().running).toBe(false);
    // and the next scan really does run
    await runFullScan();
    expect(getScanStatus().lastReport.ok).toBe(true);
  });
});
