process.env.DB_PATH = require('path').join(require('os').tmpdir(), `sg-${process.pid}.db`);

const r0 = require('../src/r0/registry');
const { computeDerivedFields } = require('../src/sideB/calculations');
const { computeRelations } = require('../src/sideB/relations');

afterAll(() => { try { require('fs').unlinkSync(process.env.DB_PATH); } catch {} });

// The morning quote: price below its 9MA.
const morning = {
  price: 9, prevClose: 9, open: 9, change: 0, ema9: 10, ema13: 10.5, ema20: 11,
  ema50: 12, sma5: 10, vwap: 10, dayHigh: 10, dayLow: 8.5, monthHigh: 15,
  monthLow: 8, atr: 1, pmHigh: 9.5, pmLow: 8.8, tvSymbol: 'NASDAQ:AAA',
};

describe('a card keeps tracking the market after its screener stops firing', () => {
  test('the relational signals move with the price, not with the capture', () => {
    // Captured pre-market, below the 9MA.
    const openStock = computeDerivedFields(morning);
    expect(computeRelations(openStock).vsEma9).toBe('below');

    // Later the stock rallies through it. Side G replaces stock and, since the
    // fix, recomputes signals — otherwise the price would say one thing and the
    // tags another for the rest of the day.
    const laterStock = computeDerivedFields({ ...morning, price: 11, change: 22 });
    const laterSignals = computeRelations(laterStock);
    expect(laterSignals.vsEma9).toBe('above');
    expect(laterSignals.distEma9).toBeGreaterThan(0);
  });

  test('Side G applies both to the stored row', () => {
    r0.upsertRows([{ ticker: 'AAA', stock: computeDerivedFields(morning), signals: computeRelations(computeDerivedFields(morning)) }]);
    expect(r0.getRow('AAA').signals.vsEma9).toBe('below');

    // Replay exactly what refreshStaleInR0 does to a row.
    const row = r0.getRow('AAA');
    row.stock = computeDerivedFields({ ...morning, price: 11, change: 22 });
    row.signals = computeRelations(row.stock);

    const after = r0.getRow('AAA');
    expect(after.stock.price).toBe(11);
    expect(after.signals.vsEma9).toBe('above');   // tag followed the price
  });

  test('a refresh preserves everything that is not market data', () => {
    r0.upsertRows([{ ticker: 'BBB', stock: computeDerivedFields(morning) }]);
    const row = r0.getRow('BBB');
    row.catalyst = { label: 'M&A', sentiment: 'bull', tier: 1 };
    row.inShortlist = true;
    row.bias = 'long';

    row.stock = computeDerivedFields({ ...morning, price: 12 });
    row.signals = computeRelations(row.stock);

    const after = r0.getRow('BBB');
    expect(after.catalyst.label).toBe('M&A');   // not clobbered by the refresh
    expect(after.inShortlist).toBe(true);
    expect(after.bias).toBe('long');
    expect(after.stock.price).toBe(12);
  });
});
