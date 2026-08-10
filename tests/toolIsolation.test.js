const os = require('os');
const path = require('path');
const fs = require('fs');

// Each tool is a separate process with its own DB_PATH. Loading two of them in
// one test process means resetting the module registry between them, since db,
// config and the store are all module-level singletons resolved at require time.
function asTool(dbPath, fn) {
  jest.resetModules();
  const prev = process.env.DB_PATH;
  process.env.DB_PATH = dbPath;
  try {
    return fn({
      store: require('../src/sideA/screenerStore'),
      config: require('../src/config'),
    });
  } finally {
    process.env.DB_PATH = prev;
  }
}

const A = path.join(os.tmpdir(), `iso-a-${process.pid}.db`);
const B = path.join(os.tmpdir(), `iso-b-${process.pid}.db`);

afterAll(() => {
  for (const f of [A, B]) { try { fs.unlinkSync(f); } catch {} }
});

const rule = [{ left: 'close', operation: 'egreater', right: 1 }];

describe('a run window set in one tool cannot reach another', () => {
  test('tools do not share a screeners table at all', () => {
    asTool(A, ({ store }) => store.create({ name: 'Only In A', filters: rule }));
    asTool(B, ({ store }) => store.create({ name: 'Only In B', filters: rule }));

    const inA = asTool(A, ({ store }) => store.list().map(s => s.name));
    const inB = asTool(B, ({ store }) => store.list().map(s => s.name));

    expect(inA).toEqual(['Only In A']);
    expect(inB).toEqual(['Only In B']);
  });

  test('windowing a screener in A leaves B running all day', () => {
    // Put A's screener to sleep outside the pre-market session.
    asTool(A, ({ store }) => {
      const s = store.list()[0];
      store.update(s.id, { runFrom: '04:00', runTo: '09:30' });
    });

    const etAt = (h) => Date.UTC(2026, 6, 29, h + 4);   // July: ET = UTC-4

    const aAt11 = asTool(A, ({ store }) =>
      store.list({ enabledOnly: true }).filter(s => store.isActiveAt(s, etAt(11))).length);
    const bAt11 = asTool(B, ({ store }) =>
      store.list({ enabledOnly: true }).filter(s => store.isActiveAt(s, etAt(11))).length);

    expect(aAt11).toBe(0);   // asleep — outside its window
    expect(bAt11).toBe(1);   // unaffected — no window of its own
  });

  test("B's screener never gains a window from A", () => {
    const bWindow = asTool(B, ({ store }) => {
      const s = store.list()[0];
      return { from: s.runFrom, to: s.runTo };
    });
    expect(bWindow).toEqual({ from: null, to: null });
  });

  test('each tool resolves to its own database file', () => {
    expect(asTool(A, ({ config }) => config.dbPath)).toBe(A);
    expect(asTool(B, ({ config }) => config.dbPath)).toBe(B);
  });

  test('a tool with no windowed screeners is never gated by time', () => {
    // Whatever the hour, B runs everything it has — the window check is a
    // per-screener property, not a global switch.
    for (const h of [4, 9, 12, 20]) {
      const on = asTool(B, ({ store }) =>
        store.list({ enabledOnly: true }).filter(s => store.isActiveAt(s, Date.UTC(2026, 6, 29, h + 4))).length);
      expect({ hour: h, running: on }).toEqual({ hour: h, running: 1 });
    }
  });
});
