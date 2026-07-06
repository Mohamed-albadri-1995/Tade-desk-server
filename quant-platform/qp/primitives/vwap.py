"""
VWAP primitives.

Seed: `session` — session-anchored VWAP that resets at 09:30 ET each day
and only computes during RTH (09:30–16:00 ET). Matches TradingView's
built-in `VWAP@tv-basicstudies` on stocks. Price = HLC/3, weighted by
volume. Non-RTH bars stay NaN.
"""

from __future__ import annotations

import numpy as np

from qp.registry import primitive
from qp.primitives.bars import Bars


@primitive(
    name='session',
    group='vwap',
    description=('Session-anchored VWAP for US equities. Resets at 09:30 '
                 'America/New_York, computes only during RTH (09:30–16:00 '
                 'ET), source = HLC/3. Matches TradingView built-in VWAP.'),
    params=(),
    inputs=('bars',),
)
def session(bars: Bars):
    """Return a numpy array the same length as bars — NaN outside RTH,
    running VWAP within each RTH session."""
    df = bars.df
    et = df.index.tz_convert('America/New_York')
    high   = df['high'].to_numpy(dtype=float)
    low    = df['low'].to_numpy(dtype=float)
    close  = df['close'].to_numpy(dtype=float)
    volume = df['volume'].to_numpy(dtype=float)
    price  = (high + low + close) / 3.0

    out = np.full(len(df), np.nan)
    cum_pv = 0.0
    cum_v  = 0.0
    last_date = None
    for i in range(len(df)):
        ts = et[i]
        # RTH gate: 09:30 <= t < 16:00
        rth = ((ts.hour > 9 or (ts.hour == 9 and ts.minute >= 30))
               and ts.hour < 16)
        if not rth:
            continue
        if ts.date() != last_date:
            cum_pv = 0.0
            cum_v  = 0.0
            last_date = ts.date()
        cum_pv += price[i] * volume[i]
        cum_v  += volume[i]
        if cum_v > 0:
            out[i] = cum_pv / cum_v
    return out
