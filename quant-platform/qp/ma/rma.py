"""
RMA — Rolling Moving Average (Wilder's smoothing).

Definition (TradingView ta.rma parity):
    alpha    = 1 / length
    rma[0]   = mean(x[0 .. length-1])          # seeded with SMA of the first `length` samples
    rma[i]   = alpha * x[i] + (1 - alpha) * rma[i-1]  for i ≥ length

Note the seed: unlike EMA (which seeds at x[0]), RMA waits for `length`
samples before producing its first value. Positions [0, length-2] are NaN.

This is Wilder's "smoothed moving average" — used inside RSI, ATR, and
several classic momentum indicators. It's slower than an EMA of the same
length because the smoothing coefficient is 1/N (not 2/(N+1)).
"""

from __future__ import annotations

import numpy as np
import pandas as pd


def rma(x, length: int) -> np.ndarray:
    if not isinstance(length, int) or length < 1:
        raise ValueError(f'length must be a positive integer, got {length!r}')
    a = np.asarray(x, dtype=float)
    n = a.size
    out = np.full(n, np.nan, dtype=float)
    if n < length:
        return out
    # Seed with SMA of the first `length` samples.
    seed = a[:length].mean()
    out[length - 1] = seed
    alpha = 1.0 / length
    for i in range(length, n):
        out[i] = alpha * a[i] + (1.0 - alpha) * out[i - 1]
    return out
