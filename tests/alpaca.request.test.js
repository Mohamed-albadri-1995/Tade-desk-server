/*
 * alpaca/account.request — the one call that CHANGES something at Alpaca
 * directly (a bracket's stop leg; see src/broker/stopSync.js). It must go to
 * the named account with that account's own keys, as JSON, by PATCH.
 */
const alpaca = require('../src/alpaca/account');

const ACCT = { keyId: 'PKTESTAAAAAAAAAAAAAA', secret: 'secretAAAAAAAAAAAAAAAA', paper: true };

afterEach(() => { delete global.fetch; });

test('PATCH carries the body as JSON, to the paper API, with that account\'s keys', async () => {
  const seen = [];
  global.fetch = jest.fn(async (url, init) => {
    seen.push({ url, init });
    return { ok: true, status: 200, text: async () => JSON.stringify({ id: 'new', stop_price: '56.89' }) };
  });
  const r = await alpaca.request('PATCH', '/v2/orders/sl', { account: ACCT, body: { stop_price: '56.89' } });
  expect(r).toEqual({ ok: true, data: { id: 'new', stop_price: '56.89' } });
  expect(seen[0].url).toBe('https://paper-api.alpaca.markets/v2/orders/sl');
  expect(seen[0].init.method).toBe('PATCH');
  expect(JSON.parse(seen[0].init.body)).toEqual({ stop_price: '56.89' });
  expect(seen[0].init.headers['Content-Type']).toBe('application/json');
  expect(seen[0].init.headers['APCA-API-KEY-ID']).toBe(ACCT.keyId);
});

test('a refusal comes back as an error with Alpaca\'s words, not a throw', async () => {
  global.fetch = jest.fn(async () => ({ ok: false, status: 422,
    text: async () => '{"message":"stop price must be below market"}' }));
  const r = await alpaca.request('PATCH', '/v2/orders/sl', { account: ACCT, body: { stop_price: '99' } });
  expect(r.ok).toBe(false);
  expect(r.error).toMatch(/422.*stop price must be below market/);
});

test('GET is unchanged: no body, no content type', async () => {
  const seen = [];
  global.fetch = jest.fn(async (url, init) => { seen.push(init); return { ok: true, status: 200, text: async () => '[]' }; });
  await alpaca.get('/v2/orders', { account: ACCT });
  expect(seen[0].method).toBe('GET');
  expect(seen[0].body).toBeUndefined();
});
