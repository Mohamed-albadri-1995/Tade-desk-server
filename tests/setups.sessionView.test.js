/*
 * THE BARS A BACKTEST MAY READ ARE THE BARS THE LIVE FEED HAS (2026-09-25).
 *
 * Yahoo is fetched for the regular session only, so live never sees a
 * premarket bar; Polygon backtests under view 'all' read them — OR + VWAP's
 * ATR(14) at 09:34 and Test's SMA 9/13 at the open were measured over bars
 * live did not have. The setup's view follows its live feed.
 */
const feeds = require('../src/setups/feeds');
const parity = require('../src/setups/parity');

describe('feeds.sessionViewFor', () => {
  test('yahoo has no premarket: regular, and says so when that overrides a choice', () => {
    expect(feeds.sessionViewFor('yahoo', 'all')).toMatchObject({ view: 'regular', forced: true });
    expect(feeds.sessionViewFor('yahoo', undefined).view).toBe('regular');
    expect(feeds.sessionViewFor('yahoo', 'all').note).toMatch(/no premarket/);
    expect(feeds.sessionViewFor('yahoo', 'regular')).toMatchObject({ view: 'regular', forced: false });
  });
  test('a feed with premarket keeps the choice', () => {
    expect(feeds.sessionViewFor('alpaca', 'all')).toMatchObject({ view: 'all', forced: false });
    expect(feeds.sessionViewFor('alpaca', undefined).view).toBe('all');
    expect(feeds.sessionViewFor('alpaca', 'regular').view).toBe('regular');
  });
});

describe('Parity reads the effective view', () => {
  const setup = { id: 'S', view: 'regular', feed: 'yahoo', fill: 'live', tf: '1m' };
  const find = (res, what) => res.rows.find(r => r.what === what);
  test('a backtest with premarket bars against a yahoo setup is a difference', () => {
    const res = parity.compare({ setup, strategy: {}, spec: { view: 'all', fill: 'desk' } });
    expect(find(res, 'view')).toMatchObject({ live: 'regular', backtest: 'all', status: 'differ' });
  });
  test('the same bars match', () => {
    const res = parity.compare({ setup, strategy: {}, spec: { view: 'regular', fill: 'desk' } });
    expect(find(res, 'view').status).toBe('match');
  });
});
