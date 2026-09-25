"""The live decision closes yesterday at 15:50 and ignores premarket, as the desk does.

Found 2026-09-25, auditing the live decision. chart/decide.py asked the engine
about the last two days WITHOUT the session rules. The engine holds one
position at a time, so:

  1. a trade from yesterday that reached neither its stop nor its target was
     still OPEN in the decision's replay this morning, and today's signal on
     that name never fired. The desk had closed it at 15:50 (the flattener),
     and the backtest — prop-firm rules on by default — closed it too and took
     today's trade;
  2. a strategy without an entry window could open a position on a PREMARKET
     bar in the decision's replay, and the 09:40 signal it should have taken
     was blocked the same way.

Both run decide.evaluate_symbol exactly as the live desk does, at the decision
minute, on bars cut at that minute, against the backtest of the same bars.

And, found with them: every pick names the bar it was DECIDED on
(`decided_at`), which the order records and the manager starts the engine
from — and today's newest bar is not "the day's last bar" until the session
reaches 15:50 (the engine liquidated on it and refused a next-open entry).
"""
import pathlib
import sys

import numpy as np
import pandas as pd

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2]))
import chart.decide as D                                             # noqa: E402
import chart.strategy as S                                           # noqa: E402
import tools.compare_server as cs                                    # noqa: E402

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


ET = 'America/New_York'
TODAY = '2026-09-16'
RULES = {'rth_entries': True, 'eod_close': True}


def frame(greens, premarket=False):
    """Flat 100.00 bars; a green bar (close 100.50) at each (date, minute of
    session) in `greens`. Premarket 08:00-09:29 today when asked."""
    idx, c = [], []
    for d in ('2026-09-15', TODAY):
        start = 8 * 60 if (premarket and d == TODAY) else 9 * 60 + 30
        for m in range(start, 16 * 60):
            idx.append(pd.Timestamp(d, tz=ET) + pd.Timedelta(minutes=m))
            c.append(100.5 if (d, m) in greens else 100.0)
    c = np.array(c)
    o = np.full(len(c), 100.0)
    return pd.DataFrame({'open': o, 'high': np.maximum(o, c) + .01, 'low': np.minimum(o, c) - .01,
                         'close': c, 'volume': 1e4},
                        index=pd.DatetimeIndex(idx).tz_convert('UTC'))


def serve(df):
    ts = [int(x.value // 10**9) for x in df.index]
    cs.prepare_bars = lambda *a, **k: (df, ts, {'end': df.index[-1]})


def strategy(**risk):
    return {'name': 'green bar', 'side': 'long',
            'entry': {'logic': 'AND', 'rules': [{'left': {'kind': 'price', 'field': 'close'},
                                                 'op': 'gt',
                                                 'right': {'kind': 'price', 'field': 'open'}}]},
            'exit': {'logic': 'AND', 'rules': []},
            'risk': dict({'sl': {'type': 'pct', 'value': 5}}, **risk)}


def backtest_today(st, df):
    serve(df)
    r = S.evaluate(st, 'X', '1m', 2, feed='yahoo', view='all', fill='desk', rules=RULES)
    rows = [t['entry_ts'] for t in r.get('trades') or []]
    if r.get('open_trade'):
        rows.append(r['open_trade']['time'])
    out = []
    for ets in rows:
        dec = pd.Timestamp(ets - 60, unit='s', tz='UTC').tz_convert(ET)
        if dec.date().isoformat() == TODAY:
            out.append(dec.strftime('%H:%M'))
    return out


def live_at(st, df, hhmm):
    et = df.index.tz_convert(ET)
    m = [i for i in range(len(df)) if et[i].strftime('%Y-%m-%d %H:%M') == f'{TODAY} {hhmm}'][0]
    serve(df.iloc[:m + 1])
    return [r['entry_at'] for r in D.evaluate_symbol([st], 'X', TODAY, '1m', 'yahoo', days=2,
                                                      fill='live', view='all')
            if r.get('entry_at') == hhmm]


real = cs.prepare_bars
try:
    print('== 1. yesterday\'s trade never hit its stop or target ==')
    st = strategy(window_start=930, window_end=1130)
    df = frame({('2026-09-15', 9 * 60 + 30), (TODAY, 9 * 60 + 40)})
    ok('the backtest closes it at 15:50 and takes today\'s 09:40 signal',
       backtest_today(st, df) == ['09:40'], backtest_today(st, df))
    ok('the live decision at 09:40 takes it too', live_at(st, df, '09:40') == ['09:40'],
       live_at(st, df, '09:40'))

    print('== 2. a strategy with no entry window and a premarket green bar ==')
    st = strategy()
    df = frame({(TODAY, 9 * 60), (TODAY, 9 * 60 + 40)}, premarket=True)
    ok('the backtest ignores the 09:00 bar and takes 09:40',
       backtest_today(st, df) == ['09:40'], backtest_today(st, df))
    ok('the live decision at 09:40 takes it too', live_at(st, df, '09:40') == ['09:40'],
       live_at(st, df, '09:40'))

    print('== 3. the rules the decision uses are the desk\'s ==')
    ok('entries 09:30-15:50 and everything closed by 15:50',
       D.DESK_RULES == {'rth_entries': True, 'eod_close': True}, D.DESK_RULES)
    print('== 4. every pick names the bar it was decided on ==')
    st = strategy(window_start=930, window_end=1130)
    df = frame({(TODAY, 9 * 60 + 40)})
    et = df.index.tz_convert(ET)
    m = [i for i in range(len(df)) if et[i].strftime('%Y-%m-%d %H:%M') == f'{TODAY} 09:40'][0]
    serve(df.iloc[:m + 1])
    rows = [r for r in D.evaluate_symbol([st], 'X', TODAY, '1m', 'yahoo', days=2,
                                         fill='live', view='all') if r.get('entry_at')]
    ok('live fill: decided on 09:40, the bar it entered at', rows and rows[0].get('decided_at') == '09:40',
       rows)
    serve(df.iloc[:m + 2])
    rows = [r for r in D.evaluate_symbol([st], 'X', TODAY, '1m', 'yahoo', days=2,
                                         fill='desk', view='all') if r.get('entry_at')]
    ok('desk fill: entered 09:41, decided on 09:40', rows and rows[0].get('entry_at') == '09:41'
       and rows[0].get('decided_at') == '09:40', rows)
finally:
    cs.prepare_bars = real

print(f'PASS={PASS} FAIL={FAIL}')
sys.exit(1 if FAIL else 0)
