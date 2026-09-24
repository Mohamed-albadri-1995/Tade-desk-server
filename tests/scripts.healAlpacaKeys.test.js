/*
 * The desk-wide Alpaca pair (data/keys.json) was refused all day on
 * 2026-09-24 while each account's own pair worked. It need not belong to any
 * particular account, so the deploy now replaces a REFUSED one with the first
 * account pair Alpaca answers for — and touches nothing on any other answer.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { heal } = require('../scripts/heal-alpaca-keys');
const SRC = fs.readFileSync(path.join(__dirname, '..', 'deploy-tools.sh'), 'utf8');

const DEAD = 'PKTESTDEADDEADDEADDE';
const A1 = 'PKTESTACCOUNTONEONE1';
const A2 = 'PKTESTACCOUNTTWOTWO2';

function setup(shared, dests) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'heal-'));
  const keysFile = path.join(dir, 'keys.json');
  const brokerFile = path.join(dir, 'broker.json');
  if (shared) fs.writeFileSync(keysFile, JSON.stringify(shared));
  fs.writeFileSync(brokerFile, JSON.stringify({ destinations: dests }));
  return { keysFile, brokerFile };
}
const dest = (id, key, extra = {}) => ({ id, name: id, dialect: 'alpaca',
  alpacaKeyId: key, alpacaSecret: `secret-${key}`, ...extra });
// Alpaca, as a table: key -> HTTP status (anything missing throws = no network)
const alpaca = (table) => async (url, opts) => {
  const s = table[opts.headers['APCA-API-KEY-ID']];
  if (s === undefined) throw new Error('offline');
  return { ok: s === 200, status: s };
};

async function run(shared, dests, table) {
  const applied = [];
  const said = [];
  const r = await heal({ ...setup(shared, dests), fetchFn: alpaca(table),
    apply: (k, s, live) => { applied.push({ k, s, live }); return true; },
    say: (m) => said.push(m) });
  return { r, applied, said: said.join('\n') };
}

describe('the deploy heals a refused desk-wide Alpaca key', () => {
  test('refused → the first account pair Alpaca answers for is written', async () => {
    const { r, applied, said } = await run(
      { alpacaApiKey: DEAD, alpacaApiSecret: 'x' },
      [dest('a1', A1), dest('a2', A2)],
      { [DEAD]: 401, [A1]: 401, [A2]: 200 });
    expect(r).toEqual({ action: 'replaced', from: 'a2' });
    expect(applied).toEqual([{ k: A2, s: `secret-${A2}`, live: false }]);
    expect(said).toMatch(/REFUSED/);
    expect(said).toMatch(/replaced with a2's own key \(paper\)/);
  });

  test('a working desk-wide key is left alone', async () => {
    const { r, applied } = await run({ alpacaApiKey: DEAD, alpacaApiSecret: 'x' },
      [dest('a1', A1)], { [DEAD]: 200, [A1]: 200 });
    expect(r.action).toBe('none');
    expect(applied).toEqual([]);
  });

  test('no network is not evidence the key is wrong — nothing changes', async () => {
    const { r, applied } = await run({ alpacaApiKey: DEAD, alpacaApiSecret: 'x' },
      [dest('a1', A1)], { [A1]: 200 });
    expect(r.action).toBe('none');
    expect(applied).toEqual([]);
  });

  test('a 5xx is not a refusal either', async () => {
    const { applied } = await run({ alpacaApiKey: DEAD, alpacaApiSecret: 'x' },
      [dest('a1', A1)], { [DEAD]: 503, [A1]: 200 });
    expect(applied).toEqual([]);
  });

  test('no desk-wide key at all → an account pair fills the slot', async () => {
    const { r } = await run(null, [dest('a1', A1)], { [A1]: 200 });
    expect(r.action).toBe('replaced');
  });

  test('a live account is asked, and written, as live', async () => {
    const { applied } = await run({ alpacaApiKey: DEAD, alpacaApiSecret: 'x' },
      [dest('a1', A1, { alpacaPaper: false })], { [DEAD]: 401, [A1]: 200 });
    expect(applied[0].live).toBe(true);
  });

  test('nothing works → says so and writes nothing', async () => {
    const { r, applied, said } = await run({ alpacaApiKey: DEAD, alpacaApiSecret: 'x' },
      [dest('a1', A1)], { [DEAD]: 401, [A1]: 403 });
    expect(r.action).toBe('none');
    expect(applied).toEqual([]);
    expect(said).toMatch(/no account's own key was answered/);
  });

  test('no key is ever printed', async () => {
    const { said } = await run({ alpacaApiKey: DEAD, alpacaApiSecret: 'x' },
      [dest('a1', A1)], { [DEAD]: 401, [A1]: 200 });
    for (const k of [DEAD, A1, `secret-${A1}`]) expect(said).not.toContain(k);
  });

  test('the deploy runs it before the pair is copied to qp, and never stops on it', () => {
    const heal = SRC.indexOf('node scripts/heal-alpaca-keys.js || true');
    const sync = SRC.indexOf('node scripts/sync-qp-env.js');
    expect(heal).toBeGreaterThan(-1);
    expect(heal).toBeLessThan(sync);
  });
});
