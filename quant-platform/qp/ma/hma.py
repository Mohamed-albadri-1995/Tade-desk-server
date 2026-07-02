"""
HMA — Hull Moving Average.

Definition (Alan Hull's original, matches TradingView ta.hma):
    half = round(length / 2)
    sqrt = round(sqrt(length))
    raw  = 2 * WMA(x, half) - WMA(x, length)
    hma  = WMA(raw, sqrt)

Aggressively reduces lag by taking the difference of a fast and a slow
WMA, then re-smoothing the noisy result. Turns much faster than a
same-length SMA/EMA while still filtering high-frequency wiggles.
"""

from __future__ import annotations

import math

import numpy as np

from qp.ma.wma import wma


def hma(x, length: int) -> np.ndarray:
    if not isinstance(length, int) or length < 2:
        raise ValueError(f'length must be an integer ≥ 2 for HMA (need half + sqrt), got {length!r}')
    half = int(round(length / 2))
    root = int(round(math.sqrt(length)))
    if half < 1 or root < 1:
        raise ValueError(f'length {length!r} too small for HMA (half={half}, root={root})')
    raw = 2.0 * wma(x, half) - wma(x, length)
    return wma(raw, root)
