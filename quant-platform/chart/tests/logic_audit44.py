"""Audit part 44 — the 'live' fill model takes the BACKTEST'S decision, live.

THE PROBLEM IT SOLVES.

The 09:35 setup decides on the 09:34 close and enters at the 09:35 open. Its
entry window is 935..935, and that window pins the FILL bar — so a backtest of
it runs 'next_open' or 'desk', both of which read the 09:34 bar.

Neither can be run at 09:35:00 in real time:

  'next_open' and 'desk' report the entry as opn[j+1]. At 09:35:00 that bar has
  not printed, so the signal is dropped as 'last_bar' and the desk sees nothing.

  'close' passes the window only on the 09:35 bar — a minute later, on a
  different bar's close, VWAP and ATR. A different SIGNAL, not a different
  price. That is what the desk was actually doing, and it is why two weeks of
  live trading did not match the backtest that justified it.

'live' is 'desk' with the future removed: every level from close[j], the window
checked against the minute the fill is INTENDED for (computed from the clock),
and no requirement that the next bar exist.

PART A — the model is registered and validated like the others.
PART B — THE PROPERTY: 'live' and 'desk' fire on the SAME BAR with the SAME
         stop, target and rank number. Only the reported entry differs.
PART C — 'live' still fires when the signal bar is the LAST bar. This is the
         whole point; 'next_open' cannot.
PART D — 'live' does NOT fire on the bar 'close' would have used.
PART E — the window shift follows the TIMEFRAME, not a hardcoded minute.
"""
import pathlib
import sys

import numpy as np
import pandas as pd

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2]))

import chart.strategy as S                                     # noqa: E402

PASS = 0
FAIL = 0


def ok(name, cond, extra=''):
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f'  ok   {name}')
    else:
        FAIL += 1
        print(f'  FAIL {name} {extra}')


ET = 'America/New_York'
DAY = '2026-08-19'


def frame(closes, day=DAY, start='09:30', freq='1min'):
    """Bars whose close is the number given; open = the previous close, so the
    'next open' and the 'decision close' are DIFFERENT prices and the two can
    be told apart in the result."""
    idx = pd.date_range(f'{day} {start}', periods=len(closes), freq=freq, tz=ET)
    c = np.asarray(closes, dtype=float)
    o = np.concatenate([[c[0]], c[:-1]])
    return pd.DataFrame({'open': o, 'high': np.maximum(o, c) + 0.5,
                         'low': np.minimum(o, c) - 0.5, 'close': c,
                         'volume': np.full(len(c), 1e5)},
                        index=idx.tz_convert('UTC'))


# A strategy that is TRUE on every bar, with a one-minute entry window at 09:35
# and a fixed 1% stop. What fires, and where its stop sits, is then decided
# entirely by the fill model — which is the thing under test.
def strat(window=935):
    return {'name': f'always @{window}', 'side': 'long',
            'entry': {'logic': 'AND',
                      'rules': [{'left': {'kind': 'price', 'field': 'close'},
                                 'op': 'gt', 'right': {'kind': 'const', 'value': 0}}]},
            'exit': {'logic': 'AND', 'rules': []},
            'risk': {'window_start': window, 'window_end': window,
                     'sl': {'type': 'pct', 'value': 1.0}}}


def run(bars, fill, window=935):
    """_pair_trades directly — no feed, no fetch, so the only variable is fill."""
    st = strat(window)
    ts = (bars.index.astype('int64') // 10**9).to_numpy()
    n = len(bars)
    mask = np.ones(n, dtype=bool)
    return S._pair_trades(
        bars, ts, mask, np.zeros(n, dtype=bool), 'long', st['risk'], {},
        fill=fill, win_start=window, win_end=window, entry_mode='edge')


print('== A. the model is registered, and a typo is an error ==')
ok("'live' is a known fill model", 'live' in S.FILL_MODELS, S.FILL_MODELS)
ok('the other three are untouched',
   set(S.FILL_MODELS) == {'close', 'next_open', 'desk', 'live'}, S.FILL_MODELS)
try:
    run(frame([10.0] * 10), 'lvie')
    ok('an unknown model raises rather than falling back', False, 'no error')
except ValueError as e:
    ok('an unknown model raises rather than falling back', True)
    ok('...and the message lists the real ones', 'live' in str(e), str(e)[:90])


print()
print('== B. THE PROPERTY: live and desk decide identically ==')
# 09:30 … 09:39. The 09:34 close is 10.40 and the 09:35 OPEN is that same
# 10.40, so a naive comparison could not tell the models apart — the 09:35
# close of 11.90 is what separates 'close' from the other two.
CLOSES = [10.00, 10.10, 10.20, 10.30, 10.40, 11.90, 12.00, 12.10, 12.20, 12.30]
bars = frame(CLOSES)

t_desk, _, _, _ = run(bars, 'desk')
t_live, _, _, _ = run(bars, 'live')
t_close, _, _, _ = run(bars, 'close')

ok('desk takes exactly one trade', len(t_desk) == 1, len(t_desk))
ok('live takes exactly one trade', len(t_live) == 1, len(t_live))

d, l = t_desk[0], t_live[0]
# ei is the ENTRY bar and differs by design (desk books the fill on 09:35).
# si is the SIGNAL bar — the decision — and must not differ at all.
ok('SAME signal bar: both decided on 09:34',
   d['si'] == l['si'] == 4, (d['si'], l['si']))
ok('...which is 09:34 on the clock',
   str(bars.index[d['si']].tz_convert(ET).strftime('%H:%M')) == '09:34')
ok('SAME decision price (the 09:34 close)',
   d['signal_px'] == l['signal_px'] == 10.40, (d['signal_px'], l['signal_px']))
ok('SAME price the levels were measured from',
   d['decided'] == l['decided'] == 10.40, (d['decided'], l['decided']))
ok('SAME stop, so the same risk and the same rank number',
   abs(d['stop'] - l['stop']) < 1e-9, (d['stop'], l['stop']))
# 1% below the 09:34 close.
ok('...and that stop is 10.296', abs(l['stop'] - 10.296) < 1e-9, l['stop'])

# The ONE thing that differs, and why.
ok('desk books the entry at the 09:35 OPEN', d['entry'] == 10.40, d['entry'])
ok('live reports the DECISION price as the entry — the fill is not yet knowable',
   l['entry'] == 10.40, l['entry'])
ok('live enters on the signal bar itself (no future bar to book against)',
   l['ei'] == l['si'], (l['ei'], l['si']))
ok('desk enters one bar later', d['ei'] == d['si'] + 1, (d['ei'], d['si']))


print()
print("== C. 'live' fires when the signal bar is the LAST bar ==")
# 09:30 … 09:34 and nothing after: exactly what the desk holds at 09:35:00.
last = frame(CLOSES[:5])
t_live_last, _, _, ot_live = run(last, 'live')
# It arrives as an OPEN trade, which is the only shape a fresh signal has: the
# entry has fired and nothing has closed it yet. decide.py reads exactly this
# — reading the closed list alone would lose every live pick.
ok('live still takes the trade', len(t_live_last) == 0 and ot_live is not None,
   (len(t_live_last), ot_live))
ok('...on the 09:34 bar', ot_live is not None and ot_live['si'] == 4,
   ot_live and ot_live.get('si'))
ok('...carrying the decision price the rank needs',
   ot_live is not None and ot_live['signal_px'] == 10.40,
   ot_live and ot_live.get('signal_px'))
ok('...and the stop the order will be sent with',
   ot_live is not None and abs(ot_live['stop'] - 10.296) < 1e-9,
   ot_live and ot_live.get('stop'))

diag = {}
S._pair_trades(last, (last.index.astype('int64') // 10**9).to_numpy(),
               np.ones(5, dtype=bool), np.zeros(5, dtype=bool), 'long',
               strat()['risk'], {}, fill='next_open',
               win_start=935, win_end=935, entry_mode='edge', diag=diag)
# THE REASON 'live' EXISTS, stated as a test: at 09:35:00 the backtest's own
# model sees nothing at all.
ok("'next_open' sees NOTHING on the same data", diag.get('last_bar', 0) >= 1, diag)


print()
print("== D. 'live' is not just 'close' with a new name ==")
# 'close' passes the window on the 09:35 bar and books its close (11.90).
ok('close fires a bar LATER', t_close and t_close[0]['si'] == 5, t_close[0]['si'])
ok("...at that bar's close, a price no order can reach",
   t_close[0]['entry'] == 11.90, t_close[0]['entry'])
ok('so close and live decide on DIFFERENT bars',
   t_close[0]['si'] != t_live[0]['si'])
# And the consequence, in the number that ranks the day's candidates.
ok('...and rank on prices 14% apart',
   abs(t_close[0]['signal_px'] / t_live[0]['signal_px'] - 1) > 0.14,
   (t_close[0]['signal_px'], t_live[0]['signal_px']))


print()
print('== E. the window shift follows the TIMEFRAME ==')
# On 5-minute bars the fill lands five minutes on, not one. A hardcoded minute
# would silently never fire a 5m clock setup.
b5 = frame([10.0, 10.1, 10.2, 10.3, 10.4], start='09:30', freq='5min')
# bars at 09:30, 09:35, 09:40, 09:45, 09:50 — a 09:35 window means the signal
# bar is 09:30, whose fill lands on 09:35.
t5, _, _, _ = run(b5, 'live', window=935)
ok('a 5m live signal decides on the 09:30 bar', len(t5) == 1 and t5[0]['si'] == 0,
   [(t['si']) for t in t5])
t5d, _, _, _ = run(b5, 'desk', window=935)
ok('...the same bar desk decides on', len(t5d) == 1 and t5d[0]['si'] == 0,
   [(t['si']) for t in t5d])


print()
print(f'        {PASS} passed, {FAIL} failed')
sys.exit(1 if FAIL else 0)
