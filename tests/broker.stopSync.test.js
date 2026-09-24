/*
 * The stop resting at Alpaca follows the strategy's stop — tighten only.
 *
 * EXEL, 2026-09-24: Test's stop trailed 56.85 → 56.89 while Alpaca still held
 * 56.85, and the box saw the moved stop hit four minutes after the backtest
 * booked it. Moving the bracket's stop leg makes Alpaca take it on the print.
 */
const { syncStop, stopLegs, summary } = require('../src/broker/stopSync');
const { stopTick } = require('../src/broker/signalstack');

const CREDS = { keyId: 'PKTESTAAAAAAAAAAAAAA', secret: 's', paper: true };

function deps({ orders = [], patch = () => ({ ok: true }), alpacaIds = ['alp'],
                creds = { creds: CREDS, error: null }, read = null } = {}) {
  const calls = { get: [], patch: [] };
  return {
    calls,
    deps: {
      broker: { stopTick },
      reconcile: { alpacaDestinations: () => alpacaIds, credsForDest: () => creds },
      alpaca: {
        get: async (p, o) => { calls.get.push({ p, o }); return read || { ok: true, data: orders }; },
        request: async (m, p, o) => { calls.patch.push({ m, p, o }); return patch(p, o); },
      },
    },
  };
}
// A filled bracket as Alpaca lists it with nested=true.
const bracket = (side, stop, extra = {}) => ({
  id: 'parent', symbol: 'EXEL', side: side === 'long' ? 'buy' : 'sell', type: 'market',
  status: 'filled', order_class: 'bracket', stop_price: null,
  legs: [
    { id: 'tp', symbol: 'EXEL', side: side === 'long' ? 'sell' : 'buy', type: 'limit',
      status: 'new', stop_price: null },
    { id: 'sl', symbol: 'EXEL', side: side === 'long' ? 'sell' : 'buy', type: 'stop',
      status: 'held', stop_price: String(stop), ...extra },
  ],
});
const LONG = { symbol: 'EXEL', side: 'long', destinations: ['alp'] };
const SHORT = { symbol: 'EXEL', side: 'short', destinations: ['alp'] };

describe('moving the stop leg at Alpaca', () => {
  test('a long whose stop trailed up: the leg is moved to it', async () => {
    const { deps: d, calls } = deps({ orders: [bracket('long', 56.85)] });
    const rows = await syncStop(LONG, 56.89, d);
    expect(calls.patch).toHaveLength(1);
    expect(calls.patch[0].m).toBe('PATCH');
    expect(calls.patch[0].p).toBe('/v2/orders/sl');
    expect(calls.patch[0].o.body).toEqual({ stop_price: '56.89' });
    expect(calls.patch[0].o.account).toBe(CREDS);           // that account's own keys
    expect(rows[0].moved).toEqual([{ id: 'sl', from: 56.85, to: 56.89 }]);
    expect(summary(rows)).toBe('broker stop moved 56.85 → 56.89');
  });

  test('TIGHTEN ONLY: a lower stop on a long is never sent', async () => {
    const { deps: d, calls } = deps({ orders: [bracket('long', 56.89)] });
    const rows = await syncStop(LONG, 56.85, d);
    expect(calls.patch).toHaveLength(0);
    expect(rows[0].kept).toBe(1);
    expect(summary(rows)).toBeNull();                         // nothing to say
  });

  test('the same stop is not re-sent every minute', async () => {
    const { deps: d, calls } = deps({ orders: [bracket('long', 56.89)] });
    await syncStop(LONG, 56.89, d);
    expect(calls.patch).toHaveLength(0);
  });

  test('a short: the BUY stop moves DOWN, never up', async () => {
    const down = deps({ orders: [bracket('short', 31.11)] });
    await syncStop(SHORT, 30.9, down.deps);
    expect(down.calls.patch[0].o.body).toEqual({ stop_price: '30.9' });
    const up = deps({ orders: [bracket('short', 31.11)] });
    await syncStop(SHORT, 31.3, up.deps);
    expect(up.calls.patch).toHaveLength(0);
  });

  test('rounded the way the entry\'s stop was sent (signalstack.stopTick)', async () => {
    const { deps: d, calls } = deps({ orders: [bracket('long', 56.85)] });
    await syncStop(LONG, 56.8812, d);
    expect(calls.patch[0].o.body).toEqual({ stop_price: String(stopTick(56.8812, 'buy')) });
  });

  test('a scale-out is several brackets: every open stop leg moves', async () => {
    const two = [bracket('long', 56.85), { ...bracket('long', 56.85), id: 'p2',
      legs: bracket('long', 56.85).legs.map(l => ({ ...l, id: `${l.id}2` })) }];
    const { deps: d, calls } = deps({ orders: two });
    const rows = await syncStop(LONG, 56.9, d);
    expect(calls.patch.map(c => c.p).sort()).toEqual(['/v2/orders/sl', '/v2/orders/sl2']);
    expect(summary(rows)).toBe('broker stop moved 56.85 → 56.9 (2 orders)');
  });

  test('a filled, cancelled or replaced stop is left alone', async () => {
    for (const status of ['filled', 'canceled', 'replaced']) {
      const { deps: d, calls } = deps({ orders: [bracket('long', 56.85, { status })] });
      const rows = await syncStop(LONG, 56.9, d);
      expect(calls.patch).toHaveLength(0);
      expect(rows[0].skipped).toMatch(/no open stop/);
    }
  });

  test('the target leg is never touched', () => {
    const legs = stopLegs([{ ...bracket('long', 56.85), legs: bracket('long', 56.85).legs }]
      .map(o => ({ ...o, symbol: 'EXEL', stopPrice: NaN,
        legs: o.legs.map(l => ({ ...l, stopPrice: l.stop_price == null ? NaN : Number(l.stop_price) })) })),
    'EXEL', 'long');
    expect(legs.map(l => l.id)).toEqual(['sl']);
  });

  test('Alpaca refusing the move is reported — and nothing else changes', async () => {
    const { deps: d } = deps({ orders: [bracket('long', 56.85)],
      patch: () => ({ ok: false, error: 'Alpaca /v2/orders/sl 422: stop price must be below market' }) });
    const rows = await syncStop(LONG, 57.5, d);
    expect(rows[0].moved).toEqual([]);
    expect(summary(rows)).toMatch(/could not move the broker stop — alp: .*422/);
  });

  test('Trade The Pool cannot be moved from here, and says so', async () => {
    const { deps: d, calls } = deps({ alpacaIds: ['alp'] });
    const rows = await syncStop({ ...LONG, destinations: ['ttp'] }, 56.9, d);
    expect(calls.get).toHaveLength(0);
    expect(rows[0].skipped).toMatch(/not an Alpaca account/);
  });

  test('an account whose keys cannot be told apart is an error, not a guess', async () => {
    const { deps: d, calls } = deps({ creds: { creds: null, error: 'has no Alpaca key pair of its own' } });
    const rows = await syncStop(LONG, 56.9, d);
    expect(calls.get).toHaveLength(0);
    expect(rows[0].error).toMatch(/key pair/);
  });

  test('Alpaca not answering the order list: reported, nothing sent', async () => {
    const { deps: d, calls } = deps({ read: { ok: false, error: 'timed out' } });
    const rows = await syncStop(LONG, 56.9, d);
    expect(calls.patch).toHaveLength(0);
    expect(rows[0].error).toBe('timed out');
  });

  test('asks for this symbol\'s OPEN orders, nested', async () => {
    const { deps: d, calls } = deps({ orders: [] });
    await syncStop(LONG, 56.9, d);
    expect(calls.get[0].p).toMatch(/status=open/);
    expect(calls.get[0].p).toMatch(/symbols=EXEL/);
    expect(calls.get[0].p).toMatch(/nested=true/);
  });
});
