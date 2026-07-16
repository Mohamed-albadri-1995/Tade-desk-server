"""Audit part 10 — backtest runner (Phase 4 steps 3-5): store roundtrip,
day-slice honesty, symbols + register universes, summary math."""
import sys, json, pathlib, tempfile
import numpy as np, pandas as pd
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2]))
import tools.compare_server as cs
import chart.store as store
import chart.strategy as strat
import chart.backtest as bt

PASS = 0; FAIL = 0
def chkv(name, got, exp):
    global PASS, FAIL
    if got == exp: PASS += 1
    else: FAIL += 1; print(f"  FAIL {name}: got={got!r} exp={exp!r}")
def chktrue(name, cond, info=''):
    global PASS, FAIL
    if cond: PASS += 1
    else: FAIL += 1; print(f"  FAIL {name} {info}")

# fresh temp DB
store._DB = pathlib.Path(tempfile.mkdtemp()) / 'bt.db'; store._conn = None

print("== 1. store roundtrip ==")
bid = store.create_backtest('t1', {'a': 1})
store.update_backtest(bid, progress=0.5)
store.add_bt_trades(bid, [{'date': '2024-01-03', 'symbol': 'AAA', 'side': 'long',
                           'entry_ts': 1000, 'exit_ts': 2000, 'entry': 10.0,
                           'exit': 10.5, 'ret': 0.05, 'reason': 'exit',
                           'ctx': {'score': 66, 'regime': 'STRONG_UP'}}])
store.update_backtest(bid, status='done', progress=1.0, summary={'trades': 1})
g = store.get_backtest(bid)
chkv('status/progress', (g['status'], g['progress']), ('done', 1.0))
chkv('spec json back', g['spec'], {'a': 1})
chkv('summary back', g['summary'], {'trades': 1})
chkv('trade row back', (g['trades'][0]['symbol'], g['trades'][0]['ret']), ('AAA', 0.05))
chkv('ctx json roundtrip', g['trades'][0]['ctx'], {'score': 66, 'regime': 'STRONG_UP'})
chkv('list has it', any(b['id'] == bid for b in store.list_backtests()), True)
chkv('delete', (store.delete_backtest(bid), store.get_backtest(bid)), (True, None))

print("== 1b. seed strategies REFRESH stale copies (not skip) ==")
sid = store.save_strategy({'name': 'Seed X', 'side': 'long',
                           'entry': {'logic': 'AND', 'rules': []},
                           'risk': {'sl': {'type': 'pct', 'value': 1}, 'targets': []}})['id']
# monkeypatch the bundle to a NEW definition for the same name
import chart.store as _st
_orig_glob = _st.Path.glob
class _Seeds:
    def is_dir(self): return True
    def glob(self, pat): return [self]
    def read_text(self): return json.dumps([{'name': 'Seed X', 'side': 'long',
        'entry': {'logic': 'AND', 'rules': []},
        'risk': {'sl': {'type': 'pct', 'value': 1},
                 'targets': [{'fraction': 0.5, 'r_multiple': 2.0}]}}])
import json
_save_dir = _st.Path
_st.Path = lambda *a, **k: type('P', (), {'resolve': lambda s: type('Q', (), {'parent': type('R', (), {'__truediv__': lambda s2, o: _Seeds()})()})()})()
try:
    n = store.seed_strategies()
    got = [s for s in store.list_strategies() if s['name'] == 'Seed X'][0]
    chkv('stale seed was refreshed (targets restored), id kept',
         (got['risk']['targets'][0]['r_multiple'], got['id']), (2.0, sid))
    chkv('refresh is idempotent', store.seed_strategies(), 0)
finally:
    _st.Path = _save_dir

print("== 2. runner over a stub feed: deterministic 1 trade/day/symbol ==")
class StubLoader:
    def load(self, symbol, tf, start, end):
        # deterministic PER (symbol, window) so repeat runs see identical bars
        r = np.random.default_rng(abs(hash((symbol, str(start), str(end)))) % (2**31))
        idx = pd.date_range(start, end, freq='1min', tz='UTC')[:6000]
        n = len(idx)
        base = (100 if symbol == 'AAA' else 50) + np.cumsum(r.normal(0, 0.02, n))
        o = base; c = base + 0.01
        return pd.DataFrame({'open': o, 'high': np.maximum(o, c) + 0.02,
                             'low': np.minimum(o, c) - 0.02, 'close': c,
                             'volume': 1000.0}, index=idx)
cs._LOADERS['stub'] = StubLoader()

# enter exactly at 10:00 ET, exit exactly at 11:00 ET -> 1 closed trade/session
T = lambda: {'kind': 'time', 'field': 'hhmm'}
C = lambda v: {'kind': 'const', 'value': v}
strategy = {'name': 's', 'side': 'long',
            'entry': {'logic': 'AND', 'rules': [{'left': T(), 'op': 'eq', 'right': C(1000)}]},
            'exit':  {'logic': 'AND', 'rules': [{'left': T(), 'op': 'eq', 'right': C(1100)}]}}
spec = {'strategy': strategy, 'tf': '1m', 'days': 2, 'feed': 'stub', 'view': 'all',
        'fill': 'close', 'start': '2024-01-09', 'end': '2024-01-11',
        'universe': {'kind': 'symbols', 'symbols': ['AAA', 'BBB']}}
prog = []
out = bt.run(spec, progress_cb=lambda p: prog.append(p))
s = out['summary']
closed = [t for t in out['trades'] if t['reason'] != 'open']
chkv('pairs = 3 days x 2 syms', s['pairs'], 6)
chkv('one closed trade per pair', s['trades'], 6)
chkv('all exits are rule exits', s['exits_by'], {'exit': 6})
chkv('every trade dated its own day', sorted({t['date'] for t in closed}),
     ['2024-01-09', '2024-01-10', '2024-01-11'])
per_day = {}
for t in closed:
    per_day[(t['date'], t['symbol'])] = per_day.get((t['date'], t['symbol']), 0) + 1
chkv('exactly 1 per (day,symbol)', set(per_day.values()), {1})
chktrue('progress reaches 1.0', prog and abs(prog[-1] - 1.0) < 1e-9)
chkv('equity curve has 6 points', len(s['equity_curve']), 6)
chktrue('win_rate + returns finite',
        isinstance(s['win_rate'], float) and isinstance(s['total_return_pct'], float))

print("== 3. DAY-SLICE honesty: warm-up-day signals never become day-D trades ==")
# the 10:00 signal also fires on warm-up day D-1 inside every asof window;
# if slicing broke, each pair would yield 2+ trades. Assert it's exactly 1
# (already above) AND entry timestamps all lie on the pair's own date:
ok = all(bt._et_date(t['entry_ts']) == t['date'] for t in closed)
chkv('entry ts on its own ET date', ok, True)

print("== 4. register universe (monkeypatched screener) ==")
import chart.screener as sc
_ad, _rr = sc.available_dates, sc.register_rows
sc.available_dates = lambda reg='R1': ['2024-01-09', '2024-01-10', '2024-01-15']
sc.register_rows = lambda reg, d=None, full=False: {'ok': True, 'rows':
    [{'ticker': 'AAA', 'score': 71, 'regime': 'STRONG_UP', 'hot': True}] if d == '2024-01-09'
    else [{'ticker': 'AAA', 'score': 55, 'regime': 'CHOP'}, {'ticker': 'BBB', 'score': 80, 'regime': 'STRONG_UP'}]}
spec_reg = dict(spec)
spec_reg['universe'] = {'kind': 'register', 'register': 'R1'}
out2 = bt.run(spec_reg)
# in range 01-09..01-11: dates 01-09 (1 ticker) + 01-10 (2 tickers) = 3 pairs
chkv('per-day membership -> 3 pairs', out2['summary']['pairs'], 3)
chkv('3 closed trades', out2['summary']['trades'], 3)
chkv('day-10 has both tickers', sorted(t['symbol'] for t in out2['trades']
                                       if t['date'] == '2024-01-10'), ['AAA', 'BBB'])
ctxs = {(t['date'], t['symbol']): t.get('ctx') or {} for t in out2['trades']}
chkv('R1 card rides with each trade', ctxs[('2024-01-09', 'AAA')].get('score'), 71)
chkv('per-day ctx differs', ctxs[('2024-01-10', 'AAA')].get('regime'), 'CHOP')
chkv('symbols universe ctx empty', all(not (t.get('ctx') or {}) for t in out['trades']), True)
# DEDUP: a day's register listing the same symbol twice must yield ONE pair —
# else the second pair is a second evaluate() and slips the per-day cap.
sc.register_rows = lambda reg, d=None, full=False: {'ok': True, 'rows':
    [{'ticker': 'AAA', 'score': 71}, {'ticker': 'aaa', 'score': 40},
     {'ticker': 'BBB', 'score': 80}]}   # AAA duplicated (mixed case)
dup_pairs = bt._pairs({'universe': {'kind': 'register', 'register': 'R1'},
                       'start': '2024-01-09', 'end': '2024-01-09'})
chkv('duplicate register rows collapse to one pair per symbol',
     sorted(s for _, s, _ in dup_pairs), ['AAA', 'BBB'])
chkv('dedup keeps the FIRST card (score 71, not 40)',
     [c.get('score') for _, s, c in dup_pairs if s == 'AAA'], [71])
sc.available_dates, sc.register_rows = _ad, _rr

print("== 5. spec validation errors are clear ==")
for bad, why in [({'strategy': strategy, 'universe': {'kind': 'symbols', 'symbols': []},
                   'start': '2024-01-09', 'end': '2024-01-10'}, 'empty symbols'),
                 ({'strategy': strategy, 'universe': {'kind': 'symbols', 'symbols': ['A']},
                   'start': '2024-01-06', 'end': '2024-01-07'}, 'weekend-only range'),
                 ({'universe': {'kind': 'symbols', 'symbols': ['A']},
                   'start': '2024-01-09', 'end': '2024-01-10'}, 'no strategy')]:
    try:
        bt.run(bad); chkv(f'raises on {why}', 'no-raise', 'raise')
    except ValueError:
        chkv(f'raises on {why}', 'raise', 'raise')

print("== 6. run_and_store lifecycle ==")
bid2 = store.create_backtest('lifecycle', spec)
bt.run_and_store(bid2, spec)
g2 = store.get_backtest(bid2)
chkv('done + full progress', (g2['status'], g2['progress']), ('done', 1.0))
chkv('6 trades persisted', len(g2['trades']), 6)
chkv('summary persisted', g2['summary']['trades'], 6)
# error path: bad spec -> status error with message
bid3 = store.create_backtest('err', {'strategy': strategy})
bt.run_and_store(bid3, {'strategy': strategy})
g3 = store.get_backtest(bid3, with_trades=False)
chkv('error status recorded', g3['status'], 'error')
chktrue('error message present', bool(g3['error']))

print("== 7. Chan metrics: costs, Sharpe, drawdown duration (hand-computed) ==")
# _summary directly with controlled trades. 4 days; day rets: +1%, -2%, +0.5%, +2%
dates4 = ['2024-01-08', '2024-01-09', '2024-01-10', '2024-01-11']
mk = lambda d, r, i: {'date': d, 'symbol': 'X', 'side': 'long', 'entry_ts': i*100,
                      'exit_ts': i*100+50, 'entry': 100, 'exit': 100*(1+r),
                      'ret': r, 'reason': 'exit'}
tr4 = [mk('2024-01-08', 0.01, 1), mk('2024-01-09', -0.02, 2),
       mk('2024-01-10', 0.005, 3), mk('2024-01-11', 0.02, 4)]
s7 = bt._summary(tr4, [], 4, [], all_dates=dates4, cost_bps=0.0)
# daily: [.01,-.02,.005,.02]; mean=.00375; sample sd: dev=[.00625,-.02375,.00125,.01625]
# ss=3.9075e-5+5.640625e-4+1.5625e-6+2.640625e-4 = 8.6875e-4; var=ss/3=2.8958e-4; sd=.017017
# sharpe = .00375/.017017*sqrt(252) = 0.22037*15.8745 = 3.4983 -> 3.5
chkv('sharpe hand-computed', s7['sharpe'], 3.5)
# cum: .01,-.01,-.005,.015 ; peak .01 -> below at day2,3 (run 2), recovered day4
chkv('maxDD duration = 2 days', s7['max_dd_days'], 2)
chkv('maxDD depth = 2%', s7['max_drawdown_pct'], 2.0)
# cost applied in run(): re-run part-2 spec with 10 bps/side -> each trade -0.2%
out_c = bt.run({**spec, 'cost_bps': 10})
gross = {(t['date'], t['symbol']): t['ret'] for t in out['trades']}
net = {(t['date'], t['symbol']): t['ret'] for t in out_c['trades']}
diff_ok = all(abs((gross[k] - net[k]) - 0.002) < 1e-12 for k in gross)
chkv('every round trip pays 2 x 10bps', diff_ok, True)
chkv('cost recorded in summary', out_c['summary']['cost_bps_per_side'], 10.0)

print("== 8. discipline caps entries END-TO-END through backtest.run() ==")
# A sawtooth day: green/red/green/red... A `close>open` long enters on every
# green bar (each a fresh false->true EDGE — the red bar between breaks the run),
# the next red bar exits it. Uncapped that is ~1 trade per green bar; the
# strategy's risk.max_entries_per_day must clamp it — proving discipline flows
# strategy.risk -> evaluate() -> _pair_trades inside the real runner.
class SawLoader:
    def load(self, symbol, tf, start, end):
        idx = pd.date_range(start, end, freq='1min', tz='UTC')[:6000]
        n = len(idx)
        et = idx.tz_convert(cs._ET)
        o = np.full(n, 100.0); c = np.full(n, 100.0)
        for i in range(n):
            # only inside RTH so the pattern is clean; green on even minutes
            if 570 <= et[i].hour * 60 + et[i].minute <= 780:
                if i % 2 == 0: o[i] = 99.95; c[i] = 100.05   # green (enter)
                else:          o[i] = 100.05; c[i] = 99.95   # red   (exit)
        return pd.DataFrame({'open': o, 'high': np.maximum(o, c) + 0.02,
                             'low': np.minimum(o, c) - 0.02, 'close': c,
                             'volume': 1000.0}, index=idx)
cs._LOADERS['saw'] = SawLoader()
Pc = lambda f: {'kind': 'price', 'field': f}
saw_strat = {'name': 'saw', 'side': 'long',
             'entry': {'logic': 'AND', 'rules': [{'left': Pc('close'), 'op': 'gt', 'right': Pc('open')}]},
             'exit':  {'logic': 'AND', 'rules': [{'left': Pc('close'), 'op': 'lt', 'right': Pc('open')}]},
             'risk':  {}}
saw_spec = {'strategy': saw_strat, 'tf': '1m', 'days': 1, 'feed': 'saw', 'view': 'all',
            'fill': 'close', 'start': '2024-01-09', 'end': '2024-01-10',
            'universe': {'kind': 'symbols', 'symbols': ['AAA']}}
def per_day_closed(out):
    d = {}
    for t in out['trades']:
        if t['reason'] != 'open':
            d[t['date']] = d.get(t['date'], 0) + 1
    return d
u = per_day_closed(bt.run(saw_spec))
chktrue(f'uncapped sawtooth over-enters ({max(u.values())}/day)', max(u.values()) > 3)
for cap in (1, 2):
    d = per_day_closed(bt.run({**saw_spec, 'strategy': {**saw_strat, 'risk': {'max_entries_per_day': cap}}}))
    chkv(f'risk.max_entries_per_day={cap}: every day capped to {cap}', set(d.values()), {cap})
# the backtest-panel override still trumps the strategy's own cap
d1 = per_day_closed(bt.run({**saw_spec, 'strategy': {**saw_strat, 'risk': {'max_entries_per_day': 5}},
                            'rules': {'max_entries_per_day': 1}}))
chkv('panel rule overrides strategy cap end-to-end', set(d1.values()), {1})

print(f"\nPASS={PASS} FAIL={FAIL}")
sys.exit(1 if FAIL else 0)
