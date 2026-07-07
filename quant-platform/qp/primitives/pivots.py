"""
Floor pivots (classic day-trader levels).

- `floor`: returns {P, R1, R2, R3, S1, S2, S3} from yesterday's H/L/C.
  Constant across today's bars; NaN until a prior session exists.

`session` picks which bars define yesterday's range:
  'rth' (default) — 09:30-16:00 ET only. Matches the pivots you see on a
        TradingView equities chart, whose daily bars exclude extended
        hours.
  'eth' — every bar of the ET calendar date (premarket + RTH + AH).
        This is the pasted Pine's "Full Day Daily Pivots (ETH)" intent
        (written for 24h futures sessions). Needs extended-hours bars in
        the feed.

Formulas (standard floor pivots):
    P  = (H + L + C) / 3
    R1 = 2P - L        S1 = 2P - H
    R2 = P + (H - L)   S2 = P - (H - L)
    R3 = H + 2*(P - L) S3 = L - 2*(H - P)
"""

from __future__ import annotations

from qp.registry import primitive, Param
from qp.primitives.bars import Bars
from qp.primitives.levels import _daily_agg
from qp.primitives._session import rth_pred


@primitive(
    name='floor',
    group='pivots',
    description=('Floor pivots {P, R1, R2, R3, S1, S2, S3} from yesterday\'s '
                 'H/L/C. session=\'rth\' (default, matches TV equities daily '
                 'bars) or \'eth\' (full extended day — the Pine script\'s '
                 'ETH pivots).'),
    params=(Param('session', 'str', default='rth',
                  description="'rth' or 'eth'"),),
    inputs=('bars',),
    outputs=('P', 'R1', 'R2', 'R3', 'S1', 'S2', 'S3'),
)
def floor(bars: Bars, session: str = 'rth'):
    df = bars.df
    if session == 'eth':
        pred = lambda ts: True  # noqa: E731 — every bar of the ET date
    elif session == 'rth':
        pred = rth_pred(df)
    else:
        raise ValueError(f"session must be 'rth' or 'eth', got {session!r}")

    high  = _daily_agg(df, pred, 'high',  ago=1)
    low   = _daily_agg(df, pred, 'low',   ago=1)
    close = _daily_agg(df, pred, 'close', ago=1)

    P  = (high + low + close) / 3.0
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
