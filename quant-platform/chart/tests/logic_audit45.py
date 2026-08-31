"""Audit part 45 — the live/backtest alignment holds for EVERY strategy shape.

WHY THIS IS SEPARATE FROM PART 44.

Part 44 proves the 'live' fill model on one setup: a one-minute window at
09:35, on 1-minute bars. That is the setup the whole investigation started
from, and a fix that only worked there would be a patch rather than a
platform.

The platform has to hold for the shapes that actually exist in chart/seeds:

    Test                   09:30 - 11:30     a two-hour WATCH window
    OR + VWAP 09:35        09:35 - 09:35     a one-minute CLOCK window
    T2 10:00               10:00 - 10:00     the same, later in the day
    PML breakout           09:40 - 10:10     a watch window mid-morning
    HitchHiker / PM Break  09:30 - ...       a window opening ON the bell
    RubberBand & co        10:00 - 13:30     long watch windows
    PM Breakout (2m)                         and not on 1-minute bars

Two of those shapes break a naive fix, and both are pinned here.

PART A — A WINDOW OPENING AT 09:30. Its decision bar is 09:29, which is
         PRE-MARKET. The session gate asks "may an entry open here?" and the
         honest answer is about the FILL (09:30, inside the session), not about
         the signal bar. Answered wrongly, every 09:30 setup silently never
         fires live while its backtest traded it.
PART B — A WATCH WINDOW. Every bar in it must stay reachable; the shift must
         move BOTH ends and lose no bar at either.
PART C — TIMEFRAME. The shift is one BAR. A 2-minute setup moves two minutes.
PART D — THE END OF THE DAY. A signal whose fill would land at or after the
         liquidation cutoff must not open, and that is also a question about
         the fill rather than about the signal bar.
PART E — the same universal property as part 44, across all of these: 'live'
         and 'desk' decide on the SAME bar with the SAME levels.
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
RULES = {'rth_entries': True, 'eod_close': True}


def frame(start, periods, freq='1min', day=DAY, base=10.0):
    """Bars from `start`, rising a cent a bar so open != close everywhere."""
    idx = pd.date_range(f'{day} {start}', periods=periods, freq=freq, tz=ET)
    c = base + np.arange(periods) * 0.01
    o = np.concatenate([[c[0]], c[:-1]])
    return pd.DataFrame({'open': o, 'high': np.maximum(o, c) + 0.05,
                         'low': np.minimum(o, c) - 0.05, 'close': c,
                         'volume': np.full(periods, 1e5)},
                        index=idx.tz_convert('UTC'))


ALWAYS = {'logic': 'AND',
          'rules': [{'left': {'kind': 'price', 'field': 'close'},
                     'op': 'gt', 'right': {'kind': 'const', 'value': 0}}]}


def evaluate(bars, fill, win_start, win_end, rules=RULES, max_per_day=None):
    """Through the same path evaluate() uses, so the session gates are real."""
    risk = {'window_start': win_start, 'window_end': win_end,
            'sl': {'type': 'pct', 'value': 1.0}}
    ts = (bars.index.astype('int64') // 10**9).to_numpy()
    n = len(bars)
    entry_ok, eod_close = S._session_masks(bars, rules)
    step = (bars.index[1] - bars.index[0]) if n > 1 else pd.Timedelta(minutes=1)
    eok_f, noopen_f = (S._fill_gates(bars, rules, step) if fill == 'live'
                       else (None, None))
    diag = {}
    trades, _, _, ot = S._pair_trades(
        bars, ts, np.ones(n, dtype=bool), np.zeros(n, dtype=bool), 'long',
        risk, {}, fill=fill, entry_ok=entry_ok, eod_close=eod_close,
        win_start=win_start, win_end=win_end, entry_mode='edge',
        max_per_day=max_per_day, diag=diag,
        entry_ok_fill=eok_f, no_open_fill=noopen_f)
    return trades, ot, diag


def et_of(bars, i):
    return bars.index[i].tz_convert(ET).strftime('%H:%M')


print('== A. a window that opens ON the bell (09:30) ==')
# The `Test` strategy is 09:30-11:30 and PM Breakout / HitchHiker open at 09:30
# too. Under every next-open model the decision bar is 09:29 — PRE-MARKET.
#
# The session gate is about the FILL. Read against the SIGNAL bar it says
# "09:29 is not RTH, refuse", and the setup loses the one entry its backtest
# would have taken at the 09:30 open.
pre = frame('09:20', 25)                       # 09:20 .. 09:44, spanning the bell
t_live, ot_live, d_live = evaluate(pre, 'live', 930, 930)
t_desk, ot_desk, d_desk = evaluate(pre, 'desk', 930, 930)

first = (t_live[0] if t_live else ot_live)
firstd = (t_desk[0] if t_desk else ot_desk)
ok('live takes the 09:30-open entry', first is not None, d_live)
ok('...deciding on the 09:29 PRE-MARKET bar',
   first is not None and et_of(pre, first['si']) == '09:29',
   first and et_of(pre, first['si']))
# The premarket bars BEFORE 09:29 are dropped by the session gate, which is
# correct — their fills would land premarket too. What must not happen is the
# 09:29 bar joining them, and the trade above is the proof that it did not.
ok('and the 09:29 decision itself survived the session gate',
   first is not None and et_of(pre, first['si']) == '09:29')
ok('desk agrees, on the same bar',
   firstd is not None and firstd['si'] == first['si'],
   (firstd and firstd['si'], first and first['si']))
ok('...and prices the stop from the same close',
   firstd is not None and abs(firstd['decided'] - first['decided']) < 1e-9,
   (firstd and firstd['decided'], first and first['decided']))

# The gate must still BITE. A 09:25 entry window is premarket at both ends and
# must be refused, or the fix has simply deleted the session rule.
t_pm, ot_pm, d_pm = evaluate(pre, 'live', 925, 925)
ok('a fill that would land PRE-MARKET is still refused',
   not t_pm and ot_pm is None, (len(t_pm), ot_pm))
ok('...and counted as a session drop', d_pm.get('rth_session', 0) >= 1, d_pm)


print()
print('== B. a WATCH window loses no bar at either end ==')
# `Test` is 09:30-11:30. Shifting the window must move BOTH ends together: a
# shift applied to one end only silently trims the strategy by a bar at the
# other.
#
# Each end is checked with its own one-minute window, because the entry engine
# takes ONE trade per contiguous true-run and an always-true mask is a single
# run — a range window would only ever show its first bar.
watch = frame('09:29', 40)                     # 09:29 .. 10:08


def decided_at(bars, fill, ws, we):
    t, ot, _d = evaluate(bars, fill, ws, we)
    hit = (t[0] if t else ot)
    return et_of(bars, hit['si']) if hit is not None else None


ok('the window OPEN shifts: a 09:30 entry decides on 09:29',
   decided_at(watch, 'live', 930, 930) == '09:29',
   decided_at(watch, 'live', 930, 930))
ok('the window SHUT shifts too: a 10:00 entry decides on 09:59',
   decided_at(watch, 'live', 1000, 1000) == '09:59',
   decided_at(watch, 'live', 1000, 1000))

# And across the whole range, nothing may decide ON the closing minute — that
# fill would land at 10:01, outside the window the strategy declared.
t_w, ot_w, _ = evaluate(watch, 'live', 930, 1000)
firing = [t['si'] for t in t_w] + ([ot_w['si']] if ot_w else [])
ok('a range window fires inside itself', bool(firing), firing)
ok('...and never decides on the closing minute',
   all(et_of(watch, i) != '10:00' for i in firing),
   [et_of(watch, i) for i in firing])

# The same window under 'close' decides ON its ends. Both readings are
# coherent; what must never happen is the two being used on the two sides at
# once, which is exactly what was happening.
ok("'close' decides ON the open minute instead",
   decided_at(watch, 'close', 930, 930) == '09:30',
   decided_at(watch, 'close', 930, 930))
ok("...and ON the closing minute",
   decided_at(watch, 'close', 1000, 1000) == '10:00',
   decided_at(watch, 'close', 1000, 1000))


print()
print('== C. the shift is one BAR, not one minute ==')
# PM Breakout is a 2-minute strategy. A hardcoded one-minute shift would look
# for a 09:59 bar that does not exist on a 2m frame and fire nothing.
two = frame('09:30', 20, freq='2min')          # 09:30, 09:32, ... 10:08
t2, ot2, d2 = evaluate(two, 'live', 1000, 1000)
f2 = (t2[0] if t2 else ot2)
ok('a 2m setup entering at 10:00 decides on the 09:58 bar',
   f2 is not None and et_of(two, f2['si']) == '09:58',
   (f2 and et_of(two, f2['si']), d2))
t2d, ot2d, _ = evaluate(two, 'desk', 1000, 1000)
f2d = (t2d[0] if t2d else ot2d)
ok('...which is the bar desk decides on too',
   f2d is not None and f2d['si'] == f2['si'],
   (f2d and f2d['si'], f2 and f2['si']))


print()
print('== D. the liquidation cutoff is a question about the FILL ==')
# entry_cutoff defaults to 15:50. A signal on the 15:49 bar would fill at
# 15:50 — inside liquidation — and must not open. Read against the signal bar
# it looks fine, which is how a position gets opened into the flattener.
eod = frame('15:44', 12)                       # 15:44 .. 15:55
t_e, ot_e, d_e = evaluate(eod, 'live', 1550, 1550)
ok('a fill landing ON the cutoff is refused',
   not t_e and ot_e is None, (len(t_e), ot_e))
ok('...and counted', (d_e.get('rth_session', 0) + d_e.get('eod_bar', 0)) >= 1, d_e)

# And the last genuinely tradeable minute still trades: 15:48 decides, 15:49
# fills, both inside the session.
t_ok, ot_ok, d_ok = evaluate(eod, 'live', 1549, 1549)
f_ok = (t_ok[0] if t_ok else ot_ok)
ok('the last minute before the cutoff still trades',
   f_ok is not None and et_of(eod, f_ok['si']) == '15:48',
   (f_ok and et_of(eod, f_ok['si']), d_ok))


print()
print('== E. live == desk on every one of these shapes ==')
# The universal property, swept rather than asserted once. If any shape breaks
# it, the desk is running a strategy its backtest did not measure.
SHAPES = [
    ('clock 09:35, 1m', frame('09:30', 20), 935, 935, '1m'),
    ('clock 10:00, 1m', frame('09:50', 20), 1000, 1000, '1m'),
    ('watch 09:30-10:00', frame('09:29', 40), 930, 1000, '1m'),
    ('watch 09:40-10:10', frame('09:35', 45), 940, 1010, '1m'),
    ('clock 10:00, 2m', frame('09:30', 20, freq='2min'), 1000, 1000, '2m'),
]
for label, bars, ws, we, _tf in SHAPES:
    tl, otl, _ = evaluate(bars, 'live', ws, we)
    td, otd, _ = evaluate(bars, 'desk', ws, we)
    sig_l = [t['si'] for t in tl] + ([otl['si']] if otl else [])
    sig_d = [t['si'] for t in td] + ([otd['si']] if otd else [])
    ok(f'{label}: same decision bar(s)', sig_l == sig_d, (sig_l, sig_d))
    px_l = [t['decided'] for t in tl] + ([otl['decided']] if otl else [])
    px_d = [t['decided'] for t in td] + ([otd['decided']] if otd else [])
    ok(f'{label}: same price the levels came from', px_l == px_d, (px_l, px_d))
    stop_l = [t['stop'] for t in tl] + ([otl['stop']] if otl else [])
    stop_d = [t['stop'] for t in td] + ([otd['stop']] if otd else [])
    ok(f'{label}: same stop', stop_l == stop_d, (stop_l, stop_d))


print()
print(f'        {PASS} passed, {FAIL} failed')
sys.exit(1 if FAIL else 0)
