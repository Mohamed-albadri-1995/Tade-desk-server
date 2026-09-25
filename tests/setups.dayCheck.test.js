/*
 * THE DAILY CHECK — today's backtest against what live did (2026-09-25).
 *
 * Built on fixtures shaped exactly like the three sources it reads: qp's
 * one-day backtest, the desk's ledger, and Alpaca's nested orders. The day:
 *
 *   AAA  both sides took it. Two legs of 50: leg 1 hit its 102 target at
 *        10:05 on both; leg 2 — the runner — left on the exit rule at 10:30 in
 *        the backtest and by the manager's close at 10:30:40 live. Live paid
 *        2 cents more to get in.
 *   BBB  the backtest took it at 09:50; live evaluated BBB on that bar and qp
 *        found nothing.
 *   CCC  live took it; the backtest has no trade.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DAYCHECK_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'daycheck-'));

const request = require('supertest');
const { splitLegs } = require('../src/broker/signalstack');
const risk = require('../src/setups/risk');
const dc = require('../src/setups/dayCheck');

const DAY = '2026-09-24';
const ts = hhmm => Math.floor(Date.parse(`${DAY}T${hhmm}:00-04:00`) / 1000);
const iso = hhmmss => new Date(`${DAY}T${hhmmss}-04:00`).toISOString();

const SETUP = { id: 'S@09:35', name: 'OR + VWAP 09:35', feed: 'yahoo', tools: ['T2'],
                strategyIds: [1, 2], targetR: 2 };
const ACCT = { destinationId: 'alp', destinationName: 'Alpaca A', dialect: 'alpaca', ratio: 1 };

const PLAN = { legs: [{ fraction: 0.5, price: 102, r_multiple: 2 }], runner: 0.5 };
const BT = {
  ok: true, summary: { coverage: {} },
  trades: [
    { symbol: 'AAA', side: 'long', entry_ts: ts('09:41'), entry: 100.00, stop: 99.00,
      exit_ts: ts('10:30'), exit: 99.60, reason: 'exit',
      legs: [{ exit_ts: ts('10:05'), price: 102.00, fraction: 0.5, reason: 'T1' }],
      ctx: { acct_shares: 100, signal_px: 100.00, signal_ts: ts('09:40') }, plan: PLAN },
    { symbol: 'BBB', side: 'long', entry_ts: ts('09:51'), entry: 50.00, stop: 49.50,
      exit_ts: ts('11:00'), exit: 49.50, reason: 'SL', legs: [],
      ctx: { acct_shares: 200, signal_px: 50.00, signal_ts: ts('09:50') },
      plan: { legs: [{ fraction: 0.5, price: 51, r_multiple: 2 }], runner: 0.5 } },
  ],
};

const LEDGER = [
  { date: DAY, at: Date.parse(iso('09:41:02')), setupId: SETUP.id, destination: 'alp',
    symbol: 'AAA', signal: 'LONG', price: 100.00, stop: 99.00, decisionBar: '09:40',
    quantity: 100, sent: true,
    legs: [{ quantity: 50, target: 102, sent: true }, { quantity: 50, target: null, sent: true }] },
  { date: DAY, at: Date.parse(iso('10:30:35')), kind: 'flatten', destination: 'alp',
    symbol: 'AAA', sent: true, source: 'the exit rule fired' },
  { date: DAY, at: Date.parse(iso('10:12:01')), setupId: SETUP.id, destination: 'alp',
    symbol: 'CCC', signal: 'SHORT', price: 20.00, stop: 20.20, decisionBar: '10:11',
    quantity: 30, sent: true },
];

const order = (o) => ({ filledQty: 0, filledAvg: null, legs: [], ...o });
const ORDERS = { ok: true, orders: [
  order({ symbol: 'AAA', side: 'buy', type: 'market', filledQty: 50, filledAvg: 100.02,
          submittedAt: iso('09:41:02'), filledAt: iso('09:41:03'), orderClass: 'bracket',
          legs: [order({ side: 'sell', type: 'limit', limitPrice: 102, filledQty: 50,
                         filledAvg: 102.00, filledAt: iso('10:05:10') }),
                 order({ side: 'sell', type: 'stop', stopPrice: 99, status: 'canceled' })] }),
  order({ symbol: 'AAA', side: 'buy', type: 'market', filledQty: 50, filledAvg: 100.02,
          submittedAt: iso('09:41:03'), filledAt: iso('09:41:04'), orderClass: 'oto',
          legs: [order({ side: 'sell', type: 'stop', stopPrice: 99, status: 'canceled' })] }),
  order({ symbol: 'AAA', side: 'sell', type: 'market', filledQty: 50, filledAvg: 99.55,
          submittedAt: iso('10:30:35'), filledAt: iso('10:30:40') }),
  order({ symbol: 'CCC', side: 'sell', type: 'market', filledQty: 30, filledAvg: 19.98,
          submittedAt: iso('10:12:01'), filledAt: iso('10:12:02'),
          legs: [order({ side: 'buy', type: 'stop', stopPrice: 20.2, filledQty: 30,
                         filledAvg: 20.21, filledAt: iso('10:40:00') })] }),
] };

const RUNS = [
  { kind: 'run', bar: '09:40', ok: true, symbols: ['AAA', 'BBB'], picks: [{ ticker: 'AAA' }] },
  { kind: 'run', bar: '09:50', ok: true, symbols: ['AAA', 'BBB', 'CCC'], picks: [] },
  { kind: 'run', bar: '10:11', ok: true, symbols: ['CCC'], picks: [{ ticker: 'CCC' }] },
];

function deps(over = {}) {
  const asked = [];
  return {
    asked,
    catalog: { list: async () => [SETUP] },
    prefs: { isEnabled: () => true },
    broker: { orders: () => LEDGER, accountsFor: () => [ACCT], destinationCfg: () => null,
              splitLegs },
    qp: { backtestDay: async (spec) => { asked.push(spec); return BT; } },
    sessionLog: { runsOn: () => RUNS },
    risk: { settings: () => ({ accountSize: 100000 }), ratioOf: risk.ratioOf },
    specFor: () => ({ account_equity: 100000, risk_usd: 100, tf: '1m', fill: 'desk',
                      rules: { rth_entries: true, eod_close: true, one_per_symbol_day: true },
                      universe: { kind: 'tools', register: 'R1', tools: ['T2'] } }),
    alpacaOrders: async () => ORDERS,
    ...over,
  };
}

describe('the backtest it runs', () => {
  test('the live settings, the live feed, one day, the names live evaluated, no costs', async () => {
    const d = deps();
    await dc.build(DAY, d);
    const spec = d.asked[0];
    expect(spec).toMatchObject({ start: DAY, end: DAY, feed: 'yahoo', fill: 'desk',
      strategy_ids: [1, 2], size_ratio: 1, cost_bps: 0, check_shortable: true,
      rules: { rth_entries: true, eod_close: true, one_per_symbol_day: true } });
    expect(spec.universe).toMatchObject({ kind: 'tools', register: 'R1', tools: ['T2'] });
    expect(spec.universe.extra_symbols.sort()).toEqual(['AAA', 'BBB', 'CCC']);
  });

  test('one backtest per account size, not per account', async () => {
    const d = deps();
    d.broker.accountsFor = () => [ACCT, { ...ACCT, destinationId: 'alp2', destinationName: 'B' }];
    await dc.build(DAY, d);
    expect(d.asked).toHaveLength(1);
  });
});

describe('who took what', () => {
  let setup;
  beforeAll(async () => { setup = (await dc.build(DAY, deps())).setups[0]; });
  const trade = sym => setup.trades.find(t => t.symbol === sym);

  test('AAA both, BBB backtest only, CCC live only', () => {
    expect(trade('AAA').status).toBe('both');
    expect(trade('BBB').status).toBe('backtest only');
    expect(trade('CCC').status).toBe('live only');
    expect(setup.totals).toMatchObject({ backtest: 2, live: 2, both: 1, backtestOnly: 1, liveOnly: 1 });
  });

  test('why live has no BBB: it looked on that bar and qp found nothing', () => {
    expect(trade('BBB').accounts[0].why.join(' ')).toMatch(/evaluated live at 09:50 and qp found no signal/);
  });

  test('why the backtest has no CCC', () => {
    expect(trade('CCC').accounts[0].why[0]).toMatch(/backtest found no trade on CCC/);
  });
});

describe('one trade, side by side', () => {
  let a;
  beforeAll(async () => {
    a = (await dc.build(DAY, deps())).setups[0].trades.find(t => t.symbol === 'AAA').accounts[0];
  });
  const row = (rows, f) => rows.find(r => r.field === f);

  test('entry: the real fill against the backtest\'s, and what it cost', () => {
    expect(a.live.entry).toMatchObject({ price: 100.02, qty: 100, at: '09:41:03' });
    expect(a.bt.entry).toMatchObject({ price: 100, qty: 100, at: '09:41' });
    expect(row(a.cmp.rows, 'entry price').note).toMatch(/worse by \$0.02/);
    expect(row(a.cmp.rows, 'decision bar').level).toBe('ok');
    expect(row(a.cmp.rows, 'quantity').level).toBe('ok');
  });

  test('leg 1: the target, both sides, same price', () => {
    const L = a.cmp.legs[0].rows;
    expect(row(L, 'quantity')).toMatchObject({ bt: 50, live: 50, level: 'ok' });
    expect(row(L, 'how it ended')).toMatchObject({ bt: 'target', live: 'target', level: 'ok' });
    expect(row(L, 'exit price')).toMatchObject({ bt: 102, live: 102 });
  });

  test('leg 2: the runner, left on the exit rule — live by the manager\'s close, named', () => {
    const L = a.cmp.legs[1].rows;
    expect(a.cmp.legs[1].runner).toBe(true);
    expect(row(L, 'how it ended')).toMatchObject({ bt: 'exit rule', live: 'exit rule', level: 'ok' });
    expect(row(L, 'exit price')).toMatchObject({ bt: 99.6, live: 99.55 });
    expect(row(L, 'exit time')).toMatchObject({ bt: '10:30', live: '10:30:40', level: 'ok' });
  });

  test('P&L: the backtest\'s legs and Alpaca\'s money', () => {
    // backtest: 50 x 2.00 + 50 x -0.40 = 80. live: 50 x 101.9999... from fills:
    // sells 5100 + 4977.5 - buys 10002 = 75.5
    expect(a.bt.pnl).toBe(80);
    expect(a.live.pnl).toBe(75.5);
    expect(row(a.cmp.rows, 'P&L').note).toMatch(/live -4.5 vs the backtest/);
  });

  test('a different leg ending is a different trade', () => {
    const bt = dc.backtestTrade(BT.trades[0], splitLegs);
    const live = { ...bt, legs: bt.legs.map((l, i) => (i === 1
      ? { ...l, exit: { ...l.exit, kind: 'stop' } } : l)) };
    expect(dc.compare(bt, live).worst).toBe('bad');
  });
});

describe('an account with no fill feed', () => {
  test('the ledger\'s own record, said as such', async () => {
    const d = deps();
    d.broker.accountsFor = () => [{ ...ACCT, dialect: 'ttp', destinationName: 'TTP' }];
    const s = (await dc.build(DAY, d)).setups[0];
    const a = s.trades.find(t => t.symbol === 'AAA').accounts[0];
    expect(a.live.source).toBe('ledger');
    expect(a.live.entry).toMatchObject({ price: null, planned: 100, qty: 100 });
    expect(a.live.legs[1].exit).toMatchObject({ kind: 'close sent', why: 'the exit rule fired' });
    expect(s.accounts[0].fills).toMatch(/no fill feed/);
  });
});

describe('why the backtest took a trade live did not', () => {
  const runs = RUNS;
  test('never on the card list', () => {
    expect(dc.whyNotLive('ZZZ', '09:50', runs, [])[0]).toMatch(/not on the card list at 09:50 \(never evaluated/);
  });
  test('no run on that bar', () => {
    expect(dc.whyNotLive('BBB', '09:45', runs, [])[0]).toMatch(/did not run on the 09:45 bar/);
  });
  test('dropped as stale', () => {
    const r = [{ bar: '09:50', ok: true, symbols: ['BBB'], dropped: { stale: ['BBB'] }, feed: { lagMin: 2 } }];
    expect(dc.whyNotLive('BBB', '09:50', r, [])[0]).toMatch(/stale.*2 min behind/);
  });
  test('refused by the broker comes first', () => {
    expect(dc.whyNotLive('BBB', '09:50', runs,
      [{ destination: 'alp', skipped: 'BBB cannot be sold short' }])[0]).toMatch(/cannot be sold short/);
  });
});

describe('when it runs', () => {
  const at = (hhmm, day = DAY) => Date.parse(`${day}T${hhmm}:00-04:00`);
  test('16:10 on a weekday with no report', () => {
    expect(dc.due(at('16:10'), null)).toBe(true);
    expect(dc.due(at('16:09'), null)).toBe(false);
  });
  test('not again once it succeeded', () => {
    expect(dc.due(at('16:25'), { ok: true })).toBe(false);
  });
  test('retried every 15 minutes until 18:00 after a failure', () => {
    expect(dc.due(at('16:25'), { ok: false })).toBe(true);
    expect(dc.due(at('16:26'), { ok: false })).toBe(false);
    expect(dc.due(at('18:10'), { ok: false })).toBe(false);
  });
  test('never on a weekend', () => {
    expect(dc.due(at('16:10', '2026-09-26'), null)).toBe(false);
  });
});

describe('stored, and read back by the Algo page', () => {
  afterAll(() => fs.rmSync(process.env.DAYCHECK_DIR, { recursive: true, force: true }));

  test('a run is saved under its date and served by GET /api/daycheck', async () => {
    const r = await dc.run(DAY, deps());
    expect(r.ok).toBe(true);
    expect(dc.dates()).toContain(DAY);
    const app = require('../src/alerts/server');
    const res = await request(app).get(`/api/daycheck?date=${DAY}`);
    expect(res.body).toMatchObject({ ok: true, date: DAY, running: false, runsAt: '16:10' });
    expect(res.body.report.setups[0].trades.map(t => t.symbol).sort()).toEqual(['AAA', 'BBB', 'CCC']);
  });

  test('a failed build is saved as a failure, not as an empty day', async () => {
    const d = deps({ catalog: { list: async () => { throw new Error('qp is down'); } } });
    const r = await dc.run('2026-09-23', d);
    expect(r).toMatchObject({ ok: false, error: 'qp is down' });
    expect(dc.read('2026-09-23').ok).toBe(false);
  });
});

/*
 * FOUND ON THE FIRST REAL DAY (2026-09-25), each with the shape it had:
 *   SECZ  short, not shortable: the backtest sized it to 0 shares and live's
 *         order was refused — neither traded it, and it read BACKTEST ONLY;
 *   WIX   signalled at 09:34 and was ranked out of live's top 3 — it read
 *         "qp found no signal";
 *   SNX   dropped as stale 'SNX@09:42' — never recognised, the log names it
 *         with its bar;
 *   the check was run at 11:14, with trades still open on both sides.
 */
describe('the first real day', () => {
  const skippedBt = {
    symbol: 'SECZ', side: 'short', entry_ts: ts('09:35'), entry: 15.73, stop: 15.975,
    exit_ts: ts('10:00'), exit: 15.8, reason: 'SL', legs: [],
    ctx: { acct_shares: 0, acct_note: 'SECZ cannot be sold short at this broker',
           signal_px: 15.85, signal_ts: ts('09:34') } };

  test('not taken by either side is not a mismatch — both reasons are given', async () => {
    const d = deps({ qp: { backtestDay: async () => ({ ok: true, summary: {}, trades: [skippedBt] }) } });
    d.broker.orders = () => [{ date: DAY, at: Date.parse(iso('09:35:13')), setupId: SETUP.id,
      destination: 'alp', symbol: 'SECZ', signal: 'SHORT', sent: false,
      skipped: 'Alpaca will not short SECZ — the asset is not shortable' }];
    const s = (await dc.build(DAY, d)).setups[0];
    const t = s.trades.find(x => x.symbol === 'SECZ');
    expect(t).toMatchObject({ status: 'skipped by both', worst: 'ok' });
    expect(t.accounts[0].why.join(' ')).toMatch(/backtest: .*cannot be sold short/);
    expect(t.accounts[0].why.join(' ')).toMatch(/live: .*not shortable/);
    expect(s.totals).toMatchObject({ backtest: 0, backtestOnly: 0, skippedBoth: 1 });
  });

  test('live took one the backtest skipped: said as that, not as "no trade"', async () => {
    const d = deps({ qp: { backtestDay: async () => ({ ok: true, summary: {},
      trades: [{ ...skippedBt, symbol: 'CCC' }] }) } });
    const t = (await dc.build(DAY, d)).setups[0].trades.find(x => x.symbol === 'CCC');
    expect(t.status).toBe('live only');
    expect(t.accounts[0].why[0]).toMatch(/signalled it too and did not take it: .*cannot be sold short/);
  });

  test('ranked out of live\'s top N', () => {
    const runs = [{ bar: '09:34', ok: true, symbols: ['WIX', 'TWST'], rank: { topN: 3 },
                    picks: [{ ticker: 'TWST' }, { ticker: 'SECZ' }, { ticker: 'BYND' }],
                    dropped: { rankedOut: ['WIX@09:34', 'KGC@09:34'] } }];
    expect(dc.whyNotLive('WIX', '09:34', runs, [])[0])
      .toMatch(/RANKED OUT — live took the top 3 \(TWST, SECZ, BYND\)/);
  });

  test('a stale drop is recognised by its SYM@HH:MM name', () => {
    const runs = [{ bar: '09:42', ok: true, symbols: ['SNX'], dropped: { stale: ['SNX@09:41'] } }];
    expect(dc.whyNotLive('SNX', '09:42', runs, [])[0]).toMatch(/dropped as stale/);
  });

  test('a check run during the session says so', async () => {
    const r = await dc.build(DAY, deps({ now: Date.parse(`${DAY}T11:14:00-04:00`) }));
    expect(r.partial).toBe(true);
    const after = await dc.build(DAY, deps({ now: Date.parse(`${DAY}T16:10:00-04:00`) }));
    expect(after.partial).toBe(false);
  });
});

/*
 * THE QUESTION ASKED (2026-09-25): "confirm everything is identical to the
 * backtest and the only reason for a mismatch is data latency." The check
 * replays the live decision on the final bars (qp `replay_live`); when that is
 * identical to the backtest, every difference is labelled with its cause.
 */
describe('the logic check and the cause of each difference', () => {
  const REPLAY_OK = { identical: true, compared: 2, minutes: 120, symbols: 3, mismatches: [] };
  // SNX: live read the 09:40 bar before it was final.
  const snxLive = LEDGER.map(o => (o.symbol === 'AAA' && !o.kind ? { ...o, price: 99.72 } : o));

  test('the replay is asked for once per setup, and its verdict is on the setup', async () => {
    const d = deps({ qp: { backtestDay: async (spec) => { d.asked.push(spec);
      return { ...BT, replay: REPLAY_OK }; } } });
    d.broker.accountsFor = () => [ACCT, { ...ACCT, destinationId: 'b', destinationName: 'B', ratio: 0.5 }];
    const s = (await dc.build(DAY, d)).setups[0];
    expect(d.asked.map(x => x.replay_live)).toEqual([true, false]);
    expect(s.logic).toMatchObject({ identical: true, compared: 2 });
  });

  test('an unfinished bar is DATA when the logic is identical — and that is the verdict', async () => {
    const d = deps({ qp: { backtestDay: async () => ({ ...BT, replay: REPLAY_OK }) } });
    d.broker.orders = () => snxLive;
    const s = (await dc.build(DAY, d)).setups[0];
    const a = s.trades.find(t => t.symbol === 'AAA').accounts[0];
    expect(a.causes.map(c => c.kind)).toContain('DATA');
    expect(a.causes.find(c => c.kind === 'DATA').text).toMatch(/before it was final: close 99.72 live, 100 final/);
    expect(s.verdict.onlyDataAndExecution).toBe(true);
  });

  test('the same difference with the logic check failing is LOGIC, never DATA', async () => {
    const d = deps({ qp: { backtestDay: async () => ({ ...BT, replay: { ...REPLAY_OK, identical: false,
      mismatches: [{ symbol: 'AAA', ok: false, why: 'decision bar 09:40 vs 09:41' }] } }) } });
    const s = (await dc.build(DAY, d)).setups[0];
    expect(s.verdict).toMatchObject({ logicIdentical: false, onlyDataAndExecution: false });
    expect(s.logic.mismatches[0].why).toMatch(/09:41/);
  });

  test('one-sided trades get a cause too', () => {
    const k = (why, ok = true) => dc.causesOf({ status: 'backtest only', why: [why] }, ok)[0].kind;
    expect(k('signalled at 09:34 and was RANKED OUT — live took the top 3')).toBe('DATA');
    expect(k('the order was not sent to alpaca1: Alpaca will not short SECZ — the asset is not shortable')).toBe('BROKER');
    expect(k('not on the card list at 09:34 (never evaluated live today)')).toBe('UNIVERSE');
    expect(k('the setup did not run on the 09:45 bar')).toBe('SYSTEM');
    expect(k('evaluated live at 09:50 and qp found no signal — the bars live read', false)).toBe('LOGIC');
  });
});

/*
 * THE FOUR REAL TRADES OF 2026-09-25, with the numbers the Check showed. The
 * first version called MGNI "LOGIC: the same price and stop sized
 * differently" — its stop was 24.0388 live against 24.0416 final, inside a
 * one-cent tolerance, and 0.3 cents of stop is 54 shares at that distance.
 * It called SNX's exits EXECUTION when the manager closed at 09:48 on the
 * bars it read and the final bars stop out at 10:14 — DATA. And it charged
 * TWST's whole 80 cents to the fill when 19 of them were the stop's level.
 */
describe('the causes of the real day', () => {
  const leg = (qty, target, kind, price, at, why = null) =>
    ({ qty, target, runner: !target, exit: { kind, price, at, why }, pnl: null });
  const T = (o) => ({ pnl: null, reduced: null, note: null, ...o });
  const causes = (b, l) => dc.causesOf({ status: 'both', bt: b, live: l, cmp: dc.compare(b, l) }, true);
  const kinds = c => c.map(x => x.kind);
  const MGR = "the backtest's stop was hit 1 bar(s) ago — the tested strategy is flat here";

  test('MGNI: a 0.3-cent stop is DATA, and the stop fills are EXECUTION — never LOGIC', () => {
    const b = T({ side: 'long', decisionBar: '09:45', decisionPrice: 24.195, stop: 24.04163,
      entry: { price: 24.14, at: '09:46', qty: 2934 },
      legs: [leg(293, 24.6551, 'stop', 23.98, '09:59'), leg(2347, 25.1151, 'stop', 23.98, '09:59'),
             leg(294, null, 'stop', 23.98, '09:59')] });
    const l = T({ side: 'long', decisionBar: '09:45', decisionPrice: 24.195, stop: 24.0388,
      entry: { price: 24.2207, at: '09:46:05', qty: 2880 },
      legs: [leg(288, 24.66, 'stop', 23.94, '09:59:42'), leg(2304, 25.13, 'stop', 23.94, '09:59:43'),
             leg(288, null, 'stop', 23.94, '09:59:41')] });
    const c = causes(b, l);
    expect(kinds(c)).not.toContain('LOGIC');
    expect(c.find(x => /risk per share/.test(x.text)).text).toMatch(/→ 2880 and 2934 shares/);
    expect(c.find(x => /every leg: the stop filled/.test(x.text)).kind).toBe('EXECUTION');
  });

  test('SNX: the manager closed on the bars it read — DATA, said once for every leg', () => {
    const b = T({ side: 'long', decisionBar: '09:42', decisionPrice: 279.6519, stop: 272.2135,
      entry: { price: 280, at: '09:43', qty: 60 },
      legs: [leg(6, 301.9671, 'stop', 274.1642, '10:14'), leg(48, 324.2823, 'stop', 274.1642, '10:14'),
             leg(6, null, 'stop', 274.1642, '10:14')] });
    const l = T({ side: 'long', decisionBar: '09:42', decisionPrice: 279.37, stop: 271.6326,
      entry: { price: 280.7891, at: '09:43:04', qty: 57 },
      legs: [leg(5, 302.58, 'stop', 278.04, '09:48:16', MGR), leg(45, 325.79, 'stop', 278.04, '09:48:16', MGR),
             leg(7, null, 'stop', 278.04, '09:48:16', MGR)] });
    const c = causes(b, l);
    expect(kinds(c)).not.toContain('LOGIC');
    expect(c[0]).toMatchObject({ kind: 'DATA' });
    expect(c[0].text).toMatch(/close 279.37 live, 279.6519 final; the stop with it/);
    const exits = c.filter(x => /every leg/.test(x.text));
    expect(exits).toHaveLength(1);
    expect(exits[0]).toMatchObject({ kind: 'DATA' });
    expect(exits[0].text).toMatch(/left at 09:48:16 live, 10:14 in the backtest.*manager judged it/);
  });

  test('TWST: 19 cents of stop level is DATA, 61 cents past it is EXECUTION', () => {
    const b = T({ side: 'short', decisionBar: '09:34', decisionPrice: 180.375, stop: 183.1,
      entry: { price: 180.475, at: '09:35', qty: 164 },
      legs: [leg(82, 174.925, 'stop', 183.1, '10:26'), leg(82, null, 'stop', 183.1, '10:26')] });
    const l = T({ side: 'short', decisionBar: '09:34', decisionPrice: 180.375, stop: 183.2875,
      entry: { price: 180.4975, at: '09:35:19', qty: 153 },
      legs: [leg(76, 174.55, 'stop', 183.9, '10:26:33'), leg(77, null, 'stop', 183.9, '10:26:33')] });
    const c = causes(b, l);
    expect(kinds(c)).not.toContain('LOGIC');
    expect(c.find(x => /stop's level/.test(x.text))).toMatchObject({ kind: 'DATA' });
    expect(c.find(x => /every leg: the stop filled 0.6125 past its level/.test(x.text)).kind).toBe('EXECUTION');
  });

  test('TECK: a later signal is DATA; 308 against 35 shares is the money left — KNOCK-ON', () => {
    const b = T({ side: 'long', decisionBar: '09:54', decisionPrice: 65.98, stop: 65.9127,
      entry: { price: 65.96, at: '09:55', qty: 35 },
      legs: [leg(3, 66.1818, 'stop', 65.9129, '09:55'), leg(28, 66.3836, 'stop', 65.9129, '09:55'),
             leg(4, null, 'stop', 65.9129, '09:55')] });
    const l = T({ side: 'long', decisionBar: '09:56', decisionPrice: 65.96, stop: 65.9169,
      entry: { price: 66.0081, at: '09:57:03', qty: 308 },
      reduced: 'reduced to fit $20318 left of the account size 100000 × 0.9, after the trades still open (308 shares)',
      legs: [leg(30, 66.09, 'stop', 65.91, '09:59:26'), leg(246, 66.22, 'stop', 65.91, '09:59:26'),
             leg(32, null, 'stop', 65.91, '09:59:26')] });
    const c = causes(b, l);
    expect(kinds(c)).not.toContain('LOGIC');
    expect(c.find(x => /signal came on 09:56/.test(x.text)).kind).toBe('DATA');
    expect(c.find(x => /money left/.test(x.text)).kind).toBe('KNOCK-ON');
  });
});
