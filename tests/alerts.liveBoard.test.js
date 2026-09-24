/*
 * THE LIVE BOARD: TODAY'S TRADES, BY ACCOUNT, FROM FOUR RECORDS.
 *
 * The ledger is the plan (setup, SL, TP, what was not sent and why), the
 * broker's fills are what happened, the positions are what is held now, and
 * the manager says where the stop is and when it last looked. Each field
 * comes from the one record that knows it; nothing is guessed.
 */
const { board } = require('../src/alerts/liveBoard');

const DAY = '2026-09-24';
const at = hm => Date.parse(`${DAY}T${hm}:00-04:00`);

const deps = (over = {}) => ({
  broker: {
    destinations: () => [{ id: 'a', name: 'OR+VWAP 935', mode: 'auto' },
                         { id: 'b', name: 'Alpaca100ktest', mode: 'auto' }],
    orders: () => [
      { at: at('09:35'), date: DAY, symbol: 'NVTS', signal: 'buy', quantity: 420, price: 11.8,
        stop: 11.6, target: 12.28, setupId: 'OR@09:35', destination: 'a', sent: true },
      { at: at('09:35'), date: DAY, symbol: 'SOUN', signal: 'sell', quantity: 300, price: 5.1,
        stop: 5.25, target: 4.8, setupId: 'OR@09:35', destination: 'a', sent: true },
      { at: at('09:35'), date: DAY, symbol: 'RGTI', signal: 'sell', price: 14.2, stop: 14.6,
        setupId: 'OR@09:35', destination: 'a', sent: false, skipped: 'no shares to borrow' },
      { at: at('10:12'), date: DAY, kind: 'flatten', symbol: 'SOUN', destination: 'a',
        source: "the backtest's stop was hit", sent: true },
    ],
  },
  sessionLog: { passesOn: () => [{ at: at('10:20'), positions: [
    { symbol: 'NVTS', stop: 11.62, stopMoved: true, legsBanked: 1 }] }] },
  alpacaTrades: async () => ({ problems: [], trades: [
    { account: 'a', ticker: 'NVTS', direction: 'Long', shares: 420, entryPrice: 11.84,
      entryTime: '09:35:04', exitPrice: null, status: 'open' },
    { account: 'a', ticker: 'SOUN', direction: 'Short', shares: 300, entryPrice: 5.10,
      entryTime: '09:35:05', exitPrice: 5.24, exitTime: '10:12:40', status: 'closed' },
    { account: 'b', ticker: 'AAPL', direction: 'Long', shares: 10, entryPrice: 200,
      entryTime: '11:00:00', exitPrice: 201, exitTime: '11:30:00', status: 'closed' },
  ] }),
  held: async () => ({ ok: true, positions: [
    { account: 'a', symbol: 'NVTS', qty: 420, side: 'long', avgEntry: 11.84, current: 12.21, unrealised: 155.4 }] }),
  setups: async () => [{ id: 'OR@09:35', name: 'OR + VWAP 09:35', strategyIds: [1, 2] }],
  ...over,
});

test('one block per account, named, with its mode', async () => {
  const r = await board({ date: DAY }, deps());
  expect(r.accounts.map(a => [a.name, a.mode])).toEqual([['Alpaca100ktest', 'auto'], ['OR+VWAP 935', 'auto']]);
});

test('an open trade: the plan, the real fill, the live price, the manager', async () => {
  const a = (await board({ date: DAY }, deps())).accounts.find(x => x.id === 'a');
  const t = a.trades.find(x => x.symbol === 'NVTS');
  expect(t).toMatchObject({ status: 'open', side: 'long', setup: 'OR + VWAP 09:35', shares: 420,
    entry: 11.84, sl: 11.6, tp: 12.28, now: 12.21, pnl: 155.4,
    stopNow: 11.62, stopMoved: true, legsBanked: 1, checkedAt: at('10:20') });
});

test('a closed short: exit from the fills, P&L worked out, the close reason from the ledger', async () => {
  const t = (await board({ date: DAY }, deps())).accounts.find(x => x.id === 'a')
    .trades.find(x => x.symbol === 'SOUN');
  // (5.24 − 5.10) × 300, short → −42
  expect(t).toMatchObject({ status: 'closed', side: 'short', exit: 5.24, pnl: -42,
    closeReason: "the backtest's stop was hit" });
});

test('an order that was never sent is on the board, with its reason', async () => {
  const t = (await board({ date: DAY }, deps())).accounts.find(x => x.id === 'a')
    .trades.find(x => x.symbol === 'RGTI');
  expect(t).toMatchObject({ status: 'not sent', notSent: 'no shares to borrow' });
});

test('open first, then closed, then what never went out; totals per account', async () => {
  const a = (await board({ date: DAY }, deps())).accounts.find(x => x.id === 'a');
  expect(a.trades.map(t => t.status)).toEqual(['open', 'closed', 'not sent']);
  expect([a.open, a.closed, a.openPnl, a.closedPnl]).toEqual([1, 1, 155.4, -42]);
});

test('a trade the desk did not place is shown, and says so', async () => {
  const t = (await board({ date: DAY }, deps())).accounts.find(x => x.id === 'b').trades[0];
  expect(t).toMatchObject({ symbol: 'AAPL', status: 'closed', pnl: 10, setup: 'not placed by the desk' });
});

test('the broker unreachable: the plan is still there, the gap is a note', async () => {
  const r = await board({ date: DAY }, deps({
    alpacaTrades: async () => ({ problems: ['a: 401 unauthorized'], trades: [] }),
    held: async () => ({ ok: false, reason: 'no readable Alpaca account', positions: null }),
  }));
  const a = r.accounts.find(x => x.id === 'a');
  expect(a.trades.find(t => t.symbol === 'NVTS').status).toBe('unknown');
  expect(r.notes.join(' ')).toMatch(/401 unauthorized[\s\S]*no readable Alpaca account/);
});
