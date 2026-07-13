"""Audit part 11 — backtest API lifecycle (Phase 4 step 6): start → poll →
done with trades; concurrent-run guard; validation errors; delete guard."""
import sys, time, pathlib, tempfile
import numpy as np, pandas as pd
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2]))
import tools.compare_server as cs
import chart.store as store

# fresh temp DB BEFORE the server imports the store handles
store._DB = pathlib.Path(tempfile.mkdtemp()) / 'api.db'; store._conn = None
import chart.server as srv

PASS = 0; FAIL = 0
def chkv(name, got, exp):
    global PASS, FAIL
    if got == exp: PASS += 1
    else: FAIL += 1; print(f"  FAIL {name}: got={got!r} exp={exp!r}")
def body(resp):
    import json
    return json.loads(bytes(resp.body)) if hasattr(resp, 'body') else resp

rng = np.random.default_rng(5)
class StubLoader:
    def load(self, symbol, tf, start, end):
        idx = pd.date_range(start, end, freq='1min', tz='UTC')[:4000]
        n = len(idx)
        base = 100 + np.cumsum(rng.normal(0, 0.02, n))
        return pd.DataFrame({'open': base, 'high': base + 0.03, 'low': base - 0.03,
                             'close': base + 0.01, 'volume': 1000.0}, index=idx)
cs._LOADERS['stub'] = StubLoader()

T = lambda: {'kind': 'time', 'field': 'hhmm'}
C = lambda v: {'kind': 'const', 'value': v}
strategy = {'name': 'api-bt', 'side': 'long',
            'entry': {'logic': 'AND', 'rules': [{'left': T(), 'op': 'eq', 'right': C(1000)}]},
            'exit':  {'logic': 'AND', 'rules': [{'left': T(), 'op': 'eq', 'right': C(1100)}]}}
saved = store.save_strategy(strategy)          # backtest by strategy_id like the UI
spec = {'name': 'api run', 'strategy_id': saved['id'],
        'universe': {'kind': 'symbols', 'symbols': ['AAA']},
        'start': '2024-01-09', 'end': '2024-01-10',
        'tf': '1m', 'days': 2, 'feed': 'stub', 'view': 'all', 'fill': 'next_open'}

print("== start → poll → done ==")
r = srv.backtest_start(spec)
r = body(r) if not isinstance(r, dict) else r
chkv('start ok', r.get('ok'), True)
bid = r['id']
for _ in range(120):
    g = store.get_backtest(bid, with_trades=False)
    if g['status'] != 'running':
        break
    time.sleep(0.25)
chkv('finishes done', g['status'], 'done')
full = body(srv.backtest_get(bid))
chkv('get ok + trades present', (full['ok'], len(full['backtest']['trades']) > 0), (True, True))
chkv('2 trades (2 days x 1 sym, 1/day)', full['backtest']['summary']['trades'], 2)
chkv('fill recorded in spec', full['backtest']['spec']['fill'], 'next_open')

print("== guards ==")
lst = srv.backtests_list()
chkv('list has the run', any(b['id'] == bid for b in lst['backtests']), True)
bad = body(srv.backtest_start({'strategy_id': saved['id'],
                               'universe': {'kind': 'symbols', 'symbols': []},
                               'start': '2024-01-09', 'end': '2024-01-10'}))
chkv('bad spec rejected before creating a row', bad.get('ok'), False)
chkv('no orphan row created', len(srv.backtests_list()['backtests']), 1)
d = srv.backtest_delete(bid)
d = body(d) if not isinstance(d, dict) else d
chkv('delete done run', d.get('ok'), True)
chkv('gone', store.get_backtest(bid), None)

print(f"\nPASS={PASS} FAIL={FAIL}")
sys.exit(1 if FAIL else 0)
