"""
Pivot / fractal detection — the foundation of every "swing high",
"HH/LL", "trend state" question.

A **pivot high** at index i requires `left` bars strictly lower on the
left AND `right` bars strictly lower on the right — a bar can only be
declared a pivot once `right` future bars have been observed, so
pivot_indices are naturally right-shifted. Matches TradingView
`ta.pivothigh(left, right)` semantics.

    pivot_high[i] == high[i]  iff  high[i] > max(high[i-left:i]) AND
                                   high[i] > max(high[i+1:i+1+right])
    pivot_low[i]  == low[i]   iff  low[i]  < min(low[i-left:i])  AND
                                   low[i]  < min(low[i+1:i+1+right])

Returns arrays of length == len(bars). Non-pivot bars are NaN.
"""

from __future__ import annotations

import numpy as np
import pandas as pd


def pivot_highs(bars: pd.DataFrame, left: int = 5, right: int = 5) -> np.ndarray:
    """Bar-aligned pivot high series. Length == len(bars). NaN when the
    bar is not a pivot high."""
    if left < 1 or right < 1:
        raise ValueError(f'left and right must be >= 1, got {left!r}, {right!r}')
    high = bars['high'].to_numpy(dtype=float)
    return _pivots(high, left, right, side='high')


def pivot_lows(bars: pd.DataFrame, left: int = 5, right: int = 5) -> np.ndarray:
    if left < 1 or right < 1:
        raise ValueError(f'left and right must be >= 1, got {left!r}, {right!r}')
    low = bars['low'].to_numpy(dtype=float)
    return _pivots(low, left, right, side='low')


def _pivots(x: np.ndarray, left: int, right: int, side: str) -> np.ndarray:
    n = x.size
    out = np.full(n, np.nan, dtype=float)
    for i in range(left, n - right):
        left_slice  = x[i - left:i]
        right_slice = x[i + 1:i + 1 + right]
        if side == 'high':
            if x[i] > left_slice.max() and x[i] > right_slice.max():
                out[i] = x[i]
        else:
            if x[i] < left_slice.min() and x[i] < right_slice.min():
                out[i] = x[i]
    return out
