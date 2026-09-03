/*
 * A FAILING SCAN MUST NOT STOP THE DECISION.
 *
 * The minute tick did two things in order: freshen the card list, then decide.
 * The first was `await runFullScan()` with nothing around it, so a scan that
 * threw took the whole tick with it and the setups below never ran. The only
 * trace was one line naming the JOB:
 *
 *     [Scheduler] Setup Tick (every minute, 04:00–16:00) failed:
 *       Cannot convert undefined or null to object
 *
 * Backwards in the one way that matters. The scan is a CONVENIENCE — it makes
 * the card list a few minutes fresher. The decision is the point. Trading a
 * list five minutes old is a small cost; not deciding at all is the session.
 *
 * On 2026-09-03 the desk placed no orders and one of the two bars its signals
 * fired on has no run recorded against it at all.
 *
 * The tick is a closure inside `startScheduler`, so it is reached the way the
 * scheduler reaches it: register the jobs against a fake cron, then invoke the
 * handler that was registered for the tick.
 */

const ET = 'America/New_York';

const handlers = {};
jest.mock('node-cron', () => ({
  schedule: jest.fn((expr, fn) => {
    handlers[expr] = fn;
    return { stop: jest.fn() };
  }),
}));
jest.mock('../src/db', () => ({
  prepare: () => ({ run: () => {}, get: () => undefined, all: () => [] }),
}));

const mockFullScan = jest.fn(async () => ({ rowsProcessed: 1 }));
const mockRefreshOnly = jest.fn(async () => ({ refreshed: 0 }));
jest.mock('../src/pipeline', () => ({
  runFullScan: (...a) => mockFullScan(...a),
  runRefreshOnly: (...a) => mockRefreshOnly(...a),
  getScanStatus: () => ({}),
}));

const mockRunDue = jest.fn(async () => []);
jest.mock('../src/setups/runner', () => ({ runDue: (...a) => mockRunDue(...a) }));

const mockForTool = jest.fn(async () => []);
jest.mock('../src/setups/catalog', () => ({
  forTool: (...a) => mockForTool(...a),
  minutesBefore: jest.requireActual('../src/setups/catalog').minutesBefore,
  withinWindow: jest.requireActual('../src/setups/catalog').withinWindow,
}));
jest.mock('../src/r0/registry', () => ({ clearAll: jest.fn(), getAll: () => [] }));

const { startScheduler } = require('../src/scheduler');

/** The registered every-minute setup tick. */
function setupTick() {
  const expr = Object.keys(handlers).find(e => e.startsWith('* 4-16'));
  if (!expr) throw new Error('the setup tick was never registered');
  return handlers[expr];
}

/** "now" in ET, the way the tick reads it. */
function nowET() {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: ET, hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date());
}

function minutesBefore(hhmm, n) {
  return require('../src/setups/catalog').minutesBefore(hhmm, n);
}

beforeAll(() => { startScheduler(); });

beforeEach(() => {
  mockFullScan.mockClear().mockResolvedValue({ rowsProcessed: 1 });
  mockRunDue.mockClear();
  mockForTool.mockReset();
});

/** A setup that both wants a pre-decision scan NOW and decides on this bar. */
function dueNow() {
  const now = nowET();
  return [{
    id: 'Test@bar', name: 'Test', enabled: true,
    universeScanAt: now,
    decisionTime: minutesBefore(now, 1),
    decidesOnBar: minutesBefore(now, 1),
    watch: false,
  }];
}

describe('the pre-decision scan is a convenience, not a gate', () => {
  test('a scan that THROWS still lets the setup decide', async () => {
    mockForTool.mockResolvedValue(dueNow());
    mockFullScan.mockRejectedValue(
      new TypeError('Cannot convert undefined or null to object'));
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(setupTick()()).resolves.toBeUndefined();

    // THE ASSERTION THE BUG WOULD HAVE FAILED. Before the guard, runFullScan
    // throwing meant runDue was never reached.
    expect(mockRunDue).toHaveBeenCalledTimes(1);
    expect(mockRunDue).toHaveBeenCalledWith(minutesBefore(nowET(), 1));
    warn.mockRestore();
  });

  test('...and says the list is the one it already had, rather than going '
    + 'quiet about it', async () => {
    mockForTool.mockResolvedValue(dueNow());
    mockFullScan.mockRejectedValue(new Error('scanner down'));
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

    await setupTick()();

    const said = warn.mock.calls.map(c => c.map(String).join(' ')).join('\n');
    expect(said).toMatch(/pre-decision scan failed/);
    expect(said).toMatch(/card list as it stands/);
    // THE STACK, because "Cannot convert undefined or null to object" names no
    // file and this exact message went unlocated for weeks.
    expect(said).toMatch(/\n\s+at /);
    warn.mockRestore();
  });

  test('a scan that succeeds is still awaited BEFORE the decision — a fresher '
    + 'list is the whole reason it runs first', async () => {
    const order = [];
    mockForTool.mockResolvedValue(dueNow());
    mockFullScan.mockImplementation(async () => { order.push('scan'); return {}; });
    mockRunDue.mockImplementation(async () => { order.push('decide'); return []; });
    await setupTick()();
    expect(order).toEqual(['scan', 'decide']);
  });

  test('no setup wants a scan this minute, so none is run', async () => {
    mockForTool.mockResolvedValue([{
      id: 'X', name: 'X', enabled: true, universeScanAt: '03:03',
      decisionTime: minutesBefore(nowET(), 1),
      decidesOnBar: minutesBefore(nowET(), 1),
    }]);
    await setupTick()();
    expect(mockFullScan).not.toHaveBeenCalled();
    expect(mockRunDue).toHaveBeenCalledTimes(1);
  });

  test('a DISABLED setup does not trigger the scan', async () => {
    mockForTool.mockResolvedValue([{ ...dueNow()[0], enabled: false }]);
    await setupTick()();
    expect(mockFullScan).not.toHaveBeenCalled();
    expect(mockRunDue).not.toHaveBeenCalled();
  });
});

describe('a decision that throws names the setups, not the job', () => {
  /*
   * "Setup Tick failed" names the cron job. When the desk takes nothing all
   * day, the difference between that and "the 09:45 bar was not decided for
   * Test@09:30" is the difference between knowing where to look and not.
   */
  test('runDue throwing is caught, and the message names the bar and the setups',
    async () => {
      mockForTool.mockResolvedValue(dueNow());
      mockRunDue.mockRejectedValue(new Error('catalog vanished'));
      const err = jest.spyOn(console, 'error').mockImplementation(() => {});

      await expect(setupTick()()).resolves.toBeUndefined();

      const said = err.mock.calls.map(c => c.map(String).join(' ')).join('\n');
      expect(said).toMatch(/was not decided for Test@bar/);
      expect(said).toMatch(/catalog vanished/);
      err.mockRestore();
    });

  test('an unreadable catalog still returns quietly rather than crashing the '
    + 'tick', async () => {
    mockForTool.mockRejectedValue(new Error('qp unreachable'));
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(setupTick()()).resolves.toBeUndefined();
    expect(mockRunDue).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});
