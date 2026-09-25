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

/*
 * A STRATEGY THAT READS A PREMARKET LEVEL (2026-09-25): "what if I add one?"
 * On plain yahoo its level is empty and it never fires. The desk moves it to
 * yahoo_ext — Yahoo with its own premarket, one source — and keeps the
 * premarket bars in every frame, live and backtest.
 */
describe('a strategy that reads a premarket level', () => {
  const PM = { kind: 'primitive', key: 'levels.pm_high', source: 'close', params: {} };
  const withPm = { name: 'PML breakout', entry: { logic: 'AND', rules: [
    { left: { kind: 'price', field: 'close' }, op: 'gt', right: PM }] } };
  const without = { name: 'OR', entry: { logic: 'AND', rules: [
    { left: { kind: 'price', field: 'close' }, op: 'gt',
      right: { kind: 'primitive', key: 'vwap.session', params: {} } }] } };

  test('is recognised wherever the level sits in its rules', () => {
    expect(feeds.usesPremarket([withPm])).toBe(true);
    expect(feeds.usesPremarket([without])).toBe(false);
    expect(feeds.usesPremarket([without, { risk: { sl: { type: 'prim',
      anchor: { kind: 'primitive', key: 'levels.pm_low' } } } }])).toBe(true);
    expect(feeds.usesPremarket([{ exit: { rules: [{ right: { key: 'vwap.gap' } }] } }])).toBe(true);
  });

  test('decides on yahoo_ext, and says why', () => {
    const f = feeds.liveFeedFor(null, { needsPremarket: true });
    expect(f.feed).toBe('yahoo_ext');
    expect(f.note).toMatch(/premarket level/);
    expect(feeds.liveFeedFor('yahoo', { needsPremarket: true }).feed).toBe('yahoo_ext');
    // polygon cannot decide live: yahoo instead — and then yahoo_ext.
    expect(feeds.liveFeedFor('polygon', { needsPremarket: true }).feed).toBe('yahoo_ext');
  });

  test('a feed that already has premarket is left alone', () => {
    expect(feeds.liveFeedFor('alpaca', { needsPremarket: true }).feed).toBe('alpaca');
  });

  test('keeps the premarket bars in the frame, whatever the preference', () => {
    expect(feeds.sessionViewFor('yahoo_ext', 'regular', { needsPremarket: true }))
      .toMatchObject({ view: 'all', forced: true });
    expect(feeds.sessionViewFor('yahoo_ext', undefined, { needsPremarket: true }).view).toBe('all');
  });

  test('every other setup is unchanged: yahoo, regular session', () => {
    expect(feeds.liveFeedFor(null).feed).toBe('yahoo');
    expect(feeds.sessionViewFor('yahoo', 'all').view).toBe('regular');
  });

  test('Parity: a Polygon backtest with premarket matches a yahoo_ext setup', () => {
    const setup = { id: 'S', view: 'all', feed: 'yahoo_ext', fill: 'live', tf: '1m' };
    const res = parity.compare({ setup, strategy: {}, spec: { feed: 'polygon', view: 'all', fill: 'desk' } });
    const find = what => res.rows.find(r => r.what === what);
    expect(find('feed').status).toBe('match');
    expect(find('view').status).toBe('match');
  });
});
