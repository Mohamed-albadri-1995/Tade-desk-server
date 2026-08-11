// Unit tests for shortlist registry logic
// We mock the DB and r0 to test logic in isolation

jest.mock('../src/db', () => {
  const data = {};
  const store = { shortlist: {} };
  return {
    prepare: (sql) => ({
      get: (...args) => {
        if (sql.includes('SELECT * FROM shortlist WHERE date')) {
          return store.shortlist[args[0]] || null;
          // items is a JSON string, exported_at is the raw value — matches real DB columns
        }
        if (sql.includes("SELECT value FROM settings WHERE key")) {
          const defaults = {
            hotImmediateThreshold: '60',
            hotSustainedThreshold: '40',
            hotSustainedSessions: '3',
            hotFloorThreshold: '20',
            coolOffDays: '2',
            sectorBullishThreshold: '20',
            sectorBearishThreshold: '-20',
          };
          return { value: defaults[args[0]] || null };
        }
        return null;
      },
      all: (...args) => {
        if (sql.includes('SELECT * FROM shortlist ORDER BY date DESC')) {
          return Object.values(store.shortlist).map(r => ({
            date: r.date,
            items: JSON.stringify(r.items),
            exported: r.exported ? 1 : 0,
            exported_at: r.exportedAt,
          }));
        }
        return [];
      },
      run: (...args) => {
        if (sql.includes('INSERT OR REPLACE INTO shortlist')) {
          const [date, items, exported, exportedAt] = args;
          store.shortlist[date] = {
            date,
            items,          // keep as JSON string to match real DB
            exported,
            exported_at: exportedAt,
          };
        }
      },
    }),
    pragma: () => {},
    exec: () => {},
    transaction: (fn) => fn,
    _store: store,
  };
});

jest.mock('../src/r0/registry', () => {
  const rows = {};
  return {
    getTodayRows: () => Object.values(rows),
    getRow: (ticker) => rows[ticker] || null,
    setInShortlist: (ticker, val) => { if (rows[ticker]) rows[ticker].inShortlist = val; },
    upsertRows: (newRows) => { for (const r of newRows) rows[r.ticker] = r; },
    _rows: rows,
  };
});

jest.mock('../src/utils/time', () => ({
  toETDate: () => '2026-06-28',
  toETTime: () => '09:35',
  toETHour: () => 9,
}));

const r0 = require('../src/r0/registry');
const { runAutoRule, toggleTicker } = require('../src/sideF/shortlist');

function seedR0(scores) {
  for (const [ticker, score] of Object.entries(scores)) {
    r0._rows[ticker] = {
      ticker,
      _score: score,
      stock: { price: 100, change: 5, sector: 'Tech' },
      inShortlist: false,
      date: '2026-06-28',
    };
  }
}

beforeEach(() => {
  // Clear state
  const db = require('../src/db');
  db._store.shortlist = {};
  Object.keys(r0._rows).forEach(k => delete r0._rows[k]);
});

describe('Auto Rule Logic', () => {
  test('creates shortlist with top 5 stocks by score', () => {
    seedR0({ A: 90, B: 85, C: 80, D: 75, E: 72, F: 70, G: 65, H: 50 });
    const entry = runAutoRule();
    expect(entry).not.toBeNull();
    expect(entry.items.length).toBe(5);
    const tickers = entry.items.map(i => i.ticker);
    expect(tickers).toContain('A');
    expect(tickers).toContain('B');
    expect(tickers).not.toContain('G'); // score < 70
    expect(tickers).not.toContain('H');
  });

  test('skips stocks with _score < 70', () => {
    seedR0({ A: 69, B: 50 });
    const entry = runAutoRule();
    expect(entry).toBeNull();
  });

  test('all items have method=auto', () => {
    seedR0({ A: 90, B: 80, C: 75 });
    const entry = runAutoRule();
    for (const item of entry.items) {
      expect(item.method).toBe('auto');
    }
  });

  test('sets inShortlist=true for selected tickers', () => {
    seedR0({ A: 90, B: 80 });
    runAutoRule();
    expect(r0._rows['A'].inShortlist).toBe(true);
    expect(r0._rows['B'].inShortlist).toBe(true);
  });

  test('does not run if entry already exists for today', () => {
    seedR0({ A: 90 });
    runAutoRule(); // first run
    const secondResult = runAutoRule(); // should skip
    expect(secondResult).toBeNull();
  });

  test('captures score, price, change, sector from r0', () => {
    seedR0({ A: 90 });
    r0._rows['A'].stock = { price: 150.5, change: 7.2, sector: 'Healthcare' };
    const entry = runAutoRule();
    const item = entry.items[0];
    expect(item.score).toBe(90);
    expect(item.price).toBe(150.5);
    expect(item.change).toBe(7.2);
    expect(item.sector).toBe('Healthcare');
  });
});

describe('Manual Override Logic', () => {
  beforeEach(() => {
    r0._rows['AAPL'] = { ticker: 'AAPL', _score: 75, stock: { price: 200, change: 2.1, sector: 'Tech' }, inShortlist: false };
    r0._rows['MSFT'] = { ticker: 'MSFT', _score: 60, stock: { price: 300, change: 1.5, sector: 'Tech' }, inShortlist: false };
  });

  test('adds ticker to empty shortlist', () => {
    const result = toggleTicker('AAPL');
    expect(result.action).toBe('added');
    expect(r0._rows['AAPL'].inShortlist).toBe(true);
  });

  test('removes ticker from shortlist when toggled again', () => {
    toggleTicker('AAPL');
    const result = toggleTicker('AAPL');
    expect(result.action).toBe('removed');
    expect(r0._rows['AAPL'].inShortlist).toBe(false);
  });

  test('manual items have method=manual', () => {
    const result = toggleTicker('MSFT');
    const item = result.entry.items.find(i => i.ticker === 'MSFT');
    expect(item.method).toBe('manual');
  });

  test('captures r0 data at time of manual add', () => {
    const result = toggleTicker('AAPL');
    const item = result.entry.items.find(i => i.ticker === 'AAPL');
    expect(item.score).toBe(75);
    expect(item.price).toBe(200);
    expect(item.change).toBe(2.1);
    expect(item.sector).toBe('Tech');
  });
});
