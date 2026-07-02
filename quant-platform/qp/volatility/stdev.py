"""
Rolling standard deviation — thin wrapper over `qp.math_foundation.rolling_std`
so downstream volatility work goes through the volatility module rather
than reaching into math_foundation. TradingView `ta.stdev` uses ddof=0
(population), which is the default here.
"""

from __future__ import annotations

import numpy as np

from qp.math_foundation import rolling_std


def stdev(x, length: int, ddof: int = 0) -> np.ndarray:
    """Rolling standard deviation. ddof=0 matches TradingView `ta.stdev`."""
    return rolling_std(x, length, ddof=ddof)
