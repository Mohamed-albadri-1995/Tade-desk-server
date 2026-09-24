"""A stop the price has already passed is refused — in the backtest too.

2026-09-24, OR + VWAP 09:35: MAZE short, stop 28.04. By the time the order
reached Alpaca the price was above the stop, and Alpaca refused the bracket:
"stop_loss.stop_price must be >= base_price + 0.01". No position, no loss.

The engine used to fill that entry at the next open anyway and stop it out on
the same bar — a loss live can never take. This file runs the REAL engine
(`strategy._pair_trades`) on bars built so the fill lands on, through, or just
clear of the stop, for long and short, and checks:

  1. 'desk' and 'next_open' drop an entry whose fill is within one cent of,
     or through, its own stop, and count it as `stop_through_fill`;
  2. two cents of room is a trade, exactly as Alpaca would take it;
  3. 'close' fills at the decision price, where the stop was measured to be
     on the right side — nothing changes there.

On the engine before this change, every "dropped" check below fails.
"""
import pathlib
import sys

import numpy as np
import pandas as pd

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2]))
import chart.strategy as S                                          # noqa: E402

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


def bars(o, c):
    n = len(c)
    idx = pd.date_range('2026-09-24 09:34', periods=n, freq='1min',
                        tz='America/New_York').tz_convert('UTC')
    o = np.array(o, float)
    c = np.array(c, float)
    return pd.DataFrame({'open': o, 'high': np.maximum(o, c) + 0.05,
                         'low': np.minimum(o, c) - 0.05, 'close': c,
                         'volume': np.full(n, 1000.0)}, index=idx)


def run(b, side, risk, fill):
    diag = {}
    n = len(b)
    ent = np.zeros(n, bool)
    ent[1] = True                     # decided on bar 1's close
    tr, _, _, _ = S._pair_trades(b, list(range(n)), ent, np.zeros(n, bool),
                                 side, risk, None, fill=fill, diag=diag)
    return tr, diag


PCT1 = {'sl': {'type': 'pct', 'value': 1}}
AT_OPEN = {'sl': {'type': 'prim', 'value': 0,
                  'anchor': {'kind': 'price', 'field': 'open'}}}

print('== 1. desk: fixed 1% stop measured from the decision close ==')
# long: close 100 -> stop 99.00. Fill = next open.
for fill_px, want, label in [(98.80, 0, 'gapped through the stop'),
                             (99.00, 0, 'opened on the stop'),
                             (99.005, 0, 'half a cent above the stop'),
                             (99.02, 1, 'two cents above the stop')]:
    tr, d = run(bars([100, 100, fill_px, 100, 100], [100, 100, 100, 100, 100]),
                'long', PCT1, 'desk')
    ok(f'long, {label} ({fill_px}) -> {want} trade', len(tr) == want, tr)
    if not want:
        ok(f'long, {label}: counted as stop_through_fill',
           d.get('stop_through_fill') == 1, d)
# short: close 100 -> stop 101.00 (MAZE's shape)
for fill_px, want, label in [(101.30, 0, 'gapped through the stop'),
                             (101.00, 0, 'opened on the stop'),
                             (100.98, 1, 'two cents below the stop')]:
    tr, d = run(bars([100, 100, fill_px, 100, 100], [100, 100, 100, 100, 100]),
                'short', PCT1, 'desk')
    ok(f'short, {label} ({fill_px}) -> {want} trade', len(tr) == want, tr)
    if not want:
        ok(f'short, {label}: counted as stop_through_fill',
           d.get('stop_through_fill') == 1, d)

print('== 2. next_open: a stop anchored to a line, not to the fill ==')
# stop = bar 1's open (99.00 long / 101.00 short); fill = bar 2's open
for side, fill_px, want in [('long', 98.90, 0), ('long', 99.02, 1),
                            ('short', 101.10, 0), ('short', 100.98, 1)]:
    first = 99.0 if side == 'long' else 101.0
    tr, d = run(bars([100, first, fill_px, 100, 100], [100, 100, 100, 100, 100]),
                side, AT_OPEN, 'next_open')
    ok(f'{side}, fill {fill_px} vs stop {first} -> {want} trade',
       len(tr) == want, (tr, d))
    if not want:
        ok(f'{side}, fill {fill_px}: counted as stop_through_fill',
           d.get('stop_through_fill') == 1, d)

print("== 3. 'close' fills at the decision price: unchanged ==")
tr, d = run(bars([100, 100, 98.80, 100, 100], [100, 100, 100, 100, 100]),
            'long', PCT1, 'close')
ok("long, 'close' still takes the trade", len(tr) == 1, tr)
ok("'close' counts nothing as stop_through_fill",
   'stop_through_fill' not in d, d)

print(f'PASS={PASS} FAIL={FAIL}')
sys.exit(1 if FAIL else 0)
