"""
Average True Range — smoothed True Range.

Three smoothings supported. TradingView defaults to RMA (`ta.atr`).
    - 'rma' (default, Wilder's smoothing) — TradingView `ta.atr`.
    - 'ema' — some platforms' default.
    - 'sma' — occasionally requested for backtests.

`length` is the smoothing period. First `length - 1` bars are NaN
(the smoother needs `length` samples before it fires).
"""

from __future__ import annotations

import numpy as np
import pandas as pd

from qp.ma import rma, ema, sma
from qp.volatility.true_range import true_range


_SMOOTHERS = {
    'rma': rma,
    'ema': ema,
    'sma': sma,
}


def atr(bars: pd.DataFrame, length: int, method: str = 'rma') -> np.ndarray:
    """Average True Range over `length` bars, smoothed by `method`."""
    if method not in _SMOOTHERS:
        raise ValueError(f'unknown ATR smoothing {method!r}; '
                         f'expected one of {sorted(_SMOOTHERS)}')
    tr = true_range(bars)
    return _SMOOTHERS[method](tr, length)
