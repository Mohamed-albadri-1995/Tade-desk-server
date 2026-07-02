"""
VWMA — Volume-Weighted Moving Average.

Definition (TradingView ta.vwma parity):
    vwma[i] = sum(price[i-length+1 .. i] * volume[i-length+1 .. i])
              / sum(volume[i-length+1 .. i])

Unlike SMA/EMA/WMA, VWMA takes two series (price + volume) — bars with
higher volume have more influence on the average. Volatility spikes on
low volume get diluted; big prints anchor the line.
"""

from __future__ import annotations

import numpy as np


def vwma(price, volume, length: int) -> np.ndarray:
    if not isinstance(length, int) or length < 1:
        raise ValueError(f'length must be a positive integer, got {length!r}')
    p = np.asarray(price, dtype=float)
    v = np.asarray(volume, dtype=float)
    if p.shape != v.shape:
        raise ValueError(f'price and volume must have identical shape, got {p.shape} vs {v.shape}')
    n = p.size
    out = np.full(n, np.nan, dtype=float)
    if n < length:
        return out
    pv = p * v
    for i in range(length - 1, n):
        vol_sum = v[i - length + 1: i + 1].sum()
        if vol_sum == 0:
            continue    # leave NaN — no volume in the window, VWMA undefined
        out[i] = pv[i - length + 1: i + 1].sum() / vol_sum
    return out
