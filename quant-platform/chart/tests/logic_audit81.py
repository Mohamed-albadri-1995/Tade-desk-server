"""What was backtested, against what trades now.

Reported as: "even in backtesting they state something but what really
backtested is different." A run keeps a frozen copy of the strategy it ran;
the strategy keeps being edited. This checks that the desk can be told —
exactly, rule by rule — when the two have drifted apart, and that "the run
kept no copy" is reported as unknown rather than as unchanged.
"""
import pathlib
import sys
import tempfile

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2]))
import chart.store as store                                         # noqa: E402

store._DB = pathlib.Path(tempfile.mkdtemp()) / 'parity.db'
store._conn = None

from chart import parity                                            # noqa: E402

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


ENTRY = {'logic': 'AND', 'rules': [
    {'left': {'kind': 'price', 'field': 'close'}, 'op': 'cross_above',
     'right': {'kind': 'const', 'value': 10.5}}]}
base = {'name': 'OR 935', 'side': 'long', 'entry': ENTRY,
        'risk': {'sl': {'type': 'pct', 'value': 0.6},
                 'targets': [{'fraction': 0.5, 'r_multiple': 2.0}],
                 'window_start': 935, 'window_end': 935}}
sid = store.save_strategy(dict(base))['id']
other = store.save_strategy(dict(base, name='unrelated'))['id']


def run(spec, status='done'):
    bid = store.create_backtest('bt', spec)
    store.update_backtest(bid, status=status, progress=1.0, summary={'trades': 3})
    return bid


frozen = dict(store.get_strategy(sid))
frozen.pop('exit_protocol', None)

print('\n── 1 · no run yet ────────────────────────────────────────────')
r = parity.report([sid])
ok('no run: says so, not "matches"', r['backtest'] is None and r['note'], r)

print('\n── 2 · the newest DONE run of THIS strategy is the one used ──')
old = run({'strategy_id': sid, 'fill': 'close', '_strategy_docs': [frozen]})
new = run({'strategy_ids': [sid], 'fill': 'desk', '_strategy_docs': [frozen]})
run({'strategy_id': other, 'fill': 'close'})                  # someone else's
run({'strategy_id': sid, 'fill': 'close'}, status='error')    # never finished
r = parity.report([sid])
ok('picks the newest finished run of this strategy', r['backtest']['id'] == new,
   r['backtest'] and r['backtest']['id'])
ok('the spec travels, without the frozen copy',
   r['backtest']['spec'].get('fill') == 'desk'
   and '_strategy_docs' not in r['backtest']['spec'])
ok('unchanged strategy: frozen and nothing changed',
   r['rules'][0]['frozen'] and r['rules'][0]['changed'] == [], r['rules'])

print('\n── 3 · the strategy is edited after the run ──────────────────')
edited = store.get_strategy(sid)
edited['risk'] = dict(edited['risk'], sl={'type': 'pct', 'value': 1.0})
edited['exit'] = {'logic': 'AND', 'scope': 'runner', 'rules': []}
edited.pop('exit_protocol', None)
store.save_strategy(edited, user_edit=True)
r = parity.report([sid])
paths = {c['path']: c for c in r['rules'][0]['changed']}
ok('the stop change is named, with both values',
   'risk.sl.value' in paths and paths['risk.sl.value']['then'] == '0.6'
   and paths['risk.sl.value']['now'] == '1.0', paths)
ok('the new exit rule is named', 'exit' in paths, list(paths))
ok('bookkeeping (updated_at, exit_protocol) is not a change',
   not any(p.startswith(('updated_at', 'exit_protocol', 'stage', 'tools',
                         '_user_edited'))
           for p in paths), list(paths))

print('\n── 4 · a run too old to carry a copy ─────────────────────────')
run({'strategy_id': sid, 'fill': 'desk'})
r = parity.report([sid])
ok('no copy → frozen False, never "unchanged"',
   r['rules'][0]['frozen'] is False and r['rules'][0]['note'], r['rules'])

print('\n── 5 · a pair: either book finds the run ─────────────────────')
ok('the other id alone does not find this strategy\'s run',
   parity.latest_for([other])['spec'].get('strategy_id') == other)
ok('bad ids are ignored, not fatal', parity.latest_for(['x', None]) is None)

print(f'\n{PASS} passed, {FAIL} failed')
sys.exit(1 if FAIL else 0)
