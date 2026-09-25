/*
 * ONE ANSWER PER SETUP: DOES LIVE RUN WHAT WAS BACKTESTED?
 *
 * parity.js compared the settings and nothing called it; the strategy's rules
 * could be edited after a run with nothing to say so. This is the check that
 * joins them, and the rule it must keep: "could not check" is never "match".
 */
const os = require('os');
const path = require('path');
const fs = require('fs');

const PREFS = path.join(os.tmpdir(), `setup-prefs-pc-${process.pid}.json`);
const RISK = path.join(os.tmpdir(), `risk-pc-${process.pid}.json`);
process.env.SETUP_PREFS_FILE = PREFS;
process.env.RISK_FILE = RISK;
process.env.SHARED_KEYS_FILE = path.join(os.tmpdir(), `keys-pc-${process.pid}.json`);
afterAll(() => {
  for (const f of [PREFS, RISK]) { try { fs.unlinkSync(f); } catch { /* absent */ } }
});

jest.mock('../src/setups/qpClient', () => ({
  strategies: jest.fn(), setTools: jest.fn(), parity: jest.fn(),
}));
const qp = require('../src/setups/qpClient');
const { check, toHHMM } = require('../src/setups/parityCheck');

const LONG = { id: 1, name: 'OR + VWAP 09:35 (Long)', side: 'long', stage: 'ready',
               tools: ['T11'], risk: { window_start: 935, window_end: 935 } };
const SHORT = { ...LONG, id: 2, name: 'OR + VWAP 09:35 (Short)', side: 'short' };
const ID = 'OR + VWAP 09:35@09:35';

// Everything the desk runs, stated the same way in the run — so only the
// thing a test changes can differ.
const SPEC = { fill: 'desk', tf: '1m', feed: 'polygon', view: 'all',
               account_equity: 25000, risk_usd: 100,
               rank_per_day: { metric: 'rvol', top_n: 2 },
               rules: { max_entries_per_day: 2, one_per_symbol_day: true },
               universe: { kind: 'tools', tools: ['T11'] } };
const run = (over = {}) => ({ ok: true, backtest: {
  id: 42, name: 'bt', created_at: 1, spec: { ...SPEC, ...over },
  summary: { trades: 80, win_rate: 51.2 } }, rules: [
  { strategy_id: 1, name: LONG.name, frozen: true, changed: [] },
  { strategy_id: 2, name: SHORT.name, frozen: true, changed: [] }] });

beforeEach(() => {
  fs.writeFileSync(RISK, JSON.stringify({ accountSize: 25000, riskPerTrade: 100 }));
  fs.writeFileSync(PREFS, JSON.stringify({ setups: { [ID]: {
    rankMetric: 'rvol', topN: 2, maxTradesPerDay: 2 } } }));
  qp.strategies.mockResolvedValue([LONG, SHORT]);
});

test('toHHMM reads the catalogue\'s clock into qp\'s integer', () => {
  expect(toHHMM('09:35')).toBe(935);
  expect(toHHMM(null)).toBeNull();
});

test('asks qp about BOTH books of the pair', async () => {
  qp.parity.mockResolvedValue(run());
  await check(ID);
  expect(qp.parity).toHaveBeenLastCalledWith([1, 2], null);
});

test('a pinned run is asked for by id, and the runs come back to choose from', async () => {
  const cur = JSON.parse(fs.readFileSync(PREFS, 'utf8'));
  cur.setups[ID].parityBacktest = 332;
  fs.writeFileSync(PREFS, JSON.stringify(cur));
  qp.parity.mockResolvedValue({ ...run(), picked_by: 'pinned',
    runs: [{ id: 363, start: '2026-09-15', end: '2026-09-15', fill: 'desk', trades: 3 },
           { id: 332, start: '2026-07-30', end: '2026-08-20', fill: 'next_open', trades: 171 }] });
  const r = await check(ID);
  expect(qp.parity).toHaveBeenLastCalledWith([1, 2], 332);
  expect(r.pickedBy).toBe('pinned');
  expect(r.runs.map(x => x.id)).toEqual([363, 332]);
});

test('an aligned setup reads match, with the run\'s numbers', async () => {
  qp.parity.mockResolvedValue(run());
  const r = await check(ID);
  expect(r.lines).toEqual([]);
  expect(r.verdict).toBe('match');
  expect(r.backtest).toMatchObject({ id: 42, trades: 80, win_rate: 51.2 });
  expect(r.settings.find(x => x.what === 'decision bar'))
    .toMatchObject({ live: '09:34', backtest: '09:34', status: 'match' });
});

test('a fill model that decides on a different bar is a difference', async () => {
  qp.parity.mockResolvedValue(run({ fill: 'close' }));
  const r = await check(ID);
  expect(r.verdict).toBe('differ');
  expect(r.lines[0]).toMatch(/decision bar: live 09:34 · backtest 09:35/);
});

test('a rule edited after the run is a difference, named', async () => {
  const rep = run();
  rep.rules[0].changed = [{ path: 'risk.sl.value', then: '0.6', now: '1.0' }];
  qp.parity.mockResolvedValue(rep);
  const r = await check(ID);
  expect(r.verdict).toBe('differ');
  expect(r.lines[0]).toMatch(/\(Long\): 1 rule\(s\) changed since backtest #42 — risk\.sl\.value/);
});

test('a run with no frozen copy is unknown, never match', async () => {
  const rep = run();
  rep.rules[1] = { strategy_id: 2, name: SHORT.name, frozen: false, changed: [],
                   note: 'this run kept no copy' };
  qp.parity.mockResolvedValue(rep);
  expect((await check(ID)).verdict).toBe('unknown');
});

test('no run at all is unknown, and says so', async () => {
  qp.parity.mockResolvedValue({ ok: true, backtest: null, rules: [] });
  const r = await check(ID);
  expect(r.verdict).toBe('unknown');
  expect(r.lines[0]).toMatch(/No finished backtest/);
});

test('qp down is unknown with the reason, not an exception', async () => {
  qp.parity.mockRejectedValue(new Error('ECONNREFUSED'));
  const r = await check(ID);
  expect(r).toMatchObject({ ok: false, verdict: 'unknown' });
  expect(r.error).toMatch(/ECONNREFUSED/);
});

test('no such setup is a 404', async () => {
  expect(await check('nope')).toMatchObject({ ok: false, status: 404 });
});
