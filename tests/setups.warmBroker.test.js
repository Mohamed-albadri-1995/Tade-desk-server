/*
 * THE BROKER'S QUESTIONS GO OUT TOGETHER, BEFORE THE FIRST ORDER.
 *
 * 2026-09-24, OR + VWAP 09:35: IMCC sent 09:35:09, CLDX 09:35:14, MAZE
 * 09:35:20 — refused, because by then MAZE had risen through its stop. Each
 * order spent 5–6 s asking Alpaca its buying power and, for a short, whether
 * the name can be borrowed. The orders stay one at a time (sizing depends on
 * it); the questions do not have to.
 */
const broker = require('../src/broker/signalstack');
const client = require('../src/alpaca/client');
const account = require('../src/alpaca/account');
const { warmBroker } = require('../src/setups/runner');

const ALPACA = { destinationId: 'alpaca1', dialect: 'alpaca' };
const TTP = { destinationId: 'ttp', dialect: 'ttp' };
const PICKS = [{ ticker: 'IMCC', signal: 'long' }, { ticker: 'CLDX', signal: 'short' },
               { ticker: 'MAZE', signal: 'short' }];

afterEach(() => jest.restoreAllMocks());

function track() {
  const log = [];
  let inFlight = 0, most = 0;
  const slow = (what) => async () => {
    inFlight += 1; most = Math.max(most, inFlight); log.push(`start ${what}`);
    await new Promise(r => setTimeout(r, 30));
    inFlight -= 1; log.push(`end ${what}`);
    return { ok: true };
  };
  jest.spyOn(account, 'credsOf').mockReturnValue({ keyId: 'k' });
  jest.spyOn(broker, 'liveBuyingPower').mockImplementation((c) => slow(`power ${c.destinationId}`)());
  jest.spyOn(client, 'checkShortable').mockImplementation((sym) => slow(`borrow ${sym}`)());
  return { log, most: () => most };
}

test('all at once: the account\'s power and every short\'s borrow, in flight together', async () => {
  const t = track();
  await warmBroker(PICKS, [ALPACA]);
  expect(t.most()).toBe(3);                          // power + CLDX + MAZE
  expect(t.log.slice(0, 3).every(x => x.startsWith('start'))).toBe(true);
});

test('only what an order will ask: no borrow check for a long, nothing for a non-Alpaca account', async () => {
  track();
  await warmBroker(PICKS, [ALPACA, TTP]);
  expect(client.checkShortable.mock.calls.map(c => c[0]).sort()).toEqual(['CLDX', 'MAZE']);
  expect(broker.liveBuyingPower.mock.calls.map(c => c[0].destinationId)).toEqual(['alpaca1']);
});

test('a question that fails is not the run failing', async () => {
  jest.spyOn(account, 'credsOf').mockReturnValue(null);
  jest.spyOn(broker, 'liveBuyingPower').mockRejectedValue(new Error('401'));
  jest.spyOn(client, 'checkShortable').mockImplementation(() => { throw new Error('boom'); });
  await expect(warmBroker(PICKS, [ALPACA])).resolves.toBeUndefined();
});
