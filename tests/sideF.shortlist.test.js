// Mock all external dependencies before requiring the module
let mockRows = [];
let mockDbRow = null;
let mockSavedEntry = null;

jest.mock('../src/db', () => ({
  prepare: (sql) => ({
    get: (val) => {
      if (sql.includes('settings')) {
        if (val === 'shortlistMinScore') return mockDbRow?.minScore ?? null;
        if (val === 'shortlistTopN') return mockDbRow?.topN ?? null;
      }
      if (sql.includes('shortlist WHERE date')) return mockSavedEntry;
      return null;
    },
    run: jest.fn(),
    all: () => [],
  }),
}));

jest.mock('../src/r0/registry', () => ({
  getTodayRows: () => mockRows,
  getRow: (ticker) => mockRows.find(r => r.ticker === ticker) || null,
  setInShortlist: jest.fn(),
}));

jest.mock('../src/utils/time', () => ({
  toETDate: () => '2026-06-29',
}));

const r0 = require('../src/r0/registry');
const { runAutoRule, toggleTicker } = require('../src/sideF/shortlist');

function mkScoredRow(ticker, score, overrides = {}) {
  return {
    ticker,
    _score: score,
    stock: { price: 10, change: 2, sector: 'Tech', ...overrides },
  };
}

beforeEach(() => {
  mockRows = [];
  mockDbRow = null;
  mockSavedEntry = null;
  jest.clearAllMocks();
});

// ─── runAutoRule ──────────────────────────────────────────────────────────────
describe('runAutoRule', () => {

  test('returns null when entry already exists for today', () => {
    mockSavedEntry = { date: '2026-06-29', items: '[]', exported: 0, exported_at: null };
    const result = runAutoRule();
    expect(result).toBeNull();
  });

  test('returns null when no eligible stocks meet minScore', () => {
    mockRows = [mkScoredRow('AAPL', 50), mkScoredRow('MSFT', 60)];
    // default minScore=70, these are below
    const result = runAutoRule();
    expect(result).toBeNull();
  });

  test('uses default minScore=70 and topN=5 when DB returns null', () => {
    mockDbRow = null; // getSetting returns null → fallback to defaults
    mockRows = [
      mkScoredRow('AAPL', 85),
      mkScoredRow('MSFT', 75),
      mkScoredRow('TSLA', 60), // below 70
    ];
    const result = runAutoRule();
    expect(result).not.toBeNull();
    expect(result.items).toHaveLength(2);
    expect(result.items.map(i => i.ticker)).toEqual(expect.arrayContaining(['AAPL', 'MSFT']));
    expect(result.items.find(i => i.ticker === 'TSLA')).toBeUndefined();
  });

  test('uses DB minScore when set', () => {
    mockDbRow = { minScore: { value: '80' } };
    mockRows = [mkScoredRow('AAPL', 85), mkScoredRow('MSFT', 75)];
    // minScore=80, only AAPL qualifies
    const result = runAutoRule();
    expect(result).not.toBeNull();
    expect(result.items).toHaveLength(1);
    expect(result.items[0].ticker).toBe('AAPL');
  });

  test('sorts by score descending and slices to topN', () => {
    mockDbRow = { topN: { value: '2' } };
    mockRows = [
      mkScoredRow('C', 72),
      mkScoredRow('A', 90),
      mkScoredRow('B', 80),
    ];
    const result = runAutoRule();
    expect(result.items).toHaveLength(2);
    expect(result.items[0].ticker).toBe('A'); // highest score first
    expect(result.items[1].ticker).toBe('B');
  });

  test('each item has method=auto and required fields', () => {
    mockRows = [mkScoredRow('AAPL', 85)];
    const result = runAutoRule();
    const item = result.items[0];
    expect(item.method).toBe('auto');
    expect(item).toHaveProperty('ticker');
    expect(item).toHaveProperty('addedAt');
    expect(item).toHaveProperty('score');
    expect(item).toHaveProperty('price');
    expect(item).toHaveProperty('change');
    expect(item).toHaveProperty('sector');
  });

  test('calls r0.setInShortlist for each added ticker', () => {
    mockRows = [mkScoredRow('AAPL', 85), mkScoredRow('MSFT', 75)];
    runAutoRule();
    expect(r0.setInShortlist).toHaveBeenCalledWith('AAPL', true);
    expect(r0.setInShortlist).toHaveBeenCalledWith('MSFT', true);
  });

  test('rows with null _score are excluded', () => {
    mockRows = [mkScoredRow('AAPL', null), mkScoredRow('MSFT', 80)];
    const result = runAutoRule();
    expect(result.items).toHaveLength(1);
    expect(result.items[0].ticker).toBe('MSFT');
  });

  test('stock fields with null fallback to null in item', () => {
    mockRows = [{
      ticker: 'AAPL',
      _score: 80,
      stock: null,
    }];
    const result = runAutoRule();
    const item = result.items[0];
    expect(item.price).toBeNull();
    expect(item.change).toBeNull();
    expect(item.sector).toBeNull();
  });
});

// ─── toggleTicker ─────────────────────────────────────────────────────────────
describe('toggleTicker', () => {

  test('adds ticker when not in shortlist → action = added', () => {
    mockRows = [mkScoredRow('AAPL', 85)];
    const result = toggleTicker('AAPL');
    expect(result.action).toBe('added');
    expect(result.ticker).toBe('AAPL');
    expect(result.entry.items[0].method).toBe('manual');
  });

  test('removes ticker when already in shortlist → action = removed', () => {
    mockSavedEntry = {
      date: '2026-06-29',
      items: JSON.stringify([{ ticker: 'AAPL', method: 'manual', score: 85 }]),
      exported: 0,
      exported_at: null,
    };
    const result = toggleTicker('AAPL');
    expect(result.action).toBe('removed');
    expect(result.entry.items).toHaveLength(0);
  });

  test('calls r0.setInShortlist(ticker, true) on add', () => {
    mockRows = [mkScoredRow('GOOG', 80)];
    toggleTicker('GOOG');
    expect(r0.setInShortlist).toHaveBeenCalledWith('GOOG', true);
  });

  test('calls r0.setInShortlist(ticker, false) on remove', () => {
    mockSavedEntry = {
      date: '2026-06-29',
      items: JSON.stringify([{ ticker: 'GOOG', method: 'auto', score: 80 }]),
      exported: 0,
      exported_at: null,
    };
    toggleTicker('GOOG');
    expect(r0.setInShortlist).toHaveBeenCalledWith('GOOG', false);
  });

  test('manual add captures score and stock from r0.getRow', () => {
    mockRows = [mkScoredRow('TSLA', 77, { price: 250, change: 3.5, sector: 'Auto' })];
    const result = toggleTicker('TSLA');
    const item = result.entry.items[0];
    expect(item.score).toBe(77);
    expect(item.price).toBe(250);
    expect(item.sector).toBe('Auto');
  });

  test('manual add when ticker not in r0 → score/price/sector = null', () => {
    mockRows = []; // r0.getRow returns null
    const result = toggleTicker('UNKNOWN');
    const item = result.entry.items[0];
    expect(item.score).toBeNull();
    expect(item.price).toBeNull();
  });
});
