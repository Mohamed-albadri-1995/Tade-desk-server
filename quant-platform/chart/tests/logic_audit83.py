"""tools/audit_0935.py reads a stored run correctly — checked by hand.

The script is what you run on the box to see what your real 09:35 backtests
did. So it is tested here against stored runs whose every number is worked
out by hand below, including one trade that breaks the runner rule and one
stored return that does not add up — both must be caught.
"""
import pathlib
import sys
import tempfile

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2]))
import chart.store as store                                         # noqa: E402

store._DB = pathlib.Path(tempfile.mkdtemp()) / 'a0935.db'
store._conn = None
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2] / 'tools'))
import audit_0935 as A                                              # noqa: E402

PASS = 0
FAIL = 0


def ok(name, cond, extra=''):
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f'  ok   {name}')
    else:
        FAIL += 1
        print(f'  FAIL {name}   {extra}')


LONG = {'name': 'OR + VWAP 09:35 (Long)', 'side': 'long',
        'entry': {'logic': 'AND', 'rules': []},
        'exit': {'logic': 'AND', 'scope': 'runner', 'rules': [{'op': 'cross_below'}]},
        'risk': {'sl': {'type': 'prim', 'freeze': True}, 'min_target_usd': 0.1,
                 'targets': [{'fraction': 0.5, 'r_multiple': 2.0}]}}
SHORT = dict(LONG, name='OR + VWAP 09:35 (Short)', side='short')
lid = store.save_strategy(dict(LONG))['id']
sid = store.save_strategy(dict(SHORT))['id']
docs = [dict(store.get_strategy(lid)), dict(store.get_strategy(sid))]
for d in docs:
    d.pop('exit_protocol', None)


def leg(px):
    return [{'exit_ts': 2, 'price': px, 'fraction': 0.5, 'ret': 0, 'reason': 'T1'}]


def row(sym, side, entry, exit_, ret, reason, legs=None, name=None):
    return {'date': '2026-09-01', 'symbol': sym, 'side': side, 'entry_ts': 1,
            'exit_ts': 3, 'entry': entry, 'exit': exit_, 'ret': ret, 'reason': reason,
            'legs': legs or [],
            'ctx': {'strategy': name or (LONG if side == 'long' else SHORT)['name']}}


# Worked by hand, cost 0:
#   A long 10 → half at 10.40 (+4%), rest out on the rule at 10.20 (+2%)  = +3.00%
#   B long 10 → stopped at 9.80 before the target                          = −2.00%
#   C short 20 → half at 19.20 (+4%), rest stopped at 19.90 (+0.5%)        = +2.25%
#   D long 10 → out on the RULE at 10.10 with NO target banked  ← the fault
#   E long 10 → eod at 10.50, stored as +9% though it is +5%    ← bad sum
bid = store.create_backtest('hand', {'strategy_ids': [lid, sid], 'fill': 'desk',
                                     'start': '2026-01-02', 'end': '2026-09-01',
                                     'cost_bps': 0, '_strategy_docs': docs})
store.add_bt_trades(bid, [
    row('AAA', 'long', 10.0, 10.20, 0.03, 'exit', leg(10.40)),
    row('BBB', 'long', 10.0, 9.80, -0.02, 'SL'),
    row('CCC', 'short', 20.0, 19.90, 0.0225, 'SL', leg(19.20)),
    row('DDD', 'long', 10.0, 10.10, 0.01, 'exit'),
    row('EEE', 'long', 10.0, 10.50, 0.09, 'eod'),
    row('ZZZ', 'long', 10.0, 11.0, 0.10, 'exit', name='some other strategy'),
])
store.update_backtest(bid, status='done', progress=1.0, summary={})

a = A.audit(bid, '09:35')
c = a['counts']
print('\n── a hand-checked run ─────────────────────────────────────────')
print(A.render(a))
ok('only this strategy\'s trades are counted (ZZZ is not)', c['trades'] == 5, c)
ok('two trades banked the target half', c['banked'] == 2, c)
ok('...one then left on the rule, one on its stop',
   c['banked_then_rule'] == 1 and c['banked_then_stop'] == 1, c)
ok('one stopped before the target', c['stop_before_target'] == 1, c)
ok('THE FAULT: the rule exit with no target is caught and named',
   c['rule_without_target'] == 1 and a['bad_rule'][0][1] == 'DDD', a['bad_rule'])
ok('THE BAD SUM: EEE is caught, and only EEE',
   [b[1] for b in a['bad_ret']] == ['EEE'], a['bad_ret'])
m = a['money']
ok('target halves = 0.5×4% + 0.5×4% = +4.00%', abs(m['target halves'] - 0.04) < 1e-9, m)
ok('runners after target = 0.5×2% + 0.5×0.5% = +1.25%',
   abs(m['runners after target'] - 0.0125) < 1e-9, m)
ok('stopped before target = −2.00%', abs(m['stopped before target'] + 0.02) < 1e-9, m)
ok('the frozen copy is described: half at 2R, exit applies to the runner',
   a['ran'][0]['targets'] == ['0.5 at 2.0R'] and a['ran'][0]['exit_scope'] == 'runner',
   a['ran'])
ok('unchanged since the run', all(r['frozen'] and not r['changed'] for r in a['changed']),
   a['changed'])

print('\n── costs, and an edit after the run ───────────────────────────')
bid2 = store.create_backtest('cost', {'strategy_ids': [lid], 'fill': 'desk',
                                      'cost_bps': 10, '_strategy_docs': docs[:1]})
# +3.00% gross, less 2 × 10 bps = +2.80%
store.add_bt_trades(bid2, [row('AAA', 'long', 10.0, 10.20, 0.028, 'exit', leg(10.40))])
store.update_backtest(bid2, status='done', progress=1.0, summary={})
edited = store.get_strategy(lid)
edited['exit'] = dict(edited['exit'], scope=None)
edited.pop('exit_protocol', None)
store.save_strategy(edited)
a2 = A.audit(bid2, '09:35')
ok('costs are taken off before the sum is compared', not a2['bad_ret'], a2['bad_ret'])
ok('the edit since the run is listed: exit.scope runner → null',
   any(ch['path'] == 'exit.scope' for r in a2['changed'] for ch in r['changed']),
   a2['changed'])
ok('runs_for finds both runs, newest first', A.runs_for('09:35') == [bid2, bid],
   A.runs_for('09:35'))

print(f'\n{PASS} passed, {FAIL} failed')
sys.exit(1 if FAIL else 0)
