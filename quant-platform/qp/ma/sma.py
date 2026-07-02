"""
SMA — Simple Moving Average.

Definition (TradingView ta.sma parity):
    sma[i] = mean(x[i-length+1 .. i])
    NaN where i < length - 1

This is a thin façade over rolling_mean — the whole point of stage 5
is that "SMA is the rolling mean of close" is a NAMED concept, not a
private one-off.
"""

from __future__ import annotations

import numpy as np

from qp.math_foundation import rolling_mean


def sma(x, length: int) -> np.ndarray:
    """Simple moving average of `x` over `length` samples."""
    return rolling_mean(x, length)
