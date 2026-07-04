"""
Pivot-anchored VWAPs — re-anchor at each confirmed swing high / low.

Pine parity for Script 1's Swing Pivot HH/LL VWAP: when
`ta.pivotlow(low, prd, prd)` confirms at the current bar, the pivot
low actually printed `prd` bars ago. The VWAP re-anchors at that
historical bar and accumulates forward from there, retroactively
covering the `prd` bars between the pivot and its confirmation.

Because a pivot is only confirmed `right` bars after it prints, the
swing VWAP has an unavoidable `right`-bar lag between "pivot happened"
and "line appears on chart". This matches Pine's behavior.
"""

from __future__ import annotations

import numpy as np
import pandas as pd

from qp.price import hlc3
from qp.structure.pivots import pivot_highs, pivot_lows


def _pivot_anchored(bars: pd.DataFrame,
                    side: str,
                    lookback: int) -> np.ndarray:
    p = np.asarray(hlc3(bars), dtype=float)
    v = bars['volume'].to_numpy(dtype=float)

    if side == 'high':
        pivots = pivot_highs(bars, left=lookback, right=lookback)
    else:
        pivots = pivot_lows(bars, left=lookback, right=lookback)

    n = len(bars)
    out = np.full(n, np.nan, dtype=float)
    anchor = -1
    cum_pv = 0.0
    cum_v  = 0.0

    for i in range(n):
        # A pivot at index (i - lookback) is confirmed on bar i.
        pivot_bar = i - lookback
        if pivot_bar >= 0 and np.isfinite(pivots[pivot_bar]):
            anchor = pivot_bar
            cum_pv = 0.0
            cum_v  = 0.0
            for j in range(anchor, i + 1):
                if np.isfinite(p[j]) and np.isfinite(v[j]):
                    cum_pv += p[j] * v[j]
                    cum_v  += v[j]
        elif anchor >= 0:
            if np.isfinite(p[i]) and np.isfinite(v[i]):
                cum_pv += p[i] * v[i]
                cum_v  += v[i]
        if anchor >= 0 and cum_v > 0:
            out[i] = cum_pv / cum_v
    return out


def pivot_ll_vwap(bars: pd.DataFrame, lookback: int = 25) -> np.ndarray:
    """VWAP anchored at each confirmed swing LOW (pivotlow(low, N, N))."""
    return _pivot_anchored(bars, 'low', lookback)


def pivot_hh_vwap(bars: pd.DataFrame, lookback: int = 25) -> np.ndarray:
    """VWAP anchored at each confirmed swing HIGH (pivothigh(high, N, N))."""
    return _pivot_anchored(bars, 'high', lookback)
