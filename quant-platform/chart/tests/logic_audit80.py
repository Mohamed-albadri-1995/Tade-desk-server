"""The backtest and the live manager, asked the same question bar by bar.

Reported as: "some strategies like Test and 935 are different on backtesting
and live — and even in backtesting they state something but what really
backtested is different, like the 2 legs problem in 935."

It was different, and the reason was specific. OR + VWAP 09:35 takes half off
at 2R and lets the other half leave on a VWAP cross — `exit.scope: 'runner'`.
The backtest arms that rule only once the 2R leg has banked. The live manager
never read `scope`: it closed the whole position on the first cross, before
2R, on trades the backtest was still holding. So the strategy that was tested
and the strategy that traded had the same name, the same entry and a different
exit.

THIS FILE IS THE CONTRACT THAT STOPS IT HAPPENING AGAIN. For each shape of
exit the desk trades, it runs the real backtest — `evaluate()`, the function
the backtester consumes — over a series of bars, then replays the same bars to
the live manager one at a time, exactly as the desk would ask it once a
minute. The manager must say "close" on the bar the backtest exited, for the
same reason, and on no bar before it.

A test like this compares two answers to one question. When they disagree,
one of them is wrong about money.
"""
import pathlib
import sys

import numpy as np
import pandas as pd

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2]))
import chart.manage as M                                            # noqa: E402
import chart.strategy as S                                          # noqa: E402
import tools.compare_server as cs                                   # noqa: E402

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


def frame(cl, hi=None, lo=None, start='2024-01-09 10:00'):
    cl = np.array(cl, float)
    n = len(cl)
    hi = np.array(hi, float) if hi is not None else cl + 0.05
    lo = np.array(lo, float) if lo is not None else cl - 0.05
    idx = pd.DatetimeIndex(
        [pd.Timestamp(start, tz='America/New_York') + pd.Timedelta(minutes=i)
         for i in range(n)]).tz_convert('UTC')
    return pd.DataFrame({'open': np.r_[cl[0], cl[:-1]], 'high': hi, 'low': lo,
                         'close': cl, 'volume': np.full(n, 1e5)}, index=idx)


def serve(df):
    """Both sides read bars through cs.prepare_bars; serve them this frame."""
    end = df.index[-1]
    # Epoch seconds, as the real loader returns them — evaluate() writes them
    # straight into chart markers.
    ts = [int(x.value // 10**9) for x in df.index]
    cs.prepare_bars = lambda *a, **k: (df, ts, {'end': end})


# Enters on the bar that crosses above 10.50 — b3 in every series below — so
# the backtest's entry is a fact the test can state rather than discover.
ENTRY = {'logic': 'AND', 'rules': [
    {'left': {'kind': 'price', 'field': 'close'}, 'op': 'cross_above',
     'right': {'kind': 'const', 'value': 10.5}}]}

# "close crosses back under the 3-bar SMA" — the VWAP cross, in arithmetic
# anyone can check by hand.
CROSS = {'logic': 'AND', 'rules': [
    {'left': {'kind': 'price', 'field': 'close'}, 'op': 'cross_below',
     'right': {'kind': 'primitive', 'key': 'ma.sma', 'params': {'length': 3},
               'source': 'close'}}]}

SMA3 = {'type': 'prim', 'anchor': {'kind': 'primitive', 'key': 'ma.sma',
                                   'params': {'length': 3}, 'source': 'close'},
        'value': 0.0}

FILL = 'live'          # what the desk runs — catalog.js defaults to it


def _ask(strategy, t, entry_iso):
    """The manager, asked as the desk asks it."""
    kw = dict(entry=t['decided'], entry_iso=entry_iso, stop_at_entry=t['stop'])
    try:
        return M.manage(strategy, 'X', 'long', fill=FILL, **kw)
    except TypeError:
        # An older manager with no fill parameter. Asked anyway, so a
        # regression shows up as named failures rather than a crash.
        return M.manage(strategy, 'X', 'long', **kw)


def _would_close(r):
    """Would the DESK close this position on this answer?

    `close_now` is the contract. Before it existed, src/setups/manager.js
    closed on `exit_now`, or on `breached` for a stop that follows a line — so
    that is what "the desk closed it" meant, and what is compared.
    """
    if 'close_now' in r:
        return bool(r['close_now']), r.get('close_reason')
    if r.get('exit_now'):
        return True, 'exit'
    if r.get('breached') and r.get('stop_kind') == 'anchored':
        return True, 'trail'
    return False, None


def parity(label, strategy, df, want_reason, want_bar):
    """Backtest the frame, then replay it to the manager a bar at a time."""
    serve(df)
    bt = S.evaluate(strategy, 'X', '1m', 1, feed='yahoo', view='all', fill=FILL)
    trades = bt.get('trades') or []
    ok(f'{label}: the backtest took exactly one trade', len(trades) == 1,
       f'{len(trades)} trades · {bt.get("error")}')
    if len(trades) != 1:
        return
    t = trades[0]
    idx = [int(x.value // 10**9) for x in df.index]
    ei = idx.index(t['signal_ts'])
    xi = idx.index(t['exit_ts'])
    ok(f'{label}: the backtest entered on b3', ei == 3, ei)
    ok(f'{label}: the backtest left by {want_reason} on b{want_bar}',
       t['reason'] == want_reason and xi == want_bar, (t['reason'], xi))

    entry_iso = df.index[ei].tz_convert('America/New_York').strftime('%Y-%m-%d %H:%M')
    first = None
    early = []
    for k in range(ei, len(df)):
        serve(df.iloc[:k + 1])
        r = _ask(strategy, t, entry_iso)
        if not r.get('ok'):
            ok(f'{label}: the manager answered on b{k}', False, r.get('error'))
            return
        closes, why = _would_close(r)
        if closes:
            first = (k, why)
            break
        # A manager asked on a bar where the backtest is still in the trade
        # must not close it. That is the entire bug: closing early.
        early.append(k)

    ok(f'{label}: the manager closes on the SAME bar as the backtest',
       first is not None and first[0] == want_bar, first)
    ok(f'{label}: ...for the same reason',
       first is not None and first[1] == want_reason, first)
    ok(f'{label}: ...and on no bar before it',
       early == list(range(ei, want_bar)), early)


# ── 1 · THE 09:35 SHAPE, THE PATH THAT WORKS ─────────────────────────────────
#
# Half off at 2R, the runner leaves on the cross. Stop 0.6% under entry.
#   entry b3 10.60 · stop 10.5364 · 1R 0.0636 · 2R 10.727
#   b4 high 10.85 → the 2R leg banks
#   b6 closes 10.60 under SMA3 10.767 → the rule, now armed, takes the runner
print('\n── 1 · half at 2R, then the runner leaves on the cross ────────────')
HALF = {'name': 'half', 'side': 'long', 'entry': ENTRY,
        'exit': dict(CROSS, scope='runner'),
        'risk': {'sl': {'type': 'pct', 'value': 0.6},
                 'targets': [{'fraction': 0.5, 'r_multiple': 2.0}]}}
parity('09:35 good path', HALF,
       frame([10.0, 10.2, 10.4, 10.60, 10.80, 10.90, 10.60, 10.55, 10.50]),
       'exit', 6)


# ── 2 · THE 09:35 SHAPE, THE PATH THAT WAS WRONG ─────────────────────────────
#
# Price never reaches 2R. It crosses under the SMA on b6 — and the rule is NOT
# armed, because no leg has banked. The backtest holds, and the stop takes it
# on b7.
#   stop 10.5364 · 2R 10.727
#   highs stay ≤ 10.69, never reaching 2R
#   b6 closes 10.58 under SMA3 10.613 — the cross — with its low at 10.56,
#      ABOVE the stop, so nothing but the rule could close it on this bar
#   b7 low 10.45 goes through the stop
#
# The lows are set by hand. With the frame's default (close − 0.05) b6's low is
# 10.53, which touches the stop on the cross bar itself and turns this into a
# test of which the backtest checks first — a different question, asked in
# logic_audit38. This one is about HOLDING through the cross.
#
# THE OLD MANAGER CLOSED THIS ON b6. The backtest closed it on b7, by its stop.
print('\n── 2 · a cross before 2R: the backtest holds, the stop takes it ─')
cl2 = [10.0, 10.2, 10.4, 10.60, 10.62, 10.64, 10.58, 10.50, 10.45]
lo2 = [9.95, 10.15, 10.35, 10.55, 10.60, 10.62, 10.56, 10.45, 10.40]
parity('09:35 cross before 2R', HALF, frame(cl2, lo=lo2), 'SL', 7)


# ── 3 · THE Test SHAPE ───────────────────────────────────────────────────────
#
# A stop that follows a line and ratchets, two target legs, a runner, and no
# exit rule at all.
#   entry b3 10.60 · stop SMA3 at entry 10.40 · 1R 0.20 · 3R 11.20 · 6R 11.80
#   b6 high 11.25 → the 10% leg banks
#   the stop ratchets up with SMA3: 10.60, 10.80, 11.00, 11.067
#   b7 low 10.95 goes through 11.067 → stopped
#
# 'trail', not 'SL': the engine names a stop that follows a line by what it
# is. The manager must say the same word, because it is the same engine.
print('\n── 3 · a trailing stop that ratchets, two legs, a runner ─────────')
TEST = {'name': 'test', 'side': 'long', 'entry': ENTRY,
        'risk': {'sl': SMA3,
                 'targets': [{'fraction': 0.1, 'r_multiple': 3},
                             {'fraction': 0.8, 'r_multiple': 6}]}}
parity('Test shape', TEST,
       frame([10.0, 10.2, 10.4, 10.60, 10.80, 11.00, 11.20, 11.00, 10.70, 10.50]),
       'trail', 7)


# ── 4 · A PLAIN RULE, NO SCOPE ───────────────────────────────────────────────
#
# The rule governs the whole position from the first bar after entry.
print('\n── 4 · a rule with no scope, a stop far away ─────────────────────')
PLAIN = {'name': 'plain', 'side': 'long', 'entry': ENTRY, 'exit': CROSS,
         'risk': {'sl': {'type': 'pct', 'value': 20}}}
parity('plain rule', PLAIN,
       frame([10.0, 10.2, 10.4, 10.60, 10.80, 11.00, 10.20, 10.10]),
       'exit', 6)


print(f'\n{PASS} passed, {FAIL} failed')
sys.exit(1 if FAIL else 0)
