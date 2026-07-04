"""
Setup B — "Healthy Pullback L3" (Pine parity for Script 3, L3 section).

Long-only. On the current bar:
    - close > daily_vwap AND close > BB EMA basis
    - (strict) close > 2-day VWAP AND close > LL AVWAP
    - previous bar was a red rejection candle whose low kissed any of
      the three long VWAPs (within `vwap_touch_pct`) and closed inside
      the BB range
    - current bar is green and closes above the previous bar's high
"""

from __future__ import annotations

import numpy as np
import pandas as pd

from qp.vwap import session_vwap, n_day_vwap, today_ll_vwap
from qp.volatility import bollinger_ema


NAME        = 'Healthy Pullback L3'
DESCRIPTION = ('Prior bar rejects off Daily/2D/LL VWAP with a lower wick; '
               'current bar closes above the rejection high while price '
               'stays inside the BB EMA range and above all three VWAPs.')
SIDE        = 'long'


CHART_SPECS = [
    {'ind': 'vwap',              'length': 0,  'label': 'Daily VWAP'},
    {'ind': 'vwap_2d_anchored',  'length': 0,  'label': '2-Day Anchored VWAP'},
    {'ind': 'today_ll_vwap',     'length': 0,  'label': 'LL Anchored VWAP'},
    {'ind': 'bollinger_ema',     'length': 21, 'label': 'BB EMA (21)',
     'mult': 2.0},
]


def evaluate(bars: pd.DataFrame,
             bb_length: int = 21,
             bb_mult: float = 2.0,
             min_wick_pct: float = 15.0,
             vwap_touch_pct: float = 0.2,
             require_volume: bool = False,
             bias_strict: bool = True) -> np.ndarray:
    o = bars['open'].to_numpy(dtype=float)
    h = bars['high'].to_numpy(dtype=float)
    l = bars['low'].to_numpy(dtype=float)
    c = bars['close'].to_numpy(dtype=float)
    v = bars['volume'].to_numpy(dtype=float)

    dv  = np.asarray(session_vwap(bars))
    v2  = np.asarray(n_day_vwap(bars, 2))
    llv = np.asarray(today_ll_vwap(bars))
    bb  = bollinger_ema(c, length=bb_length, mult=bb_mult, zone_pct=25.0)

    n = len(bars)
    fired = np.zeros(n, dtype=bool)
    if n < 2:
        return fired

    bias_base = (c > dv) & (c > bb.basis)
    bias_full = bias_base & (c > v2) & (c > llv)
    bias      = bias_full if bias_strict else bias_base
    bias_c1   = np.concatenate(([False], bias[:-1]))

    rng_1 = h[:-1] - l[:-1]
    rng_1 = np.where(rng_1 > 0, rng_1, np.nan)
    body_bot_1 = np.minimum(o[:-1], c[:-1])
    lwick_1    = body_bot_1 - l[:-1]
    lwick_pct  = (lwick_1 / rng_1) * 100.0
    red_prev   = c[:-1] < o[:-1]
    below_bb_upper = h[:-1] < bb.upper[:-1]

    tol  = vwap_touch_pct / 100.0
    l_dv = (l[:-1] <= dv[:-1]  * (1 + tol)) & (l[:-1] >= dv[:-1]  * (1 - tol))
    l_v2 = (l[:-1] <= v2[:-1]  * (1 + tol)) & (l[:-1] >= v2[:-1]  * (1 - tol))
    l_av = (l[:-1] <= llv[:-1] * (1 + tol)) & (l[:-1] >= llv[:-1] * (1 - tol))
    any_touch = l_dv | l_v2 | l_av

    c1 = red_prev & (lwick_pct >= min_wick_pct) & any_touch & below_bb_upper

    green_now = c[1:] > o[1:]
    breakout  = c[1:] > h[:-1]
    vol_ok    = (v[1:] > v[:-1]) if require_volume else np.ones(n - 1, dtype=bool)
    c2 = green_now & breakout & vol_ok

    fired[1:] = bias_c1[1:] & bias[1:] & c1 & c2
    return fired
