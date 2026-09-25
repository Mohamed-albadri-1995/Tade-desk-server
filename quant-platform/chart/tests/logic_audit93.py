"""The live manager, replayed minute by minute, closes where the backtest did.

Asked 2026-09-25: "carefully inspect live decision and manager". The desk
asks chart/manage.py about each open position once a minute, on bars that end
at the bar just closed, with the setup's fill ('live') and the bar the
decision was taken on. The backtest books the same trade with fill='desk'.

For every backtest trade on seeded random days, the manager is asked at every
minute after the entry. The first minute it says close_now must be the minute
the backtest acted on, for the same reason:

  - a stop, a trailing stop or a target: the bar the backtest touched it;
  - the exit RULE: the bar it fired on (the desk fill books it at the next
    open, which is when the manager's close reaches the tape).

Trades closed by the 15:50 rule are the flattener's, not the manager's, and
are left out. A last check proves the harness sees a difference: a manager
reading a stop 0.3 bands out instead of 0.2 must disagree somewhere.
"""
import copy
import pathlib
import sys

import numpy as np
import pandas as pd

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2]))
import chart.manage as M                                             # noqa: E402
import chart.strategy as S                                           # noqa: E402
import tools.compare_server as cs                                    # noqa: E402
from chart.tests._replay_days import (ET, DAY, RULES, TEST, ORV,     # noqa: E402
                                      day_frame, serve, hhmm)

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


def T(s):
    return pd.Timestamp(s, unit='s', tz='UTC').tz_convert(ET)


def trades(st, df):
    serve(df)
    r = S.evaluate(st, 'X', '1m', 2, feed='yahoo', view='all', fill='desk', rules=RULES)
    assert r.get('ok'), r.get('error')
    return [t for t in r.get('trades') or []
            if T(t['entry_ts']).date().isoformat() == DAY and t.get('reason') != 'eod']


def first_close(st, managed_as, df, t):
    """Ask the manager every minute after the decision; the first close_now."""
    et = df.index.tz_convert(ET)
    dec = T(t['entry_ts'] - 60)
    m0 = int(np.nonzero(np.asarray(et == dec))[0][0])
    for m in range(m0 + 1, len(df)):
        serve(df.iloc[:m + 1])
        a = M.manage(managed_as, 'X', st['side'], t['entry'], f'{DAY} {hhmm(dec)}',
                     days=2, view='all', asof=DAY, stop_at_entry=t['stop'], fill='live')
        if not a.get('ok'):
            return ('error', a.get('error'))
        if a['close_now']:
            return (hhmm(et[m]), a['close_reason'])
    return (None, None)


def wanted(t):
    xs = T(t['exit_ts'])
    if t.get('reason') == 'exit':
        xs -= pd.Timedelta(minutes=1)
    return (hhmm(xs), t.get('reason'))


rng = np.random.default_rng(11)
frames = [day_frame(rng) for _ in range(24)]
real = cs.prepare_bars
try:
    reasons = {}
    for name, strats in (('OR + VWAP 09:35', ORV), ('Test', [TEST])):
        print(f'== {name}: every trade on 24 days, the manager asked every minute ==')
        n, bad = 0, []
        for i, df in enumerate(frames):
            for st in strats:
                for t in trades(st, df):
                    n += 1
                    reasons[t.get('reason')] = reasons.get(t.get('reason'), 0) + 1
                    got, want = first_close(st, st, df, t), wanted(t)
                    if got != want:
                        bad.append((i, st['side'], hhmm(T(t['entry_ts'])), 'want', want, 'got', got))
        ok(f'{name}: the manager closes on the backtest\'s bar, for its reason', not bad, bad[:3])
        ok(f'{name}: trades to compare', n >= 5, n)
    ok('stops, rule exits and trailing stops were all exercised',
       all(reasons.get(k) for k in ('SL', 'exit', 'trail')), reasons)

    print('== the replay can see a difference ==')
    wider = copy.deepcopy(TEST)
    wider['risk']['sl']['anchor']['params']['mult'] = 0.3
    off = 0
    for df in frames:
        for t in trades(TEST, df):
            off += first_close(TEST, wider, df, t) != wanted(t)
    ok('a manager reading a different stop disagrees', off > 0, off)
finally:
    cs.prepare_bars = real

print(f'PASS={PASS} FAIL={FAIL}')
sys.exit(1 if FAIL else 0)
