"""A backtest you started can be found again, watched, and stopped.

Reported 2026-09-24: "I ran a backtest, the page closed, I could not see the
old backtest, it never finished even after an hour, and I cannot see its
progress or stop it or start a new one."

Three faults, each run here:
  1. A run killed by a qp restart stayed 'running' forever — progress frozen,
     and nothing would ever say it was dead.
  2. There was no stop at all.
  3. The page could only follow the run it had just started (the list the
     page reads now says which 'running' rows are alive in THIS process).
"""
import pathlib
import sys
import tempfile

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2]))
import chart.store as store                                         # noqa: E402

store._DB = pathlib.Path(tempfile.mkdtemp()) / 'bt84.db'
store._conn = None

from chart import backtest as B                                     # noqa: E402

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


print('\n── 1 · a run the last qp left running ────────────────────────')
dead = store.create_backtest('left running', {'a': 1})
store.update_backtest(dead, status='running', progress=0.37)
done = store.create_backtest('finished', {'a': 1})
store.update_backtest(done, status='done', progress=1.0, summary={'trades': 4})
n = store.mark_interrupted()
g = store.get_backtest(dead, with_trades=False)
ok('it is marked, and counted', n == 1 and g['status'] == 'error', (n, g['status']))
ok('...with a reason you can act on', 'interrupted' in (g['error'] or ''), g['error'])
ok('a finished run is untouched',
   store.get_backtest(done, with_trades=False)['status'] == 'done')

print('\n── 2 · stop, even through the per-symbol error handling ──────')
seen = {'pairs': 0}


def fake_run(spec, progress_cb=None):
    """Shaped like run(): every symbol in its own try/except Exception."""
    for i in range(1000):
        try:
            seen['pairs'] += 1
            if i == 5:
                B.request_stop(spec['_bt'])
            progress_cb((i + 1) / 1000)
        except Exception:                      # noqa: BLE001 — one bad symbol
            continue
    return {'trades': [], 'summary': {'trades': 0}}


real_run = B.run
B.run = fake_run
try:
    bid = store.create_backtest('to stop', {})
    store.update_backtest(bid, status='running')
    B.run_and_store(bid, {'_bt': bid})
finally:
    B.run = real_run
g = store.get_backtest(bid, with_trades=False)
ok('it stops at the next symbol, not after all 1000', seen['pairs'] == 6, seen)
ok("its status says 'stopped', and at how far", g['status'] == 'stopped'
   and 'stopped by you' in (g['error'] or ''), (g['status'], g['error']))
ok('the stop request is cleared for the next run', bid not in B._STOP, B._STOP)

print('\n── 3 · the endpoints the page reads ──────────────────────────')
# Called as functions — the routes are plain functions, and a test client
# is not installed on every machine this suite runs on.
import chart.server as S                                            # noqa: E402
orphan = store.create_backtest('orphan', {})
store.update_backtest(orphan, status='running', progress=0.5)
j = S.backtests_list(brief=1)
row = next(r for r in j['backtests'] if r['id'] == orphan)
ok("a 'running' row no process is working on says so (live false)",
   row['live'] is False, row)
drow = next(r for r in j['backtests'] if r['id'] == done)
ok('brief keeps the headline numbers only', drow['summary'] == {'trades': 4}, drow)
S._BT_RUNNING['id'] = orphan
ok('the run this process IS running reads live',
   next(r for r in S.backtests_list(brief=1)['backtests'] if r['id'] == orphan)['live'])
j = S.backtest_stop(orphan)
ok('stopping the live run asks it to stop at its next symbol',
   j == {'ok': True, 'status': 'stopping'} and orphan in B._STOP, j)
B._STOP.discard(orphan)
S._BT_RUNNING['id'] = None
j = S.backtest_stop(orphan)
ok('stopping an orphan marks it at once',
   j['ok'] and store.get_backtest(orphan, with_trades=False)['status'] == 'error', j)
j = S.backtest_stop(99999)
ok('an unknown run is refused by name', j['ok'] is False and '99999' in j['error'], j)

print(f'\n{PASS} passed, {FAIL} failed')
sys.exit(1 if FAIL else 0)
