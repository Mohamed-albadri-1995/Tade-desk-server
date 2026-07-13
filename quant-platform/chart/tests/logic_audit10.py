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
                           'exit': 10.5, 'ret': 0.05, 'reason': 'exit'}])
store.update_backtest(bid, status='done', progress=1.0, summary={'trades': 1})
g = store.get_backtest(bid)
chkv('status/progress', (g['status'], g['progress']), ('done', 1.0))
chkv('spec json back', g['spec'], {'a': 1})
chkv('summary back', g['summary'], {'trades': 1})
chkv('trade row back', (g['trades'][0]['symbol'], g['trades'][0]['ret']), ('AAA', 0.05))
chkv('list has it', any(b['id'] == bid for b in store.list_backtests()), True)
chkv('delete', (store.delete_backtest(bid), store.get_backtest(bid)), (True, None))

print("== 2. runner over a stub feed: deterministic 1 trade/day/symbol ==")
rng = np.random.default_rng(11)
class StubLoader:
    def load(self, symbol, tf, start, end):
        idx = pd.date_range(start, end, freq='1min', tz='UTC')[:6000]
        n = len(idx)
        base = (100 if symbol == 'AAA' else 50) + np.cumsum(rng.normal(0, 0.02, n))
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
sc.register_rows = lambda reg, d=None: {'ok': True, 'rows':
    [{'ticker': 'AAA'}] if d == '2024-01-09' else [{'ticker': 'AAA'}, {'ticker': 'BBB'}]}
spec_reg = dict(spec)
spec_reg['universe'] = {'kind': 'register', 'register': 'R1'}
out2 = bt.run(spec_reg)
# in range 01-09..01-11: dates 01-09 (1 ticker) + 01-10 (2 tickers) = 3 pairs
chkv('per-day membership -> 3 pairs', out2['summary']['pairs'], 3)
chkv('3 closed trades', out2['summary']['trades'], 3)
chkv('day-10 has both tickers', sorted(t['symbol'] for t in out2['trades']
                                       if t['date'] == '2024-01-10'), ['AAA', 'BBB'])
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

print(f"\nPASS={PASS} FAIL={FAIL}")
sys.exit(1 if FAIL else 0)
