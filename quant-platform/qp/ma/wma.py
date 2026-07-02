"""
WMA — Weighted Moving Average (linearly weighted).

Definition (TradingView ta.wma parity):
    weights[i] = i + 1                       # oldest sample gets weight 1, newest gets weight `length`
    wma[j] = sum(weights * x[j-length+1 .. j]) / sum(weights)
Positions [0, length-2] are NaN.

Linear weighting makes WMA more responsive than SMA but less noisy than
EMA — it doesn't overreact to a single outlier the way an EMA can.
"""

from __future__ import annotations

import numpy as np


def wma(x, length: int) -> np.ndarray:
    if not isinstance(length, int) or length < 1:
        raise ValueError(f'length must be a positive integer, got {length!r}')
    a = np.asarray(x, dtype=float)
    n = a.size
    out = np.full(n, np.nan, dtype=float)
    if n < length:
        return out
    weights = np.arange(1, length + 1, dtype=float)  # 1..length, oldest→newest
    denom = weights.sum()
    for i in range(length - 1, n):
        window = a[i - length + 1: i + 1]
        out[i] = np.dot(window, weights) / denom
    return out
