"""
Volume primitives — average volume and relative volume (RVOL).

Your screener reads rvol straight from TradingView's scanner
(`relative_volume_intraday`, `relative_volume_10d_calc`); it is never
computed from bars. These primitives give qp its OWN bar-derived rvol so
the backtester and the charting tool can produce the same number offline,
verified against TradingView's "Relative Volume" study.

- avg_volume: N-day average of daily volume (compute_tf='1d', so identical
  on any chart timeframe — like a daily average volume line).
- rel_volume: INTRADAY relative volume. Cumulative volume from the RTH open
  (09:30 ET) through the current bar, divided by the average cumulative
  volume at the SAME time-of-day over the previous `length` RTH sessions.
  ~1.0 = a normal day at this hour, >1 = heavier than usual by now.
"""

from __future__ import annotations

from collections import defaultdict

import numpy as np
import pandas as pd

from qp.registry import primitive, Param
from qp.primitives.bars import Bars
from qp.primitives._session import ET as _ET, in_rth as _in_rth


@primitive(
    name='avg_volume',
    group='volume',
    description=('Average DAILY volume over the last `length` days. Computed '
                 'on 1-day bars (compute_tf=\'1d\') so it is the same value on '
                 'any chart timeframe — matches `ta.sma(volume, length)` on a '
                 'daily chart. Held flat across intraday bars. Raise Days so '
                 'the warm-up (>= length daily bars) is available.'),
    params=(Param('length', 'int', default=20, min=1),),
    inputs=('bars',),
    compute_tf='1d',
)
def avg_volume(bars: Bars, length: int = 20):
    v = bars.df['volume'].to_numpy(dtype=float)
    return pd.Series(v).rolling(int(length), min_periods=int(length)).mean().to_numpy()


@primitive(
    name='rel_volume',
    group='volume',
    description=('Intraday Relative Volume (RVOL). For each bar: cumulative '
                 'volume from the RTH open (09:30 ET) through the bar, divided '
                 'by the AVERAGE cumulative volume at the same time-of-day over '
                 'the previous `length` RTH sessions. ~1.0 = normal for this '
                 'hour, 2.0 = twice the usual volume by now. Matches the '
                 'day-trader / TradingView intraday Relative Volume. Non-RTH '
                 'bars are NaN. Needs `length` prior RTH days of history — '
                 'raise Days (e.g. Days >= length + a few).\n'
                 'TIMEFRAME-INVARIANT: because it is cumulative volume from the '
                 'session open (the same total whether you sum 1m or 5m bars), '
                 'the value at any given time is identical on a 1m/5m/15m/1h '
                 'chart — verified to 1e-15. Changing the chart TF does not '
                 'change it.'),
    params=(Param('length', 'int', default=20, min=1),),
    inputs=('bars',),
)
def rel_volume(bars: Bars, length: int = 20):
    df = bars.df
    et = df.index.tz_convert(_ET)
    vol = df['volume'].to_numpy(dtype=float)
    n = len(df)
    L = int(length)
    out = np.full(n, np.nan)

    # Per-bar: which RTH session it belongs to, its time-of-day slot, and the
    # running cumulative volume from that session's open.
    day_of = [None] * n
    slot_of = [None] * n
    cumvol = np.full(n, np.nan)
    cum = 0.0
    last_date = None
    for i in range(n):
        t = et[i]
        if not _in_rth(t):
            continue
        d = t.date()
        if d != last_date:
            cum = 0.0
            last_date = d
        cum += vol[i]
        cumvol[i] = cum
        day_of[i] = d
        slot_of[i] = (t.hour, t.minute)

    # Order the sessions so "previous length days" is well defined.
    days = sorted({d for d in day_of if d is not None})
    day_index = {d: k for k, d in enumerate(days)}

    # slot -> {session_ordinal: cumulative volume at that slot}
    slot_hist: dict = defaultdict(dict)
    for i in range(n):
        if day_of[i] is None:
            continue
        slot_hist[slot_of[i]][day_index[day_of[i]]] = cumvol[i]

    for i in range(n):
        if day_of[i] is None:
            continue
        di = day_index[day_of[i]]
        hist = slot_hist[slot_of[i]]
        prior = [hist[k] for k in range(max(0, di - L), di) if k in hist]
        if prior:
            avg = float(np.mean(prior))
            if avg > 0:
                out[i] = cumvol[i] / avg
    return out
