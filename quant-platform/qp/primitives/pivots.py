"""
Floor pivots (classic day-trader levels).

- `floor`: returns {P, R1, R2, R3, S1, S2, S3}, computed from yesterday's
  RTH high/low/close. Constant across today's RTH bars, NaN before enough
  history exists.

Formulas (Pine's standard):
    P  = (H + L + C) / 3
    R1 = 2P - L
    S1 = 2P - H
    R2 = P + (H - L)
    S2 = P - (H - L)
    R3 = H + 2*(P - L)
    S3 = L - 2*(H - P)
"""

from __future__ import annotations

import numpy as np

from qp.registry import primitive
from qp.primitives.bars import Bars
from qp.primitives.levels import _daily_agg, _in_rth


@primitive(
    name='floor',
    group='pivots',
    description=('Floor pivots {P, R1, R2, R3, S1, S2, S3} from yesterday\'s '
                 'RTH H/L/C. Constant across today\'s bars.'),
    params=(),
    inputs=('bars',),
)
def floor(bars: Bars):
    df = bars.df
    high  = _daily_agg(df, _in_rth, 'high',  ago=1)
    low   = _daily_agg(df, _in_rth, 'low',   ago=1)
    # Yesterday's close — grab the last RTH close from yesterday.
    # Reuse the daily aggregator by treating close as an "open" trick: we
    # need the LAST value, not the first. Doing it directly here:
    et = df.index.tz_convert('America/New_York')
    close_arr = df['close'].to_numpy(dtype=float)
    dates = et.date
    per_day: dict = {}
    order: list = []
    for i in range(len(df)):
        if not _in_rth(et[i]):
            continue
        d = dates[i]
        if d not in per_day:
            per_day[d] = close_arr[i]
            order.append(d)
        else:
            per_day[d] = close_arr[i]  # keep overwriting → ends at last RTH close
    day_pos = {d: k for k, d in enumerate(order)}
    close_prev = np.full(len(df), np.nan)
    for i in range(len(df)):
        d = dates[i]
        if d not in day_pos:
            continue
        pos = day_pos[d] - 1
        if pos < 0:
            continue
        close_prev[i] = per_day[order[pos]]

    P  = (high + low + close_prev) / 3.0
    R1 = 2.0 * P - low
    S1 = 2.0 * P - high
    R2 = P + (high - low)
    S2 = P - (high - low)
    R3 = high + 2.0 * (P - low)
    S3 = low  - 2.0 * (high - P)
    return {
        'P':  P,
        'R1': R1, 'R2': R2, 'R3': R3,
        'S1': S1, 'S2': S2, 'S3': S3,
    }
